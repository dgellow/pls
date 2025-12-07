/**
 * GitHub API backend for file operations via the Git Data API.
 */

import { PlsError } from '../types.ts';
import type { CommitBackend } from './interface.ts';

export interface GitHubBackendOptions {
  owner: string;
  repo: string;
  token: string;
  baseBranch: string;
  targetBranch?: string;
  /** If true, don't update branch ref on commit (caller will do it) */
  deferBranchUpdate?: boolean;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

export class GitHubBackend implements CommitBackend {
  private baseUrl = 'https://api.github.com';
  private pendingWrites: Map<string, string> = new Map();
  private baseSha: string | null = null;
  private baseTreeSha: string | null = null;
  private lastCommitSha: string | null = null;

  constructor(private options: GitHubBackendOptions) {
    if (!options.token) {
      throw new PlsError(
        'GitHub token required. Set GITHUB_TOKEN env var or use --token',
        'GITHUB_AUTH_ERROR',
      );
    }
  }

  get owner(): string {
    return this.options.owner;
  }

  get repo(): string {
    return this.options.repo;
  }

  get baseBranch(): string {
    return this.options.baseBranch;
  }

  get targetBranch(): string {
    return this.options.targetBranch || this.options.baseBranch;
  }

  get token(): string {
    return this.options.token;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${this.options.token}`,
        'User-Agent': 'pls-release-tool',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new PlsError(
        `GitHub API error: ${response.status} ${response.statusText}`,
        'GITHUB_API_ERROR',
        { status: response.status, error },
      );
    }

    return response.json();
  }

  async ensureBase(): Promise<void> {
    if (this.baseSha) return;

    const baseRef = await this.request<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.baseBranch}`,
    );
    this.baseSha = baseRef.object.sha;

    const baseCommit = await this.request<{ tree: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/commits/${this.baseSha}`,
    );
    this.baseTreeSha = baseCommit.tree.sha;
  }

  getBaseSha(): string | null {
    return this.baseSha;
  }

  getLastCommitSha(): string | null {
    return this.lastCommitSha;
  }

  async read(path: string): Promise<string | null> {
    if (this.pendingWrites.has(path)) {
      return this.pendingWrites.get(path)!;
    }

    try {
      const file = await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.baseBranch}`,
      );
      return atob(file.content.replace(/\n/g, ''));
    } catch {
      return null;
    }
  }

  write(path: string, content: string): Promise<void> {
    this.pendingWrites.set(path, content);
    return Promise.resolve();
  }

  async exists(path: string): Promise<boolean> {
    if (this.pendingWrites.has(path)) {
      return true;
    }

    try {
      await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.baseBranch}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  glob(_pattern: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * Create blobs for pending writes and commit them.
   * Returns commit SHA.
   */
  async commit(message: string): Promise<string> {
    await this.ensureBase();

    const treeEntries: TreeEntry[] = [];

    for (const [path, content] of this.pendingWrites) {
      const blob = await this.request<{ sha: string }>(
        `/repos/${this.owner}/${this.repo}/git/blobs`,
        {
          method: 'POST',
          body: JSON.stringify({ content, encoding: 'utf-8' }),
        },
      );
      treeEntries.push({
        path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    this.pendingWrites.clear();

    const tree = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: this.baseTreeSha,
          tree: treeEntries,
        }),
      },
    );

    const commit = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [this.baseSha],
        }),
      },
    );

    this.lastCommitSha = commit.sha;

    if (!this.options.deferBranchUpdate) {
      await this.updateBranchRef(commit.sha);
    }

    return commit.sha;
  }

  /**
   * Update target branch to point to the given commit SHA.
   */
  async updateBranchRef(sha: string, force = true): Promise<void> {
    try {
      await this.request(`/repos/${this.owner}/${this.repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${this.targetBranch}`,
          sha,
        }),
      });
    } catch {
      await this.request(
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.targetBranch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha, force }),
        },
      );
    }
  }
}
