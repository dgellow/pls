/**
 * PR Release Workflow - pls release
 *
 * Creates tag and GitHub Release after PR merge.
 * Runs on every push to targetBranch for self-healing.
 *
 * For Strategy B (next branch): syncs base branch onto target after release.
 */

import type { GitHub } from '../clients/github.ts';
import type { LocalGit } from '../clients/local-git.ts';
import type { VersionsManifest } from '../domain/types.ts';
import type { PlsConfig } from '../domain/config.ts';
import { parseReleaseMetadata } from '../domain/release-metadata.ts';
import { generateReleaseTagMessage } from '../domain/release-metadata.ts';
import { generateCommitList } from '../domain/changelog.ts';
import { filterReleasableCommits } from '../domain/commits.ts';
import * as semver from '../lib/semver.ts';

export interface ReleaseResult {
  released: boolean;
  version: string | null;
  tag: string | null;
  url: string | null;
  alreadyExists: boolean;
  recovered: boolean;
  branchSynced: boolean;
  branchSyncError: string | null;
}

export interface ReleaseOptions {
  /** Configuration (for branch sync) */
  config?: PlsConfig;
}

const DEFAULT_RESULT: ReleaseResult = {
  released: false,
  version: null,
  tag: null,
  url: null,
  alreadyExists: false,
  recovered: false,
  branchSynced: false,
  branchSyncError: null,
};

/**
 * Execute pls release workflow.
 *
 * Self-healing: runs on every push, creates missing tags.
 */
export async function releaseWorkflow(
  git: LocalGit,
  github: GitHub,
  options: ReleaseOptions = {},
): Promise<ReleaseResult> {
  // 1. Check if HEAD is a release commit
  const headSha = await git.getHeadSha();
  const headMessage = await git.getCommitMessage('HEAD');
  const metadata = parseReleaseMetadata(headMessage);

  let version: string;
  let fromVersion: string;
  let bumpType: 'major' | 'minor' | 'patch' | 'transition';

  if (metadata) {
    // HEAD is a release commit - use its metadata
    version = metadata.version;
    fromVersion = metadata.from;
    bumpType = metadata.type;
  } else {
    // Not a release commit - read from versions.json
    const versionsContent = await git.readFile('.pls/versions.json');
    if (!versionsContent) {
      return { ...DEFAULT_RESULT };
    }

    const versions: VersionsManifest = JSON.parse(versionsContent);
    version = versions['.']?.version;

    if (!version) {
      return { ...DEFAULT_RESULT };
    }

    // Try to determine from/type from tag history
    fromVersion = await findPreviousVersion(github, version);
    bumpType = 'patch'; // Default, actual type unknown
  }

  const tag = `v${version}`;

  // 2. Check if tag already exists
  const existingTag = await github.getTag(tag);
  if (existingTag?.isPlsRelease) {
    // Already released - but still try branch sync
    let branchSynced = false;
    let branchSyncError: string | null = null;

    if (options.config?.strategy === 'next') {
      const syncResult = await syncBaseBranch(git, options.config);
      branchSynced = syncResult.success;
      branchSyncError = syncResult.error;
    }

    return {
      released: false,
      version,
      tag,
      url: null,
      alreadyExists: true,
      recovered: false,
      branchSynced,
      branchSyncError,
    };
  }

  // 3. Find the release commit SHA
  let releaseSha: string;

  if (metadata) {
    // HEAD is the release commit
    releaseSha = headSha;
  } else {
    // Search for commit that set this version
    const foundSha = await git.findCommitByContent(version, '.pls/versions.json');
    releaseSha = foundSha || headSha;
  }

  // 4. Generate tag message - get commits since previous release
  const fromTag = `v${fromVersion}`;
  const fromTagInfo = await github.getTag(fromTag);
  const fromSha = fromTagInfo?.sha || null;
  const commits = await git.getCommitsSince(fromSha);
  const relevantCommits = filterReleasableCommits(commits);
  const commitList = generateCommitList(relevantCommits);

  const tagMessage = generateReleaseTagMessage(
    { version, from: fromVersion, type: bumpType },
    `## Changes\n${commitList}`,
  );

  // 5. Create tag
  const recovered = existingTag !== null && !existingTag.isPlsRelease;

  try {
    await github.createTag(tag, releaseSha, tagMessage);
  } catch (error) {
    // Tag might already exist (concurrent runs)
    if (String(error).includes('already exists')) {
      return {
        ...DEFAULT_RESULT,
        version,
        tag,
        alreadyExists: true,
      };
    }
    throw error;
  }

  // 6. Create GitHub Release
  const isPrerelease = semver.getStage(version) !== 'stable';
  let releaseUrl: string | null = null;

  try {
    releaseUrl = await github.createRelease(
      tag,
      `Release ${tag}`,
      `## Changes\n${commitList}`,
      isPrerelease,
    );
  } catch (error) {
    // Release might already exist
    console.warn(`Warning: Could not create GitHub Release: ${error}`);
  }

  // 7. Sync branches for Strategy B (next → main)
  let branchSynced = false;
  let branchSyncError: string | null = null;

  if (options.config?.strategy === 'next') {
    const syncResult = await syncBaseBranch(git, options.config);
    branchSynced = syncResult.success;
    branchSyncError = syncResult.error;
  }

  return {
    released: true,
    version,
    tag,
    url: releaseUrl,
    alreadyExists: false,
    recovered,
    branchSynced,
    branchSyncError,
  };
}

