/**
 * Local Release Workflow - pls (direct release, no PR)
 *
 * For developers who want to release directly without a PR.
 */

import type { LocalGit } from '../clients/local-git.ts';
import type { VersionBump, VersionsManifest } from '../domain/types.ts';
import { calculateBump } from '../domain/bump.ts';
import { filterReleasableCommits } from '../domain/commits.ts';
import { generateChangelog } from '../domain/changelog.ts';
import { buildReleaseFiles } from '../domain/files.ts';
import { generateReleaseTagMessage } from '../domain/release-metadata.ts';
import * as semver from '../lib/semver.ts';
import { PlsError } from '../lib/error.ts';

export interface LocalReleaseResult {
  released: boolean;
  version: string | null;
  tag: string | null;
  bump: VersionBump | null;
  dryRun: boolean;
}

export interface LocalReleaseOptions {
  dryRun: boolean;
  push: boolean;
}

/**
 * Execute local release workflow.
 */
export async function localReleaseWorkflow(
  git: LocalGit,
  options: LocalReleaseOptions,
): Promise<LocalReleaseResult> {
  const { dryRun, push } = options;

  // 1. Read current state
  const versionsContent = await git.readFile('.pls/versions.json');
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

  // 2. Find release point
  const tag = `v${currentVersion}`;
  const releaseSha = await git.getTagSha(tag);

  // 3. Get commits since release
  const allCommits = await git.getCommitsSince(releaseSha);
  const commits = filterReleasableCommits(allCommits);

  if (commits.length === 0) {
    return {
      released: false,
      version: null,
      tag: null,
      bump: null,
      dryRun,
    };
  }

  // 4. Calculate version bump
  const bump = calculateBump(currentVersion, commits);
  if (!bump) {
    return {
      released: false,
      version: null,
      tag: null,
      bump: null,
      dryRun,
    };
  }

  // 5. Build release files
  const changelog = generateChangelog(bump);

  const denoJson = await git.readFile('deno.json');
  const packageJson = await git.readFile('package.json');
  const existingChangelog = await git.readFile('CHANGELOG.md');

  // Get version file if configured
  let versionFile: { path: string; content: string } | null = null;
  const versionFilePath = versions['.']?.versionFile;
  if (versionFilePath) {
    const content = await git.readFile(versionFilePath);
    if (content) {
      versionFile = { path: versionFilePath, content };
    }
  }

  const { files, commitMessage } = buildReleaseFiles({
    version: bump.to,
    from: bump.from,
    type: bump.type,
    denoJson,
    packageJson,
    versionsJson: versionsContent,
    versionFile,
    changelog,
    existingChangelog,
  });

  if (dryRun) {
    return {
      released: false,
      version: bump.to,
      tag: `v${bump.to}`,
      bump,
      dryRun: true,
    };
  }

  // 6. Write files
  for (const [path, content] of files) {
    await git.writeFile(path, content);
  }

  // 7. Commit
  await git.commit(commitMessage);

  // 8. Create tag
  const newTag = `v${bump.to}`;
  const tagMessage = generateReleaseTagMessage(
    { version: bump.to, from: bump.from, type: bump.type },
    `## Changes\n${changelog}`,
  );
  await git.createTag(newTag, tagMessage);

  // 9. Push if requested
  if (push) {
    await git.push('HEAD');
    await git.push(newTag);
  }

  return {
    released: true,
    version: bump.to,
    tag: newTag,
    bump,
    dryRun: false,
  };
}

/**
 * Execute transition workflow (pls transition).
 */
export async function transitionWorkflow(
  git: LocalGit,
  target: 'alpha' | 'beta' | 'rc' | 'stable',
  bumpType: 'major' | 'minor' | 'patch',
  options: LocalReleaseOptions,
): Promise<LocalReleaseResult> {
  const { dryRun, push } = options;

  // 1. Read current version
  const versionsContent = await git.readFile('.pls/versions.json');
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

  // 2. Calculate transition
  const currentStage = semver.getStage(currentVersion);
  let newVersion: string;

  if (currentStage === 'stable' && target !== 'stable') {
    // Stable → prerelease: bump first, then add suffix
    newVersion = semver.toPrerelease(currentVersion, bumpType, target);
  } else {
    // Prerelease → prerelease or stable
    newVersion = semver.transition(currentVersion, target);
  }

  const bump: VersionBump = {
    from: currentVersion,
    to: newVersion,
    type: 'patch', // Transitions are always "transition" type semantically
    commits: [],
  };

  // 3. Build release files
  const changelog = `Transition to ${target}: ${currentVersion} → ${newVersion}`;

  const denoJson = await git.readFile('deno.json');
  const packageJson = await git.readFile('package.json');
  const existingChangelog = await git.readFile('CHANGELOG.md');

  let versionFile: { path: string; content: string } | null = null;
  const versionFilePath = versions['.']?.versionFile;
  if (versionFilePath) {
    const content = await git.readFile(versionFilePath);
    if (content) {
      versionFile = { path: versionFilePath, content };
    }
  }

  const { files, commitMessage } = buildReleaseFiles({
    version: newVersion,
    from: currentVersion,
    type: 'transition',
    denoJson,
    packageJson,
    versionsJson: versionsContent,
    versionFile,
    changelog,
    existingChangelog,
  });

  if (dryRun) {
    return {
      released: false,
      version: newVersion,
      tag: `v${newVersion}`,
      bump,
      dryRun: true,
    };
  }

  // 4. Write files
  for (const [path, content] of files) {
    await git.writeFile(path, content);
  }

  // 5. Commit
  await git.commit(commitMessage);

  // 6. Create tag
  const newTag = `v${newVersion}`;
  const tagMessage = generateReleaseTagMessage(
    { version: newVersion, from: currentVersion, type: 'transition' },
    changelog,
  );
  await git.createTag(newTag, tagMessage);

  // 7. Push if requested
  if (push) {
    await git.push('HEAD');
    await git.push(newTag);
  }

  return {
    released: true,
    version: newVersion,
    tag: newTag,
    bump,
    dryRun: false,
  };
}
