/**
 * GitHub API client - all GitHub operations.
 *
 * Key design: branch is a PARAMETER, not configuration.
 */

import type {
  CreatePROptions,
  FileChanges,
  PullRequest,
  ReleaseTag,
  UpdatePROptions,
} from '../domain/types.ts';
import { hasReleaseMetadata, parseReleaseMetadata } from '../domain/release-metadata.ts';
import type { CodeHost } from '../domain/vcs.ts';
import { PlsError } from '../lib/error.ts';

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  /** REST API base URL. Defaults to github.com's API; set for GitHub Enterprise Server. */
  apiUrl?: string;
}

/**
 * Decode base64 file content as UTF-8 text.
 *
 * `atob` alone returns one character per byte, which turns every non-ASCII
 * character into mojibake that is then written back to the repository.
 */
function decodeBase64Text(encoded: string, path: string): string {
  const binary = atob(encoded.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  try {
    // ignoreBOM keeps a byte order mark in the text, so it is written back unchanged.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PlsError(
      `"${path}" is not valid UTF-8 text, so pls cannot update it without damaging it. ` +
        `Convert the file to UTF-8, or stop tracking it with pls.`,
      'FILE_NOT_UTF8',
      { path },
    );
  }
}

export class GitHub implements CodeHost {
  private owner: string;
  private repo: string;
  private token: string;
  private baseUrl: string;

  constructor(options: GitHubClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.baseUrl = (options.apiUrl || 'https://api.github.com').replace(/\/+$/, '');

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
    const result = await this.requestSafe<
      { type?: string; content?: string; encoding?: string; sha: string; size: number }
    >(
      `/repos/${this.owner}/${this.repo}/contents/${path}${query}`,
    );

    if (!result) return null;

    if (result.type !== 'file') {
      throw new PlsError(
        `Expected a file at "${path}"${ref ? ` on ${ref}` : ''}, found ` +
          `${Array.isArray(result) ? 'a directory' : `a ${result.type}`}. ` +
          `Point pls at a regular file.`,
        'GITHUB_NOT_A_FILE',
        { path, ref },
      );
    }

    let encoded = result.content ?? '';

    // The contents API carries no content for files above 1 MB: `content` is
    // empty and `encoding` is "none". The blob API serves files up to 100 MB.
    // Treating the empty content as the file would drop everything in it.
    if (result.encoding !== 'base64' || (encoded === '' && result.size > 0)) {
      const blob = await this.request<{ content: string; encoding: string }>(
        `/repos/${this.owner}/${this.repo}/git/blobs/${result.sha}`,
      );
      if (blob.encoding !== 'base64') {
        throw new PlsError(
          `GitHub returned "${path}" with encoding "${blob.encoding}"; expected base64. ` +
            `This is unexpected: please report it with the file size (${result.size} bytes).`,
          'GITHUB_UNEXPECTED_ENCODING',
          { path, ref, encoding: blob.encoding, size: result.size },
        );
      }
      encoded = blob.content;
    }

    return decodeBase64Text(encoded, path);
  }

  async fileExists(path: string, ref?: string): Promise<boolean> {
    const content = await this.readFile(path, ref);
    return content !== null;
  }

  // --- Atomic Commit ---

  async commit(
    files: FileChanges,
    message: string,
    parentRev: string,
  ): Promise<string> {
    // 1. Get parent tree
    const parentCommit = await this.request<{ tree: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/commits/${parentRev}`,
    );

    // 2. Create blobs for each file. A file that exists keeps its mode: an
    // executable script must stay executable.
    const modes = await this.fileModes(parentCommit.tree.sha, [...files.keys()]);
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
        mode: modes.get(path) === '100755' ? '100755' : '100644',
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
    const commitResult = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [parentRev],
        }),
      },
    );

    return commitResult.sha;
  }

  /**
   * File modes of `paths` in a tree. Paths that do not exist are left out.
   *
   * One recursive listing answers this for most repositories. GitHub
   * truncates that listing for very large trees; the paths it did not
   * return are then looked up directory by directory.
   */
  private async fileModes(treeSha: string, paths: string[]): Promise<Map<string, string>> {
    type Entry = { path: string; mode: string; type: string; sha: string };
    type Tree = { tree: Entry[]; truncated: boolean };
    const modes = new Map<string, string>();
    if (paths.length === 0) return modes;

    const wanted = new Set(paths);
    const listing = await this.request<Tree>(
      `/repos/${this.owner}/${this.repo}/git/trees/${treeSha}?recursive=1`,
    );
    for (const entry of listing.tree) {
      if (wanted.has(entry.path)) modes.set(entry.path, entry.mode);
    }
    if (!listing.truncated) return modes;

    for (const path of paths) {
      if (modes.has(path)) continue;
      const parts = path.split('/');
      let sha: string | null = treeSha;
      for (let depth = 0; depth < parts.length && sha; depth++) {
        const level: Tree | null = await this.requestSafe<Tree>(
          `/repos/${this.owner}/${this.repo}/git/trees/${sha}`,
        );
        const entry: Entry | undefined = level?.tree.find((e) => e.path === parts[depth]);
        if (!entry) break;
        if (depth === parts.length - 1) modes.set(path, entry.mode);
        sha = entry.type === 'tree' ? entry.sha : null;
      }
    }
    return modes;
  }

  // --- Branch Operations ---

  async getBranchRevision(branch: string): Promise<string | null> {
    const ref = await this.requestSafe<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${branch}`,
    );
    return ref?.object.sha ?? null;
  }

  async pointBranch(branch: string, rev: string, force = false): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: rev, force }),
      },
    );
  }

  async createBranch(branch: string, rev: string): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: rev,
        }),
      },
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    const rev = await this.getBranchRevision(branch);
    return rev !== null;
  }

  /**
   * Ensure branch exists, creating or updating as needed.
   */
  async ensureBranch(branch: string, rev: string): Promise<void> {
    const exists = await this.branchExists(branch);
    if (exists) {
      await this.pointBranch(branch, rev, true);
    } else {
      await this.createBranch(branch, rev);
    }
  }

  // --- Tag Operations ---

  async createTag(name: string, rev: string, message: string): Promise<void> {
    // Create annotated tag object
    const tagObject = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/tags`,
      {
        method: 'POST',
        body: JSON.stringify({
          tag: name,
          message,
          object: rev,
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

    let commitRev = ref.object.sha;
    let message: string | null = null;

    // If it's an annotated tag, get the tag object
    if (ref.object.type === 'tag') {
      const tagObject = await this.requestSafe<{ message: string; object: { sha: string } }>(
        `/repos/${this.owner}/${this.repo}/git/tags/${ref.object.sha}`,
      );

      if (tagObject) {
        message = tagObject.message;
        commitRev = tagObject.object.sha;
      }
    }

    const isPlsRelease = message ? hasReleaseMetadata(message) : false;
    const metadata = message ? parseReleaseMetadata(message) : null;

    return {
      name,
      rev: commitRev,
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

  async getReleaseUrl(tag: string): Promise<string | null> {
    const release = await this.requestSafe<{ html_url: string }>(
      `/repos/${this.owner}/${this.repo}/releases/tags/${tag}`,
    );
    return release?.html_url ?? null;
  }
}
