/**
 * PR Create Workflow - pls prep
 *
 * Creates or updates a release PR.
 */

import type { GitHub } from '../clients/github.ts';
import type { LocalGit } from '../clients/local-git.ts';
import type { FileChanges, PullRequest, VersionBump, VersionsManifest } from '../domain/types.ts';
import { calculateBump } from '../domain/bump.ts';
import { filterReleasableCommits } from '../domain/commits.ts';
import { generateChangelog, generateReleaseNotes } from '../domain/changelog.ts';
import { buildReleaseFiles, createInitialVersionsManifest } from '../domain/files.ts';
import { detectManifest, readUpdatableManifests } from '../domain/manifest.ts';
import { generateBootstrapPRBody, generatePRBody, getSelectedVersion } from '../domain/pr-body.ts';
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
  git: LocalGit,
  github: GitHub,
  options: PrepOptions,
): Promise<PrepResult> {
  const { baseBranch, releaseBranch, dryRun } = options;

  // 1. Read current state - bootstrap if no versions.json
  const versionsContent = await github.readFile('.pls/versions.json', baseBranch);
  if (!versionsContent) {
    return await bootstrapWorkflow(github, options);
  }

  const versions: VersionsManifest = JSON.parse(versionsContent);
  const currentVersion = versions['.']?.version;
  if (!currentVersion) {
    throw new PlsError(
      'No root version in .pls/versions.json',
      'NO_ROOT_VERSION',
    );
  }

  // 2. Find release point (tag SHA or fallback)
  const releaseSha = await findReleaseSha(git, github, currentVersion);

  // 3. Get commits since release
  const allCommits = await git.getCommitsSince(releaseSha);
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
  const existingPR = await github.findPR(releaseBranch);
  let selectedVersion = bump.to;

  if (existingPR) {
    const userSelection = getSelectedVersion(existingPR.body);
    if (userSelection && userSelection !== bump.to) {
      selectedVersion = userSelection;
    }
  }

  // 6. Build release files
  const effectiveBump: VersionBump = { ...bump, to: selectedVersion };
  const changelogEntry = generateReleaseNotes(effectiveBump); // For CHANGELOG.md (with version header)
  const changelog = generateChangelog(effectiveBump); // For PR body (body only)

  const manifests = await readUpdatableManifests((p) => github.readFile(p, baseBranch));
  const existingChangelog = await github.readFile('CHANGELOG.md', baseBranch);

  // Get version file if configured
  let versionFile: { path: string; content: string } | null = null;
  const versionFilePath = versions['.']?.versionFile;
  if (versionFilePath) {
    const content = await github.readFile(versionFilePath, baseBranch);
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
  const baseSha = await github.getBranchSha(baseBranch);
  if (!baseSha) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  const commitSha = await github.commit(files, commitMessage, baseSha);
  await github.ensureBranch(releaseBranch, commitSha);

  // 9. Create or update PR
  let pr: PullRequest;

  if (existingPR) {
    await github.updatePR(existingPR.number, {
      title: prTitle,
      body: prBody,
    });
    pr = { ...existingPR, title: prTitle, body: prBody };
  } else {
    pr = await github.createPR({
      title: prTitle,
      body: prBody,
      head: releaseBranch,
      base: baseBranch,
    });
  }

  return { pr, bump: effectiveBump, dryRun: false };
}

/**
 * Find the SHA for the current version.
 * Priority: tag → fallback commit search
 */
async function findReleaseSha(
  git: LocalGit,
  github: GitHub,
  version: string,
): Promise<string | null> {
  const tag = `v${version}`;

  // Try to get tag
  const releaseTag = await github.getTag(tag);

  if (releaseTag) {
    // Verify it's a pls release tag (has our marker)
    if (releaseTag.isPlsRelease) {
      return releaseTag.sha;
    }
    // Tag exists but isn't ours - use fallback
    console.warn(`Tag ${tag} exists but is not a pls release tag`);
  }

  // Fallback: search for commit that introduced this version
  const sha = await git.findCommitByContent(version, '.pls/versions.json');

  if (!sha) {
    // No tag, no commit found - this might be first release
    return null;
  }

  return sha;
}

/**
 * Bootstrap workflow - creates initialization PR when no versions.json exists.
 */
async function bootstrapWorkflow(
  github: GitHub,
  options: PrepOptions,
): Promise<PrepResult> {
  const { baseBranch, releaseBranch, dryRun } = options;

  // 1. Detect project version from manifest (via GitHub API)
  const detected = await detectManifest((p) => github.readFile(p, baseBranch));

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
  const baseSha = await github.getBranchSha(baseBranch);
  if (!baseSha) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  const commitSha = await github.commit(files, commitMessage, baseSha);
  await github.ensureBranch(releaseBranch, commitSha);

  // 5. Create or update PR
  const existingPR = await github.findPR(releaseBranch);
  let pr: PullRequest;

  if (existingPR) {
    await github.updatePR(existingPR.number, { title: prTitle, body: prBody });
    pr = { ...existingPR, title: prTitle, body: prBody };
  } else {
    pr = await github.createPR({
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
