/**
 * PR Comments - Post comments to GitHub PRs for release events.
 *
 * Comments are posted for:
 * - Selection changes (user changed version selection)
 * - Release success (after merge)
 * - Release failure (if something goes wrong)
 */

import { PlsError } from '../types.ts';

export interface PRCommentOptions {
  owner: string;
  repo: string;
  token?: string;
}

export class PRComments {
  private owner: string;
  private repo: string;
  private token: string;
  private baseUrl = 'https://api.github.com';

  constructor(options: PRCommentOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token || Deno.env.get('GITHUB_TOKEN') || '';

    if (!this.token) {
      throw new PlsError(
        'GitHub token required for PR comments. Set GITHUB_TOKEN env var or use --token',
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
        'Content-Type': 'application/json',
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

  /**
   * Post a comment to a PR.
   */
  async postComment(prNumber: number, body: string): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body }),
      },
    );
  }

  /**
   * Post a comment when version selection changes.
   */
  async commentSelectionChanged(
    prNumber: number,
    oldVersion: string,
    newVersion: string,
  ): Promise<void> {
    const body = `**Version selection changed**

${oldVersion} -> ${newVersion}

The release branch has been updated with the new version.`;

    await this.postComment(prNumber, body);
  }

  /**
   * Post a comment when release is created successfully.
   */
  async commentReleaseSuccess(
    prNumber: number,
    version: string,
    tag: string,
    releaseUrl?: string,
  ): Promise<void> {
    let body = `**Release created successfully**

- Version: ${version}
- Tag: ${tag}`;

    if (releaseUrl) {
      body += `\n- Release: ${releaseUrl}`;
    }

    await this.postComment(prNumber, body);
  }

  /**
   * Post a comment when release fails.
   */
  async commentReleaseFailure(
    prNumber: number,
    version: string,
    error: string,
  ): Promise<void> {
    const body = `**Release failed**

Attempted to release version ${version} but encountered an error:

\`\`\`
${error}
\`\`\`

Please check the workflow logs for more details.`;

    await this.postComment(prNumber, body);
  }
}
