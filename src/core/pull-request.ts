import type { VersionBump } from '../types.ts';
import { PlsError } from '../types.ts';
import { GitHubBackend } from '../backend/mod.ts';
import { updateReleaseFiles } from './release-files.ts';
import {
  generateOptions,
  generateOptionsBlock,
  getSelectedVersion,
  parseOptionsBlock,
  type VersionOption,
} from './pr-options.ts';
import { type DebugEntry, generateDebugBlock, parseDebugBlock } from './pr-debug.ts';

/** Factory for creating GitHubBackends with specific target branches */
export type BackendFactory = (targetBranch: string) => GitHubBackend;

export interface PullRequestOptions {
  owner: string;
  repo: string;
  baseBranch?: string;
  /** Backend for GitHub API operations */
  backend: GitHubBackend;
  /** Factory for creating backends for commit operations */
  createCommitBackend: BackendFactory;
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

/**
 * Factory function to create a ReleasePullRequest with default backends.
 * Use this for convenience; use the constructor directly for testing.
 */
export function createReleasePullRequest(options: {
  owner: string;
  repo: string;
  token?: string;
  baseBranch?: string;
}): ReleasePullRequest {
  const token = options.token || Deno.env.get('GITHUB_TOKEN') || '';
  if (!token) {
    throw new PlsError(
      'GitHub token required for PR creation. Set GITHUB_TOKEN env var or use --token',
      'GITHUB_AUTH_ERROR',
    );
  }

  const { owner, repo } = options;
  const baseBranch = options.baseBranch || 'main';

  const backend = new GitHubBackend({
    owner,
    repo,
    token,
    baseBranch,
    deferBranchUpdate: true,
  });

  const createCommitBackend: BackendFactory = (targetBranch: string) =>
    new GitHubBackend({
      owner,
      repo,
      token,
      baseBranch,
      targetBranch,
      deferBranchUpdate: true,
    });

  return new ReleasePullRequest({
    owner,
    repo,
    baseBranch,
    backend,
    createCommitBackend,
  });
}

export class ReleasePullRequest {
  private owner: string;
  private repo: string;
  private baseBranch: string;
  private backend: GitHubBackend;
  private createCommitBackend: BackendFactory;

  constructor(options: PullRequestOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.baseBranch = options.baseBranch || 'main';
    this.backend = options.backend;
    this.createCommitBackend = options.createCommitBackend;
  }

  /**
   * Make a GitHub API request using the cached backend.
   */
  private request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return this.backend.request<T>(path, options);
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
    debugEntry?: DebugEntry,
  ): Promise<PullRequest> {
    // Check for existing PR first to preserve user's version selection
    const existing = await this.findExisting();

    let selectedVersion = bump.to;
    let existingBody: string | undefined;

    // If PR exists, check if user has selected a different version
    if (existing) {
      const existingPR = await this.getPR(existing.number);
      existingBody = existingPR.body || '';
      const parsed = parseOptionsBlock(existingBody);
      if (parsed?.selected) {
        // User has a selection - preserve the selected version
        selectedVersion = parsed.selected.version;
        if (selectedVersion !== bump.to) {
          console.log(`Preserving user's version selection: ${selectedVersion}`);
        }
      }
    }

    const tag = `v${selectedVersion}`;
    const title = `chore: release ${tag}`;

    // Create effective bump with preserved selection for branch updates
    const effectiveBump: VersionBump = {
      ...bump,
      to: selectedVersion,
    };

    // Always regenerate options based on the selected version
    // This ensures options are correct when user switches to/from prerelease
    const body = this.generatePRBody(
      effectiveBump,
      changelog,
      selectedVersion, // Use selected version as base for options
      undefined, // Always regenerate options
      debugEntry,
      existingBody,
    );

    if (dryRun) {
      console.log(`Would create/update release PR:`);
      console.log(`  Title: ${title}`);
      console.log(`  Branch: ${this.releaseBranch}`);
      console.log(`  Base: ${this.baseBranch}`);
      return {
        number: 0,
        url: '',
        title,
        branch: this.releaseBranch,
      };
    }

    if (existing) {
      // Update existing PR - preserve user's version selection
      await this.updateBranch(effectiveBump, changelog);
      await this.request<GitHubPR>(
        `/repos/${this.owner}/${this.repo}/pulls/${existing.number}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title, body }),
        },
      );
      console.log(`Updated release PR #${existing.number}`);
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

    console.log(`Created release PR #${pr.number}`);
    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      branch: pr.head.ref,
    };
  }

  private async createBranch(bump: VersionBump, _changelog: string): Promise<void> {
    const backend = this.createCommitBackend(this.releaseBranch);
    await backend.ensureBase();
    const baseSha = backend.getBaseSha()!;

    // Create or reset branch to base SHA
    try {
      await backend.request(
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
      await backend.request(
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.releaseBranch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: baseSha, force: true }),
        },
      );
    }

