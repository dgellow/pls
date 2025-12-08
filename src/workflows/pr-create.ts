/**
 * PR Create Workflow - pls prep
 *
 * Creates or updates a release PR.
 */

import type { GitHub } from '../clients/github.ts';
import type { LocalGit } from '../clients/local-git.ts';
import type { PullRequest, VersionBump, VersionsManifest } from '../domain/types.ts';
import { calculateBump } from '../domain/bump.ts';
import { filterReleasableCommits } from '../domain/commits.ts';
import { generateChangelog } from '../domain/changelog.ts';
import { buildReleaseFiles } from '../domain/files.ts';
import { generatePRBody, getSelectedVersion } from '../domain/pr-body.ts';
import { PlsError } from '../lib/error.ts';

export interface PrepResult {
  pr: PullRequest | null;
  bump: VersionBump | null;
  dryRun: boolean;
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

  // 1. Read current state
  const versionsContent = await github.readFile('.pls/versions.json', baseBranch);
  if (!versionsContent) {
    throw new PlsError(
      'No .pls/versions.json found. Run `pls init` first.',
      'NO_VERSIONS_MANIFEST',
    );
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
  const changelog = generateChangelog(effectiveBump);

  const denoJson = await github.readFile('deno.json', baseBranch);
  const packageJson = await github.readFile('package.json', baseBranch);
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
    denoJson,
    packageJson,
    versionsJson: versionsContent,
    versionFile,
    changelog,
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
