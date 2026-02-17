/**
 * PR Release Workflow - pls release
 *
 * Creates tag and GitHub Release after PR merge.
 * Runs on every push to targetBranch for self-healing.
 *
 * For Strategy B (next branch): syncs base branch onto target after release.
 */

import type { BranchSyncable, CodeHost, LocalRepo } from '../domain/vcs.ts';
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
  repo: LocalRepo,
  host: CodeHost,
  options: ReleaseOptions = {},
): Promise<ReleaseResult> {
  // 1. Check if HEAD is a release commit
  const headRev = await repo.getHeadRevision();
  const headMessage = await repo.getCommitMessage('HEAD');
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
    const versionsContent = await repo.readFile('.pls/versions.json');
    if (!versionsContent) {
      return { ...DEFAULT_RESULT };
    }

    const versions: VersionsManifest = JSON.parse(versionsContent);
    version = versions['.']?.version;

    if (!version) {
      return { ...DEFAULT_RESULT };
    }

    // Try to determine from/type from tag history
    fromVersion = await findPreviousVersion(host, version);
    bumpType = 'patch'; // Default, actual type unknown
  }

  const tag = `v${version}`;

  // 2. Check if tag already exists
  const existingTag = await host.getTag(tag);
  if (existingTag?.isPlsRelease) {
    // Tag exists — but GitHub Release might be missing. Try to create/find it.
    const isPrerelease = semver.getStage(version) !== 'stable';

    const fromTag = `v${fromVersion}`;
    const fromTagInfo = await host.getTag(fromTag);
    const fromRev = fromTagInfo?.rev || null;
    const commits = await repo.getCommitsSince(fromRev);
    const relevantCommits = filterReleasableCommits(commits);
    const commitList = generateCommitList(relevantCommits);

    const releaseUrl = await ensureRelease(
      host,
      tag,
      `Release ${tag}`,
      `## Changes\n${commitList}`,
      isPrerelease,
    );

    // Branch sync (Strategy B)
    let branchSynced = false;
    let branchSyncError: string | null = null;

    if (options.config?.strategy === 'next' && isBranchSyncable(repo)) {
      const syncResult = await syncBaseBranch(repo, options.config);
      branchSynced = syncResult.success;
      branchSyncError = syncResult.error;
    }

    return {
      released: false,
      version,
      tag,
      url: releaseUrl,
      alreadyExists: true,
      recovered: false,
      branchSynced,
      branchSyncError,
    };
  }

  // 3. Find the release commit revision
  let releaseRev: string;

  if (metadata) {
    // HEAD is the release commit
    releaseRev = headRev;
  } else {
    // Search for commit that set this version
    const foundRev = await repo.findCommitByContent(version, '.pls/versions.json');
    releaseRev = foundRev || headRev;
  }

  // 4. Generate tag message - get commits since previous release
  const fromTag = `v${fromVersion}`;
  const fromTagInfo = await host.getTag(fromTag);
  const fromRev = fromTagInfo?.rev || null;
  const commits = await repo.getCommitsSince(fromRev);
  const relevantCommits = filterReleasableCommits(commits);
  const commitList = generateCommitList(relevantCommits);

  const tagMessage = generateReleaseTagMessage(
    { version, from: fromVersion, type: bumpType },
    `## Changes\n${commitList}`,
  );

  // 5. Create tag
  const recovered = existingTag !== null && !existingTag.isPlsRelease;

  try {
    await host.createTag(tag, releaseRev, tagMessage);
  } catch (error) {
    // Tag might already exist (concurrent runs)
    if (String(error).includes('already exists')) {
      const isPrerelease = semver.getStage(version) !== 'stable';
      const releaseUrl = await ensureRelease(
        host,
        tag,
        `Release ${tag}`,
        `## Changes\n${commitList}`,
        isPrerelease,
      );

      return {
        ...DEFAULT_RESULT,
        version,
        tag,
        url: releaseUrl,
        alreadyExists: true,
      };
    }
    throw error;
  }

  // 6. Create GitHub Release
  const isPrerelease = semver.getStage(version) !== 'stable';
  const releaseUrl = await ensureRelease(
    host,
    tag,
    `Release ${tag}`,
    `## Changes\n${commitList}`,
    isPrerelease,
  );

  // 7. Sync branches for Strategy B (next → main)
  let branchSynced = false;
  let branchSyncError: string | null = null;

  if (options.config?.strategy === 'next' && isBranchSyncable(repo)) {
    const syncResult = await syncBaseBranch(repo, options.config);
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
 * Attempt to create a GitHub Release, falling back to fetching an existing one.
 * Returns the release URL or null (best effort).
 */
async function ensureRelease(
  host: CodeHost,
  tag: string,
  name: string,
  body: string,
  prerelease: boolean,
): Promise<string | null> {
  try {
    return await host.createRelease(tag, name, body, prerelease);
  } catch {
    // Release might already exist — try to fetch it
    try {
      return await host.getReleaseUrl(tag);
    } catch {
      return null;
    }
  }
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
  repo: BranchSyncable,
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
      await repo.fetch('origin');

      // Checkout base branch from remote
      await repo.checkoutBranch(baseBranch, `origin/${baseBranch}`);

      // Rebase onto target
      const rebaseSuccess = await repo.rebase(`origin/${targetBranch}`);
      if (!rebaseSuccess) {
        return {
          success: false,
          error: `Rebase of ${baseBranch} onto ${targetBranch} failed (conflicts)`,
        };
      }

      // Push with force-with-lease (safe force push)
      const pushSuccess = await repo.pushForceWithLease('origin', baseBranch);
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
  host: CodeHost,
  currentVersion: string,
): Promise<string> {
  // Try to find previous tag
  const parsed = semver.parse(currentVersion);
  if (!parsed) return '0.0.0';

  // Check for previous patch
  if (parsed.patch > 0) {
    const prevTag = `v${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
    const exists = await host.getTag(prevTag);
    if (exists) return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
  }

  // Check for previous minor
  if (parsed.minor > 0) {
    const prevTag = `v${parsed.major}.${parsed.minor - 1}.0`;
    const exists = await host.getTag(prevTag);
    if (exists) return `${parsed.major}.${parsed.minor - 1}.0`;
  }

  return '0.0.0';
}

/**
 * Check if a LocalRepo also supports branch sync operations.
 */
function isBranchSyncable(repo: LocalRepo): repo is LocalRepo & BranchSyncable {
  return 'fetch' in repo && 'checkoutBranch' in repo && 'rebase' in repo &&
    'pushForceWithLease' in repo;
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
