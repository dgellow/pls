/**
 * PR Create Workflow - pls prep
 *
 * Creates or updates a release PR.
 */

import type { CodeHost, LocalRepo } from '../domain/vcs.ts';
import type { FileChanges, PullRequest, VersionBump, VersionsManifest } from '../domain/types.ts';
import { calculateBump, classifyStep, nextVersions } from '../domain/bump.ts';
import { filterReleasableCommits } from '../domain/commits.ts';
import { generateChangelog, generateReleaseNotes } from '../domain/changelog.ts';
import {
  buildReleaseFiles,
  createInitialVersionsManifest,
  requireVersionFile,
} from '../domain/files.ts';
import { detectManifest, readUpdatableManifests } from '../domain/manifest.ts';
import { generateBootstrapPRBody, generatePRBody, getUserOverride } from '../domain/pr-body.ts';
import { PlsError } from '../lib/error.ts';
import { findForeignCommits, reportDiscardedCommits } from './release-branch.ts';

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
  // The release is prepared for one commit of the base branch. If the branch
  // moves while this runs (another push landed), the result would describe an
  // older state and overwrite the newer run's release PR. So the branch is
  // checked again just before writing, and the release prepared again for the
  // new tip if it moved.
  for (let attempt = 1;; attempt++) {
    const result = await prepareOnce(repo, host, options);
    if (result !== 'base-moved') return result;

    if (attempt === MAX_ATTEMPTS) {
      throw new PlsError(
        `${options.baseBranch} moved ${MAX_ATTEMPTS} times while the release PR was being ` +
          `prepared, so it was not updated.\n` +
          `Run "pls prep" again once the pushes have settled; ` +
          `the run for the latest push also updates it.`,
        'BASE_BRANCH_MOVING',
        { baseBranch: options.baseBranch, attempts: MAX_ATTEMPTS },
      );
    }
  }
}

const MAX_ATTEMPTS = 3;

/**
 * Prepare the release for the current tip of the base branch.
 * Returns 'base-moved' without writing if the tip changed in the meantime.
 */
async function prepareOnce(
  repo: LocalRepo,
  host: CodeHost,
  options: PrepOptions,
): Promise<PrepResult | 'base-moved'> {
  const { baseBranch, releaseBranch, dryRun } = options;

  // The commit everything below is read from and built on.
  const baseRev = await host.getBranchRevision(baseBranch);
  if (!baseRev) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  // 1. Read current state - bootstrap if no versions.json
  const versionsContent = await host.readFile('.pls/versions.json', baseRev);
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
  const headRev = await repo.getHeadRevision();
  const allCommits = await repo.getCommitsSince(
    releaseRev,
    baseRev === headRev ? undefined : baseRev,
  );
  const commits = filterReleasableCommits(allCommits);

  if (commits.length === 0) {
    return { pr: null, bump: null, dryRun };
  }

  // 4. Calculate version bump
  const bump = calculateBump(currentVersion, commits);
  if (!bump) {
    return { pr: null, bump: null, dryRun };
  }

  // 5. Check for existing PR and preserve a version a person chose there.
  // The PR body is text anyone with access can edit, so the choice is kept
  // only if it is a version pls would propose itself.
  const existingPR = await host.findPR(releaseBranch);
  let chosenVersion: string | null = null;

  if (existingPR) {
    const userOverride = getUserOverride(existingPR.body);
    if (userOverride && userOverride !== bump.to) {
      if (nextVersions(currentVersion).includes(userOverride)) {
        chosenVersion = userOverride;
      } else {
        console.warn(
          `⚠️  The release PR selects ${userOverride}, which is not one release step ` +
            `from ${currentVersion}. Ignoring it and proposing ${bump.to}.`,
        );
      }
    }
  }

  const selectedVersion = chosenVersion ?? bump.to;

  // 6. Build release files
  const effectiveBump: VersionBump = {
    ...bump,
    to: selectedVersion,
    type: chosenVersion ? releaseTypeOf(bump, chosenVersion) : bump.type,
  };
  const changelogEntry = generateReleaseNotes(effectiveBump); // For CHANGELOG.md (with version header)
  const changelog = generateChangelog(effectiveBump); // For PR body (body only)

  const manifests = await readUpdatableManifests((p) => host.readFile(p, baseRev));
  const existingChangelog = await host.readFile('CHANGELOG.md', baseRev);

  // Get version file if configured
  const versionFilePath = versions['.']?.versionFile;
  const versionFile = requireVersionFile(
    versionFilePath,
    versionFilePath ? await host.readFile(versionFilePath, baseRev) : null,
  );

  const { files, commitMessage } = buildReleaseFiles({
    version: selectedVersion,
    from: bump.from,
    type: chosenVersion ? classifyStep(bump.from, chosenVersion) : bump.type,
    manifests,
    versionsJson: versionsContent,
    versionFile,
    changelog: changelogEntry,
    existingChangelog,
  });

  // 7. Generate PR body
  const prBody = generatePRBody(bump, changelog, chosenVersion);
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

  // 8. Create the commit. Nothing refers to it yet, so this changes nothing
  // anyone can see.
  const commitRev = await host.commit(files, commitMessage, baseRev);

  // The base branch must still be where this run read it. Checked as late as
  // possible: what follows is two requests.
  const tip = await host.getBranchRevision(baseBranch);
  if (tip !== baseRev) {
    console.warn(
      `⚠️  ${baseBranch} moved from ${baseRev.slice(0, 7)} to ${tip?.slice(0, 7) ?? 'nothing'} ` +
        `while the release was being prepared. Preparing it again for the new commit.`,
    );
    return 'base-moved';
  }

  // Commits someone pushed to the release branch are about to be replaced.
  const discarded = existingPR ? await findForeignCommits(host, baseBranch, releaseBranch) : [];

  await host.ensureBranch(releaseBranch, commitRev);

  // 9. Create or update PR
  let pr: PullRequest;

  if (existingPR) {
    await host.updatePR(existingPR.number, {
      title: prTitle,
      body: prBody,
    });
    await reportDiscardedCommits(host, existingPR.number, baseBranch, discarded);
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
 * The bump type to report for a chosen version. A prerelease keeps the
 * calculated type (VersionBump has no "transition").
 */
function releaseTypeOf(bump: VersionBump, chosenVersion: string): VersionBump['type'] {
  const step = classifyStep(bump.from, chosenVersion);
  return step === 'transition' ? bump.type : step;
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