/**
 * Sync base branch (next) onto target branch (main) after release.
 *
 * Strategy B pattern:
 * - Commits land on `next`
 * - Releases merge to `main`
 * - After release, rebase `next` on `main`
 *
 * Retries with exponential backoff to handle concurrent pushes.
 */
async function syncBaseBranch(
  git: LocalGit,
  config: PlsConfig,
  maxRetries = 3,
): Promise<{ success: boolean; error: string | null }> {
  const { baseBranch, targetBranch } = config;

  // Only sync if base and target are different
  if (baseBranch === targetBranch) {
    return { success: true, error: null };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Fetch latest
      await git.fetch('origin');

      // Checkout base branch from remote
      await git.checkoutBranch(baseBranch, `origin/${baseBranch}`);

      // Rebase onto target
      const rebaseSuccess = await git.rebase(`origin/${targetBranch}`);
      if (!rebaseSuccess) {
        return {
          success: false,
          error: `Rebase of ${baseBranch} onto ${targetBranch} failed (conflicts)`,
        };
      }

      // Push with force-with-lease (safe force push)
      const pushSuccess = await git.pushForceWithLease('origin', baseBranch);
      if (pushSuccess) {
        return { success: true, error: null };
      }

      // Push failed - branch changed during sync, retry
      console.warn(`Retry ${attempt}/${maxRetries}: ${baseBranch} changed during sync`);

      // Exponential backoff before retry
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000); // 2s, 4s, 8s
      }
    } catch (error) {
      // Unexpected error
      return {
        success: false,
        error: `Failed to sync ${baseBranch}: ${error}`,
      };
    }
  }

  // All retries exhausted
  return {
    success: false,
    error: `Could not sync ${baseBranch} after ${maxRetries} attempts. Manual sync may be needed.`,
  };
}

/**
 * Find previous version for changelog context.
 */
async function findPreviousVersion(
  github: GitHub,
  currentVersion: string,
): Promise<string> {
  // Try to find previous tag
  const parsed = semver.parse(currentVersion);
  if (!parsed) return '0.0.0';

  // Check for previous patch
  if (parsed.patch > 0) {
    const prevTag = `v${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
    const exists = await github.getTag(prevTag);
    if (exists) return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
  }

  // Check for previous minor
  if (parsed.minor > 0) {
    const prevTag = `v${parsed.major}.${parsed.minor - 1}.0`;
    const exists = await github.getTag(prevTag);
    if (exists) return `${parsed.major}.${parsed.minor - 1}.0`;
  }

  return '0.0.0';
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
