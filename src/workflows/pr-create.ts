/**
 * PR Create Workflow - pls prep
 *
 * Creates or updates a release PR.
 */

import type { CodeHost, LocalRepo } from '../domain/vcs.ts';
import type { FileChanges, PullRequest, VersionBump, VersionsManifest } from '../domain/types.ts';
import { calculateBump } from '../domain/bump.ts';
import { filterReleasableCommits } from '../domain/commits.ts';
import { generateChangelog, generateReleaseNotes } from '../domain/changelog.ts';
import { buildReleaseFiles, createInitialVersionsManifest } from '../domain/files.ts';
import { detectManifest, readUpdatableManifests } from '../domain/manifest.ts';
import { generateBootstrapPRBody, generatePRBody, getUserOverride } from '../domain/pr-body.ts';
import { PlsError } from '../lib/error.ts';

export interface PrepResult {
  pr: PullRequest | null;
  bump: VersionBump | null;
  dryRun: boolean;
  bootstrap?: boolean;
  bootstrapVersion?: string;
}

export interface PrepOptions {
  baseBranch: string;
  releaseBranch: string;
  dryRun: boolean;
}

/**
 * Execute pls prep workflow.
 */
export async function prepWorkflow(
  repo: LocalRepo,
  host: CodeHost,
  options: PrepOptions,
): Promise<PrepResult> {
  const { baseBranch, releaseBranch, dryRun } = options;

  // 1. Read current state - bootstrap if no versions.json
  const versionsContent = await host.readFile('.pls/versions.json', baseBranch);
  if (!versionsContent) {
    return await bootstrapWorkflow(host, options);
  }

  const versions: VersionsManifest = JSON.parse(versionsContent);
  const currentVersion = versions['.']?.version;
  if (!currentVersion) {
    throw new PlsError(
      'No root version in .pls/versions.json',
      'NO_ROOT_VERSION',
    );
  }

  // 2. Find release point (tag revision or fallback)
  const releaseRev = await findReleaseRevision(repo, host, currentVersion);

  // 3. Get commits since release
  const allCommits = await repo.getCommitsSince(releaseRev);
  const commits = filterReleasableCommits(allCommits);

  if (commits.length === 0) {
    return { pr: null, bump: null, dryRun };
  }

  // 4. Calculate version bump
  const bump = calculateBump(currentVersion, commits);
  if (!bump) {
    return { pr: null, bump: null, dryRun };
  }

  // 5. Check for existing PR and preserve user's selection
  const existingPR = await host.findPR(releaseBranch);
  let selectedVersion = bump.to;

  if (existingPR) {
    const userOverride = getUserOverride(existingPR.body);
    if (userOverride) {
      selectedVersion = userOverride;
    }
  }

  // 6. Build release files
  const effectiveBump: VersionBump = { ...bump, to: selectedVersion };
  const changelogEntry = generateReleaseNotes(effectiveBump); // For CHANGELOG.md (with version header)
  const changelog = generateChangelog(effectiveBump); // For PR body (body only)

  const manifests = await readUpdatableManifests((p) => host.readFile(p, baseBranch));
  const existingChangelog = await host.readFile('CHANGELOG.md', baseBranch);

  // Get version file if configured
  let versionFile: { path: string; content: string } | null = null;
  const versionFilePath = versions['.']?.versionFile;
  if (versionFilePath) {
    const content = await host.readFile(versionFilePath, baseBranch);
    if (content) {
      versionFile = { path: versionFilePath, content };
    }
  }

  const { files, commitMessage } = buildReleaseFiles({
    version: selectedVersion,
    from: bump.from,
    type: bump.type,
    manifests,
    versionsJson: versionsContent,
    versionFile,
    changelog: changelogEntry,
    existingChangelog,
  });

  // 7. Generate PR body
  const prBody = generatePRBody(effectiveBump, changelog);
  const prTitle = `chore: release v${selectedVersion}`;

  if (dryRun) {
    return {
      pr: {
        number: 0,
        title: prTitle,
        body: prBody,
        branch: releaseBranch,
        url: '',
      },
      bump: effectiveBump,
      dryRun: true,
    };
  }

  // 8. Create commit and update branch
  const baseRev = await host.getBranchRevision(baseBranch);
  if (!baseRev) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  const commitRev = await host.commit(files, commitMessage, baseRev);
  await host.ensureBranch(releaseBranch, commitRev);

  // 9. Create or update PR
  let pr: PullRequest;

  if (existingPR) {
    await host.updatePR(existingPR.number, {
      title: prTitle,
      body: prBody,
    });
    pr = { ...existingPR, title: prTitle, body: prBody };
  } else {
    pr = await host.createPR({
      title: prTitle,
      body: prBody,
      head: releaseBranch,
      base: baseBranch,
    });
  }

  return { pr, bump: effectiveBump, dryRun: false };
}

