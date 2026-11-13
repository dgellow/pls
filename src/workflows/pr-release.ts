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
import { PlsError } from '../lib/error.ts';
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
  // 1. The version to release is what the tree says: .pls/versions.json at HEAD.
  const headRev = await repo.getHeadRevision();
  const versionsContent = await repo.readFile('.pls/versions.json');
  if (!versionsContent) {
    return { ...DEFAULT_RESULT };
  }

  const versions: VersionsManifest = JSON.parse(versionsContent);
  const version = versions['.']?.version;
  if (!version) {
    return { ...DEFAULT_RESULT };
  }

  // The commit that set this version is the release commit.
  const versionRev = await findVersionCommit(repo, version);

  // 2. A ---pls-release--- block in HEAD's message says where the release came
  // from and what kind it is. Commit messages are not reviewed the way files
  // are (a squash merge copies a contributor's text into main), so the block is
  // used only when the tree backs it: it names the version in versions.json,
  // and HEAD is the commit that set that version.
  const headMessage = await repo.getCommitMessage('HEAD');
  const claimed = parseReleaseMetadata(headMessage);
  let metadata: typeof claimed = null;

  if (claimed) {
    if (claimed.version !== version) {
      console.warn(
        `⚠️  HEAD's commit message has a ---pls-release--- block for ${claimed.version}, ` +
          `but .pls/versions.json says ${version}. Ignoring the block: ` +
          `pls releases what .pls/versions.json says.`,
      );
    } else if (versionRev !== null && versionRev !== headRev) {
      console.warn(
        `⚠️  HEAD's commit message has a ---pls-release--- block for ${claimed.version}, ` +
          `but ${versionRev.slice(0, 7)} is the commit that set that version. Ignoring the block.`,
      );
    } else {
      metadata = claimed;
    }
  }

  let fromVersion: string;
  let bumpType: 'major' | 'minor' | 'patch' | 'transition';

  if (metadata) {
    fromVersion = metadata.from;
    bumpType = metadata.type;
  } else {
    // Try to determine from/type from tag history
    fromVersion = await findPreviousVersion(host, version);
    bumpType = 'patch'; // Default, actual type unknown
  }

  const tag = `v${version}`;

  // 3. Check if tag already exists
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

  // 4. The release commit: where the version was set, or HEAD if history cannot tell.
  const releaseRev = versionRev ?? headRev;

  // 5. Generate tag message - get commits since previous release
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

  // 6. Create tag
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

  // 7. Create GitHub Release
  const isPrerelease = semver.getStage(version) !== 'stable';
  const releaseUrl = await ensureRelease(
    host,
    tag,
    `Release ${tag}`,
    `## Changes\n${commitList}`,
    isPrerelease,
  );

  // 8. Sync branches for Strategy B (next → main)
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
 * The commit that set `version` in .pls/versions.json, or null if history
 * does not show one.
 *
 * Searches for the quoted value: `"1.1.0"` does not match `"1.1.0-beta.0"`,
 * so the step from a prerelease to its stable version is found too.
 */
async function findVersionCommit(repo: LocalRepo, version: string): Promise<string | null> {
  return await repo.findCommitByContent(`"${version}"`, '.pls/versions.json');
}

/**
 * Make sure a GitHub Release exists for the tag and return its URL.
 *
 * Throws when the release neither exists nor can be created: a run that
 * leaves a tag without its release must not report success.
 */
async function ensureRelease(
  host: CodeHost,
  tag: string,
  name: string,
  body: string,
  prerelease: boolean,
): Promise<string> {
  const existing = await host.getReleaseUrl(tag);
  if (existing) return existing;

  try {
    return await host.createRelease(tag, name, body, prerelease);
  } catch (error) {
    // It may exist after all: another run created it, or the response to our
    // own request was lost on the way back.
    const url = await host.getReleaseUrl(tag).catch(() => null);
    if (url) return url;

    const reason = error instanceof Error ? error.message : String(error);
    throw new PlsError(
      `Tag ${tag} exists, but its GitHub Release could not be created.\n${reason}\n\n` +
        `Check that the token can create releases (permission "contents: write"), ` +
        `then run "pls release" again: it creates the missing release for an existing tag.`,
      'RELEASE_CREATE_FAILED',
      { tag, cause: error instanceof PlsError ? error.details : reason },
    );
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
