import type { VersionBump } from '../types.ts';
import { PlsError } from '../types.ts';
import { generateReleaseCommitMessage } from './release-metadata.ts';

export interface PullRequestOptions {
  owner: string;
  repo: string;
  token?: string;
  baseBranch?: string;
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  branch: string;
}

interface GitHubPR {
  number: number;
  html_url: string;
  title: string;
  head: { ref: string };
}

export class ReleasePullRequest {
  private owner: string;
  private repo: string;
  private token: string;
  private baseBranch: string;
  private baseUrl = 'https://api.github.com';

  constructor(options: PullRequestOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token || Deno.env.get('GITHUB_TOKEN') || '';
    this.baseBranch = options.baseBranch || 'main';

    if (!this.token) {
      throw new PlsError(
        'GitHub token required for PR creation. Set GITHUB_TOKEN env var or use --token',
        'GITHUB_AUTH_ERROR',
      );
    }
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${this.token}`,
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

  private get releaseBranch(): string {
    return 'pls-release';
  }

  async findExisting(): Promise<PullRequest | null> {
    try {
      const prs = await this.request<GitHubPR[]>(
        `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${this.releaseBranch}&state=open`,
      );

      if (prs.length === 0) return null;

      const pr = prs[0];
      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        branch: pr.head.ref,
      };
    } catch {
      return null;
    }
  }

  async createOrUpdate(
    bump: VersionBump,
    changelog: string,
    dryRun: boolean,
  ): Promise<PullRequest> {
    const tag = `v${bump.to}`;
    const title = `chore: release ${tag}`;
    const body = this.generatePRBody(bump, changelog);

    if (dryRun) {
      console.log(`🔀 Would create/update release PR:`);
      console.log(`   Title: ${title}`);
      console.log(`   Branch: ${this.releaseBranch}`);
      console.log(`   Base: ${this.baseBranch}`);
      return {
        number: 0,
        url: '',
        title,
        branch: this.releaseBranch,
      };
    }

    // Check for existing PR
    const existing = await this.findExisting();

    if (existing) {
      // Update existing PR
      await this.updateBranch(bump, changelog);
      await this.request<GitHubPR>(
        `/repos/${this.owner}/${this.repo}/pulls/${existing.number}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title, body }),
        },
      );
      console.log(`🔄 Updated release PR #${existing.number}`);
      return existing;
    }

    // Create new branch and PR
    await this.createBranch(bump, changelog);
    const pr = await this.request<GitHubPR>(
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          body,
          head: this.releaseBranch,
          base: this.baseBranch,
        }),
      },
    );

    console.log(`🆕 Created release PR #${pr.number}`);
    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      branch: pr.head.ref,
    };
  }

  private async createBranch(bump: VersionBump, changelog: string): Promise<void> {
    // Get base branch SHA
    const baseRef = await this.request<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.baseBranch}`,
    );
    const baseSha = baseRef.object.sha;

    // Try to create branch, or update if exists
    try {
      await this.request(
        `/repos/${this.owner}/${this.repo}/git/refs`,
        {
          method: 'POST',
          body: JSON.stringify({
            ref: `refs/heads/${this.releaseBranch}`,
            sha: baseSha,
          }),
        },
      );
    } catch {
      // Branch exists, update it
      await this.request(
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.releaseBranch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: baseSha, force: true }),
        },
      );
    }

    // Create commit with version changes
    await this.createReleaseCommit(bump, changelog, baseSha);
  }

  private async updateBranch(bump: VersionBump, changelog: string): Promise<void> {
    // Get base branch SHA
    const baseRef = await this.request<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.baseBranch}`,
    );
    const baseSha = baseRef.object.sha;

    // Reset branch to base
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.releaseBranch}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: baseSha, force: true }),
      },
    );

    // Create new commit
    await this.createReleaseCommit(bump, changelog, baseSha);
  }

  private async createReleaseCommit(
    bump: VersionBump,
    _changelog: string,
    baseSha: string,
  ): Promise<void> {
    // Generate structured commit message with embedded metadata
    const commitMessage = generateReleaseCommitMessage({
      version: bump.to,
      from: bump.from,
      type: bump.type,
    });

    // Get base tree
    const baseCommit = await this.request<{ tree: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/commits/${baseSha}`,
    );

    // Get current deno.json content
    let denoJsonContent: string;
    try {
      const file = await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/deno.json?ref=${this.baseBranch}`,
      );
      denoJsonContent = atob(file.content.replace(/\n/g, ''));
    } catch {
      denoJsonContent = '{}';
    }

    // Update version in deno.json
    const denoJson = JSON.parse(denoJsonContent);
    denoJson.version = bump.to;
    const newDenoJson = JSON.stringify(denoJson, null, 2) + '\n';

    // Get current .pls/versions.json content (or create new)
    // Note: SHA will be set after merge when release is finalized
    let versionsContent: Record<string, string | { version: string; sha?: string }>;
    try {
      const file = await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/.pls/versions.json?ref=${this.baseBranch}`,
      );
      versionsContent = JSON.parse(atob(file.content.replace(/\n/g, '')));
    } catch {
      versionsContent = {};
    }
    // Keep existing SHA if present, otherwise just set version
    const existing = versionsContent['.'];
    const existingSha = existing && typeof existing === 'object' ? existing.sha : undefined;
    versionsContent['.'] = existingSha ? { version: bump.to, sha: existingSha } : bump.to;
    const newVersionsJson = JSON.stringify(versionsContent, null, 2) + '\n';

    // Create blobs for both files
    const denoBlob = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: newDenoJson,
          encoding: 'utf-8',
        }),
      },
    );

    const versionsBlob = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: newVersionsJson,
          encoding: 'utf-8',
        }),
      },
    );

    // Create tree with updated files
    const tree = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseCommit.tree.sha,
          tree: [
            {
              path: 'deno.json',
              mode: '100644',
              type: 'blob',
              sha: denoBlob.sha,
            },
            {
              path: '.pls/versions.json',
              mode: '100644',
              type: 'blob',
              sha: versionsBlob.sha,
            },
          ],
        }),
      },
    );

    // Create commit with structured metadata
    const commit = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: commitMessage,
          tree: tree.sha,
          parents: [baseSha],
        }),
      },
    );

    // Update branch ref
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.releaseBranch}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      },
    );
  }

  private generatePRBody(bump: VersionBump, changelog: string): string {
    return `## Release ${bump.to}

This PR was automatically created by pls.

### Changes

${changelog}

---
*Merging this PR will create a GitHub release and tag.*
`;
  }
}