/**
 * Find the revision for the current version.
 * Priority: tag → fallback commit search
 */
async function findReleaseRevision(
  repo: LocalRepo,
  host: CodeHost,
  version: string,
): Promise<string | null> {
  const tag = `v${version}`;

  // Try to get tag
  const releaseTag = await host.getTag(tag);

  if (releaseTag) {
    if (releaseTag.isPlsRelease) {
      return releaseTag.rev;
    }
    console.warn(`Tag ${tag} exists but is not a pls release tag`);
  }

  const rev = await repo.findCommitByContent(version, '.pls/versions.json');

  if (!rev) {
    // No tag, no commit found - this might be first release
    return null;
  }

  return rev;
}

/**
 * Bootstrap workflow - creates initialization PR when no versions.json exists.
 */
async function bootstrapWorkflow(
  host: CodeHost,
  options: PrepOptions,
): Promise<PrepResult> {
  const { baseBranch, releaseBranch, dryRun } = options;

  // 1. Detect project version from manifest (via GitHub API)
  const detected = await detectManifest((p) => host.readFile(p, baseBranch));

  if (!detected || !detected.version) {
    throw new PlsError(
      'Could not detect version from manifest.\n' +
        'Add "version" to your deno.json or package.json, or use `pls init --version=X.Y.Z`',
      'NO_VERSION_DETECTED',
    );
  }

  const version = detected.version;
  const manifest = detected.path;

  // 2. Build bootstrap files
  const files: FileChanges = new Map();
  const versionsContent = createInitialVersionsManifest(version);
  files.set('.pls/versions.json', versionsContent);

  const commitMessage = `chore: initialize pls at v${version}`;

  // 3. Generate PR content
  const prBody = generateBootstrapPRBody(version, manifest);
  const prTitle = `chore: initialize pls v${version}`;

  if (dryRun) {
    return {
      pr: {
        number: 0,
        title: prTitle,
        body: prBody,
        branch: releaseBranch,
        url: '',
      },
      bump: null,
      dryRun: true,
      bootstrap: true,
      bootstrapVersion: version,
    };
  }

  // 4. Create commit and branch
  const baseRev = await host.getBranchRevision(baseBranch);
  if (!baseRev) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  const commitRev = await host.commit(files, commitMessage, baseRev);
  await host.ensureBranch(releaseBranch, commitRev);

  // 5. Create or update PR
  const existingPR = await host.findPR(releaseBranch);
  let pr: PullRequest;

  if (existingPR) {
    await host.updatePR(existingPR.number, { title: prTitle, body: prBody });
    pr = { ...existingPR, title: prTitle, body: prBody };
  } else {
    pr = await host.createPR({
      title: prTitle,
      body: prBody,
      head: releaseBranch,
      base: baseBranch,
    });
  }

  return {
    pr,
    bump: null,
    dryRun: false,
    bootstrap: true,
    bootstrapVersion: version,
  };
}