    // Create commit with version changes and update branch
    await updateReleaseFiles(backend, {
      version: bump.to,
      from: bump.from,
      type: bump.type,
    });
    await backend.updateBranchRef(backend.getLastCommitSha()!);
  }

  private async updateBranch(bump: VersionBump, _changelog: string): Promise<void> {
    const backend = this.createCommitBackend(this.releaseBranch);

    // Create new commit first, THEN update branch ref atomically
    // DO NOT reset branch to base first - that causes GitHub to auto-close
    // the PR (0 commits = closed) before the new commit is pushed
    await updateReleaseFiles(backend, {
      version: bump.to,
      from: bump.from,
      type: bump.type,
    });

    // Force update branch ref to point to the new commit
    await backend.updateBranchRef(backend.getLastCommitSha()!, true);
  }

  private generatePRBody(
    bump: VersionBump,
    changelog: string,
    currentVersion: string,
    existingOptions?: VersionOption[],
    debugEntry?: DebugEntry,
    existingBody?: string,
  ): string {
    // Use existing options if provided (preserving user's selection),
    // otherwise generate fresh options
    const options = existingOptions || generateOptions(currentVersion, bump);
    const optionsBlock = generateOptionsBlock(options);

    // Strip the version header from changelog (it's redundant with PR title)
    const changelogContent = changelog.replace(/^## \d+\.\d+\.\d+.*\n\n/, '');

    let body = `## Release ${bump.to}

This PR was automatically created by pls.

### Changes

${changelogContent}

---
*Merging this PR will create a GitHub release and tag.*

<details>
<summary>Version Selection</summary>

Select a version option below. The branch will be updated when the workflow runs.

${optionsBlock}

</details>`;

    // Add debug entry if provided
    if (debugEntry) {
      // Preserve existing debug entries from previous body
      const existingEntries = existingBody ? parseDebugBlock(existingBody) : [];
      const allEntries = [...existingEntries, debugEntry].slice(-10);
      const debugBlock = generateDebugBlock(allEntries);
      body = body + '\n' + debugBlock;
    }

    return body;
  }

  /**
   * Get the currently selected version from an existing PR.
   */
  async getSelectedVersion(prNumber: number): Promise<string | null> {
    const pr = await this.request<{ body: string }>(
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
    );
    return getSelectedVersion(pr.body || '');
  }

  /**
   * Get PR details including body.
   */
  getPR(prNumber: number): Promise<{
    number: number;
    title: string;
    body: string;
    head: { ref: string; sha: string };
    base: { ref: string };
  }> {
    return this.request(
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
    );
  }

  /**
   * Update PR title and body.
   */
  async updatePR(
    prNumber: number,
    title: string,
    body: string,
  ): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title, body }),
      },
    );
  }

  /**
   * Sync PR branch with the selected version.
   * Uses the unified release-files module for all file updates.
   */
  async syncBranch(
    prNumber: number,
    selectedVersion: string,
    fromVersion: string,
    bumpType: 'major' | 'minor' | 'patch' | 'transition',
  ): Promise<void> {
    const pr = await this.getPR(prNumber);
    const branchName = pr.head.ref;

    // Create backend targeting the PR branch
    const backend = new GitHubBackend({
      owner: this.owner,
      repo: this.repo,
      token: this.token,
      baseBranch: pr.base.ref,
      targetBranch: branchName,
      deferBranchUpdate: true,
    });

    // Use unified file update logic
    await updateReleaseFiles(backend, {
      version: selectedVersion,
      from: fromVersion,
      type: bumpType,
    });

    // Force update branch ref to point to the new commit
    await backend.updateBranchRef(backend.getLastCommitSha()!, true);
  }

  /**
   * Update PR description to reflect current selection.
   */
  updatePRBodySelection(body: string, selectedVersion: string): string {
    const parsed = parseOptionsBlock(body);
    if (!parsed) return body;

    // Update options with new selection
    const updatedOptions: VersionOption[] = parsed.options.map((opt) => ({
      ...opt,
      selected: opt.version === selectedVersion && !opt.disabled,
    }));

    // Generate new options block
    const newOptionsBlock = generateOptionsBlock(updatedOptions);

    // Replace options block in body
    const startMarker = '<!-- pls:options -->';
    const endMarker = '<!-- pls:options:end -->';
    const startIndex = body.indexOf(startMarker);
    const endIndex = body.indexOf(endMarker) + endMarker.length;

    if (startIndex === -1 || endIndex === -1) return body;

    let updatedBody = body.substring(0, startIndex) + newOptionsBlock + body.substring(endIndex);

    // Also update the "## Release X.X.X" header
    updatedBody = updatedBody.replace(
      /^## Release \d+\.\d+\.\d+(?:-[a-z]+\.\d+)?/m,
      `## Release ${selectedVersion}`,
    );

    return updatedBody;
  }

  /**
   * Get the version from deno.json on the specified branch.
   */
  async getBaseVersion(branch: string): Promise<string> {
    try {
      const file = await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/deno.json?ref=${branch}`,
      );
      const content = atob(file.content.replace(/\n/g, ''));
      const denoJson = JSON.parse(content);
      return denoJson.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Check if .pls/versions.json exists on the base branch.
   */
  async versionsManifestExists(): Promise<boolean> {
    try {
      await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/.pls/versions.json?ref=${this.baseBranch}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract versions from existing deno.json/package.json files on the base branch.
   * Handles workspaces by scanning all member packages.
   */
  async extractVersionsFromManifests(): Promise<Record<string, string>> {
    const versions: Record<string, string> = {};

    // Try to get root deno.json
    let rootManifest: { version?: string; workspace?: string[] } | null = null;
    try {
      const file = await this.request<{ content: string }>(
        `/repos/${this.owner}/${this.repo}/contents/deno.json?ref=${this.baseBranch}`,
      );
      rootManifest = JSON.parse(atob(file.content.replace(/\n/g, '')));
    } catch {
      // Try package.json
      try {
        const file = await this.request<{ content: string }>(
          `/repos/${this.owner}/${this.repo}/contents/package.json?ref=${this.baseBranch}`,
        );
        rootManifest = JSON.parse(atob(file.content.replace(/\n/g, '')));
      } catch {
        // No manifest found
      }
    }

    if (!rootManifest) {
      return versions;
    }

    // Extract root version
    if (rootManifest.version) {
      versions['.'] = rootManifest.version;
    }

    // Check for workspace members
    const workspacePatterns = rootManifest.workspace || [];
    for (const pattern of workspacePatterns) {
      // Skip glob patterns for now - only handle direct paths
      if (pattern.includes('*')) continue;

      // Try to get member's deno.json
      try {
        const memberPath = pattern.replace(/^\.\//, '');
        const file = await this.request<{ content: string }>(
          `/repos/${this.owner}/${this.repo}/contents/${memberPath}/deno.json?ref=${this.baseBranch}`,
        );
        const memberManifest = JSON.parse(atob(file.content.replace(/\n/g, '')));
        if (memberManifest.version) {
          versions[memberPath] = memberManifest.version;
        }
      } catch {
        // Try package.json for this member
        try {
          const memberPath = pattern.replace(/^\.\//, '');
          const file = await this.request<{ content: string }>(
            `/repos/${this.owner}/${this.repo}/contents/${memberPath}/package.json?ref=${this.baseBranch}`,
          );
          const memberManifest = JSON.parse(atob(file.content.replace(/\n/g, '')));
          if (memberManifest.version) {
            versions[memberPath] = memberManifest.version;
          }
        } catch {
          // No manifest for this member
        }
      }
    }

    return versions;
  }

  /**
   * Create .pls/versions.json by extracting versions from existing project manifests.
   * Can either create a PR or commit directly to the base branch.
   */
  async createVersionsManifest(
    direct: boolean,
    dryRun: boolean,
  ): Promise<{ url?: string; direct: boolean; versions: Record<string, string> }> {
    // Extract versions from existing manifests
    const versions = await this.extractVersionsFromManifests();

    if (Object.keys(versions).length === 0) {
      // No versions found, use default
      versions['.'] = '0.0.0';
    }

    const versionsContent = JSON.stringify(versions, null, 2) + '\n';

    if (dryRun) {
      if (direct) {
        console.log(`Would create .pls/versions.json directly on ${this.baseBranch}:`);
      } else {
        console.log(`Would create setup PR with .pls/versions.json:`);
      }
      console.log(`  File: .pls/versions.json`);
      console.log(`  Content:`);
      for (const [path, version] of Object.entries(versions)) {
        console.log(`    "${path}": "${version}"`);
      }
      return { direct, versions };
    }

    // Get base branch SHA
    const baseRef = await this.request<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${this.baseBranch}`,
    );
    const baseSha = baseRef.object.sha;

    // Get base tree
    const baseCommit = await this.request<{ tree: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/commits/${baseSha}`,
    );

    // Create blob for versions.json
    const versionsBlob = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/blobs`,
      {
        method: 'POST',
        body: JSON.stringify({ content: versionsContent, encoding: 'utf-8' }),
      },
    );

    // Create tree with versions.json
    const tree = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseCommit.tree.sha,
          tree: [
            { path: '.pls/versions.json', mode: '100644', type: 'blob', sha: versionsBlob.sha },
          ],
        }),
      },
    );

    // Build commit message with package info
    const packageList = Object.entries(versions)
      .map(([path, version]) => `  - ${path === '.' ? 'root' : path}: ${version}`)
      .join('\n');

    const commitMessage = `chore: initialize pls versions manifest

Creates .pls/versions.json for release tracking.

Packages:
${packageList}`;

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

    if (direct) {
      // Commit directly to base branch
      await this.request(
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${this.baseBranch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha }),
        },
      );
      console.log(`Created .pls/versions.json directly on ${this.baseBranch}`);
      return { direct: true, versions };
    }

    // Create a setup branch and PR
    const setupBranch = 'pls-setup';

    // Create or update setup branch
    try {
      await this.request(
        `/repos/${this.owner}/${this.repo}/git/refs`,
        {
          method: 'POST',
          body: JSON.stringify({
            ref: `refs/heads/${setupBranch}`,
            sha: commit.sha,
          }),
        },
      );
    } catch {
      // Branch exists, update it
      await this.request(
        `/repos/${this.owner}/${this.repo}/git/refs/heads/${setupBranch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: true }),
        },
      );
    }

    // Check for existing setup PR
    const existingPRs = await this.request<GitHubPR[]>(
      `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${setupBranch}&state=open`,
    );

    if (existingPRs.length > 0) {
      console.log(`Updated existing setup PR #${existingPRs[0].number}`);
      return { url: existingPRs[0].html_url, direct: false, versions };
    }

    // Build PR body with package info
    const packageListMd = Object.entries(versions)
      .map(([path, version]) => `- \`${path === '.' ? '.' : path}\`: ${version}`)
      .join('\n');

    // Create new PR
    const pr = await this.request<GitHubPR>(
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'chore: initialize pls versions manifest',
          body: `## Initialize pls

This PR creates the \`.pls/versions.json\` manifest for release tracking.

### Detected packages
${packageListMd}

---
*Merge this PR to enable \`pls prep\` to create release PRs.*`,
          head: setupBranch,
          base: this.baseBranch,
        }),
      },
    );

    console.log(`Created setup PR #${pr.number}`);
    return { url: pr.html_url, direct: false, versions };
  }
}
