/**
 * GitHub API client - all GitHub operations.
 *
 * Key design: branch is a PARAMETER, not configuration.
 */

import type { FileChanges, PullRequest, ReleaseTag } from '../domain/types.ts';
import { hasReleaseMetadata, parseReleaseMetadata } from '../domain/release-metadata.ts';
import type { CreatePROptions, GitHubClient, UpdatePROptions } from './types.ts';
import { PlsError } from '../lib/error.ts';

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
}

export class GitHub implements GitHubClient {
  private owner: string;
  private repo: string;
  private token: string;
  private baseUrl = 'https://api.github.com';

  constructor(options: GitHubClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;

    if (!this.token) {
      throw new PlsError(
        'GitHub token required. Set GITHUB_TOKEN env var or use --token',
        'GITHUB_AUTH_ERROR',
      );
    }
  }

  /**
   * Make a GitHub API request.
   */
  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new PlsError(
        `GitHub API error: ${response.status} ${response.statusText}\n${body}`,
        'GITHUB_API_ERROR',
        { status: response.status, body },
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  /**
   * Make request, returning null on 404 instead of throwing.
   */
  private async requestSafe<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T | null> {
    try {
      return await this.request<T>(path, options);
    } catch (error) {
      if (error instanceof PlsError && error.details?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- File Operations ---

  async readFile(path: string, ref?: string): Promise<string | null> {
    const query = ref ? `?ref=${ref}` : '';
    const result = await this.requestSafe<{ content: string }>(
      `/repos/${this.owner}/${this.repo}/contents/${path}${query}`,
    );

    if (!result) return null;

    // Decode base64 content
    return atob(result.content.replace(/\n/g, ''));
  }

  async fileExists(path: string, ref?: string): Promise<boolean> {
    const content = await this.readFile(path, ref);
    return content !== null;
  }

  // --- Atomic Commit ---

  async commit(
    files: FileChanges,
    message: string,
    parentSha: string,
  ): Promise<string> {
    // 1. Get parent tree
    const parentCommit = await this.request<{ tree: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/commits/${parentSha}`,
    );

    // 2. Create blobs for each file
    const treeItems: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string;
    }> = [];

    for (const [path, content] of files) {
      const blob = await this.request<{ sha: string }>(
        `/repos/${this.owner}/${this.repo}/git/blobs`,
        {
          method: 'POST',
          body: JSON.stringify({
            content,
            encoding: 'utf-8',
          }),
        },
      );

      treeItems.push({
        path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    // 3. Create tree
    const tree = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: parentCommit.tree.sha,
          tree: treeItems,
        }),
      },
    );

    // 4. Create commit
    const commit = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [parentSha],
        }),
      },
    );

    return commit.sha;
  }

  // --- Branch Operations ---

  async getBranchSha(branch: string): Promise<string | null> {
    const ref = await this.requestSafe<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${branch}`,
    );
    return ref?.object.sha ?? null;
  }

  async pointBranch(branch: string, sha: string, force = false): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha, force }),
      },
    );
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha,
        }),
      },
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    const sha = await this.getBranchSha(branch);
    return sha !== null;
  }

  /**
   * Ensure branch exists, creating or updating as needed.
   */
  async ensureBranch(branch: string, sha: string): Promise<void> {
    const exists = await this.branchExists(branch);
    if (exists) {
      await this.pointBranch(branch, sha, true);
    } else {
      await this.createBranch(branch, sha);
    }
  }

  // --- Tag Operations ---

  async createTag(name: string, sha: string, message: string): Promise<void> {
    // Create annotated tag object
    const tagObject = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/tags`,
      {
        method: 'POST',
        body: JSON.stringify({
          tag: name,
          message,
          object: sha,
          type: 'commit',
        }),
      },
    );

    // Create tag ref pointing to tag object
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/tags/${name}`,
          sha: tagObject.sha,
        }),
      },
    );
  }

  async getTag(name: string): Promise<ReleaseTag | null> {
    // Get tag ref
    const ref = await this.requestSafe<{ object: { sha: string; type: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/tags/${name}`,
    );

    if (!ref) return null;

    let commitSha = ref.object.sha;
    let message: string | null = null;

    // If it's an annotated tag, get the tag object
    if (ref.object.type === 'tag') {
      const tagObject = await this.requestSafe<{ message: string; object: { sha: string } }>(
        `/repos/${this.owner}/${this.repo}/git/tags/${ref.object.sha}`,
      );

      if (tagObject) {
        message = tagObject.message;
        commitSha = tagObject.object.sha;
      }
    }

    const isPlsRelease = message ? hasReleaseMetadata(message) : false;
    const metadata = message ? parseReleaseMetadata(message) : null;

    return {
      name,
      sha: commitSha,
      message,
      isPlsRelease,
      metadata,
    };
  }

  // --- PR Operations ---

  async findPR(headBranch: string): Promise<PullRequest | null> {
    const prs = await this.request<
      Array<{
        number: number;
        title: string;
        body: string;
        head: { ref: string };
        html_url: string;
      }>
    >(
      `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${headBranch}&state=open`,
    );

    if (prs.length === 0) return null;

    const pr = prs[0];
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      branch: pr.head.ref,
      url: pr.html_url,
    };
  }

  async findMergedPR(headBranch: string): Promise<PullRequest | null> {
    // Search for recently merged PRs from this branch
    const prs = await this.request<
      Array<{
        number: number;
        title: string;
        body: string;
        head: { ref: string };
        html_url: string;
        merged_at: string | null;
      }>
    >(
      `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${headBranch}&state=closed&sort=updated&direction=desc`,
    );

    // Find the first one that was actually merged
    const merged = prs.find((pr) => pr.merged_at !== null);
    if (!merged) return null;

    return {
      number: merged.number,
      title: merged.title,
      body: merged.body || '',
      branch: merged.head.ref,
      url: merged.html_url,
    };
  }

  async getPR(number: number): Promise<PullRequest> {
    const pr = await this.request<{
      number: number;
      title: string;
      body: string;
      head: { ref: string };
      html_url: string;
    }>(`/repos/${this.owner}/${this.repo}/pulls/${number}`);

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      branch: pr.head.ref,
      url: pr.html_url,
    };
  }

  async createPR(options: CreatePROptions): Promise<PullRequest> {
    const pr = await this.request<{
      number: number;
      title: string;
      body: string;
      head: { ref: string };
      html_url: string;
    }>(
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify(options),
      },
    );

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      branch: pr.head.ref,
      url: pr.html_url,
    };
  }

  async updatePR(number: number, options: UpdatePROptions): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/pulls/${number}`,
      {
        method: 'PATCH',
        body: JSON.stringify(options),
      },
    );
  }

  // --- GitHub Releases ---

  async createRelease(
    tag: string,
    name: string,
    body: string,
    prerelease = false,
  ): Promise<string> {
    const release = await this.request<{ html_url: string }>(
      `/repos/${this.owner}/${this.repo}/releases`,
      {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          name,
          body,
          prerelease,
        }),
      },
    );

    return release.html_url;
  }

  async releaseExists(tag: string): Promise<boolean> {
    const release = await this.requestSafe<{ id: number }>(
      `/repos/${this.owner}/${this.repo}/releases/tags/${tag}`,
    );
    return release !== null;
  }
}
