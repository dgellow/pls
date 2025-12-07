import type { Release, Storage, StorageOptions } from '../types.ts';
import { PlsError } from '../types.ts';

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  created_at: string;
  html_url: string;
  target_commitish: string;
}

interface GitHubRef {
  ref: string;
  object: {
    sha: string;
    type: string;
  };
}

export class GitHubStorage implements Storage {
  private owner: string;
  private repo: string;
  private token?: string;
  private baseUrl = 'https://api.github.com';
  private cache = new Map<string, { data: unknown; expires: number }>();
  private cacheTTL: number;

  constructor(options: StorageOptions = {}) {
    // Try to detect owner/repo from git remote
    this.owner = options.owner || '';
    this.repo = options.repo || '';
    this.token = options.token || Deno.env.get('GITHUB_TOKEN');
    this.cacheTTL = options.cacheTTL || 60_000; // 1 minute default

    if (!this.owner || !this.repo) {
      throw new PlsError(
        'GitHub storage requires owner and repo. Provide them via options or set a git remote: --owner=<owner> --repo=<repo>',
        'GITHUB_CONFIG_ERROR',
      );
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const cacheKey = `${options.method || 'GET'}:${path}`;

    // Check cache for GET requests
    if (!options.method || options.method === 'GET') {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        return cached.data as T;
      }
    }

    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'pls-release-tool',
      ...options.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new PlsError(
        `GitHub API error: ${response.statusText}`,
        'GITHUB_API_ERROR',
        { status: response.status, error },
      );
    }

    const data = await response.json();

    // Cache successful GET requests
    if (!options.method || options.method === 'GET') {
      this.cache.set(cacheKey, {
        data,
        expires: Date.now() + this.cacheTTL,
      });
    }

    return data;
  }

  private async getTagSha(tagName: string): Promise<string | null> {
    try {
      const ref = await this.request<GitHubRef>(
        `/repos/${this.owner}/${this.repo}/git/ref/tags/${tagName}`,
      );

      // For annotated tags, object.type is "tag" and we need to dereference
      // For lightweight tags, object.type is "commit" and sha is the commit
      if (ref.object.type === 'tag') {
        // Annotated tag - need to get the tag object to find the commit
        const tagObj = await this.request<{ object: { sha: string } }>(
          `/repos/${this.owner}/${this.repo}/git/tags/${ref.object.sha}`,
        );
        return tagObj.object.sha;
      }

      return ref.object.sha;
    } catch {
      // Tag might not exist or be in a different format
      return null;
    }
  }

  async getLastRelease(): Promise<Release | null> {
    try {
      // Fetch multiple releases because GitHub's API doesn't guarantee chronological order
      // and may deprioritize prereleases. We sort client-side to get the truly latest.
      const releases = await this.request<GitHubRelease[]>(
        `/repos/${this.owner}/${this.repo}/releases?per_page=10`,
      );

      if (releases.length === 0) {
        return null;
      }

      // Sort by created_at descending to get the most recent release (including prereleases)
      const sorted = releases.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const latest = sorted[0];

      // target_commitish is often just the branch name, not the SHA
      // Look up the actual commit SHA from the tag
      const tagSha = await this.getTagSha(latest.tag_name);

      return {
        version: latest.tag_name.replace(/^v/, ''),
        tag: latest.tag_name,
        sha: tagSha || latest.target_commitish,
        createdAt: new Date(latest.created_at),
        notes: latest.body,
        url: latest.html_url,
      };
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to get latest release: ${error instanceof Error ? error.message : String(error)}`,
        'GITHUB_FETCH_ERROR',
        error,
      );
    }
  }

  async saveRelease(release: Release): Promise<void> {
    // Check if this is a prerelease version (alpha, beta, rc)
    const isPrerelease = /-(alpha|beta|rc)\.\d+$/.test(release.version);

    try {
      await this.request<GitHubRelease>(
        `/repos/${this.owner}/${this.repo}/releases`,
        {
          method: 'POST',
          body: JSON.stringify({
            tag_name: release.tag,
            name: release.tag,
            body: release.notes || '',
            target_commitish: release.sha,
            prerelease: isPrerelease,
          }),
        },
      );

      // Clear cache after creating release
      this.cache.clear();
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to create release: ${error instanceof Error ? error.message : String(error)}`,
        'GITHUB_CREATE_ERROR',
        error,
      );
    }
  }

  async listReleases(): Promise<Release[]> {
    try {
      const releases = await this.request<GitHubRelease[]>(
        `/repos/${this.owner}/${this.repo}/releases?per_page=100`,
      );

      return releases.map((r) => ({
        version: r.tag_name.replace(/^v/, ''),
        tag: r.tag_name,
        sha: r.target_commitish,
        createdAt: new Date(r.created_at),
        notes: r.body,
        url: r.html_url,
      }));
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to list releases: ${error instanceof Error ? error.message : String(error)}`,
        'GITHUB_LIST_ERROR',
        error,
      );
    }
  }
}
