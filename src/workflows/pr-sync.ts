/**
 * PR Sync Workflow - pls sync
 *
 * Syncs PR branch when user changes version selection.
 */

import type { GitHub } from '../clients/github.ts';
import type { VersionsManifest } from '../domain/types.ts';
import { buildReleaseFiles } from '../domain/files.ts';
import { generateChangelog } from '../domain/changelog.ts';
import { getSelectedVersion, updatePRBody } from '../domain/pr-body.ts';
import { PlsError } from '../lib/error.ts';

export interface SyncResult {
  synced: boolean;
  oldVersion: string | null;
  newVersion: string | null;
}

export interface SyncOptions {
  prNumber: number;
  baseBranch: string;
}

/**
 * Execute pls sync workflow.
 */
export async function syncWorkflow(
  github: GitHub,
  options: SyncOptions,
): Promise<SyncResult> {
  const { prNumber, baseBranch } = options;

  // 1. Get PR details
  const pr = await github.getPR(prNumber);

  // 2. Parse selected version from body
  const selectedVersion = getSelectedVersion(pr.body);
  if (!selectedVersion) {
    return { synced: false, oldVersion: null, newVersion: null };
  }

  // 3. Extract current version from title
  const titleMatch = pr.title.match(/v(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/);
  const currentTitleVersion = titleMatch ? titleMatch[1] : null;

  // 4. Check if already synced
  if (currentTitleVersion === selectedVersion) {
    return {
      synced: false,
      oldVersion: currentTitleVersion,
      newVersion: selectedVersion,
    };
  }

  // 5. Read current state from base branch
  const versionsContent = await github.readFile('.pls/versions.json', baseBranch);
  if (!versionsContent) {
    throw new PlsError('No .pls/versions.json found', 'NO_VERSIONS_MANIFEST');
  }

  const versions: VersionsManifest = JSON.parse(versionsContent);
  const fromVersion = versions['.']?.version;
  if (!fromVersion) {
    throw new PlsError('No root version found', 'NO_ROOT_VERSION');
  }

  // 6. Build files for new version
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

  // Determine bump type from selection
  const bumpType = determineBumpType(fromVersion, selectedVersion);

  // Generate minimal changelog for sync
  const changelog = `Version changed from ${fromVersion} to ${selectedVersion}`;

  const { files, commitMessage } = buildReleaseFiles({
    version: selectedVersion,
    from: fromVersion,
    type: bumpType,
    denoJson,
    packageJson,
    versionsJson: versionsContent,
    versionFile,
    changelog,
    existingChangelog,
  });

  // 7. Create new commit from base branch
  const baseSha = await github.getBranchSha(baseBranch);
  if (!baseSha) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  const commitSha = await github.commit(files, commitMessage, baseSha);

  // 8. Force update PR branch (single commit principle)
  await github.pointBranch(pr.branch, commitSha, true);

  // 9. Update PR title and body
  const newTitle = `chore: release v${selectedVersion}`;
  const newBody = updatePRBody(pr.body, selectedVersion);

  await github.updatePR(prNumber, {
    title: newTitle,
    body: newBody,
  });

  return {
    synced: true,
    oldVersion: currentTitleVersion,
    newVersion: selectedVersion,
  };
}

/**
 * Determine bump type from version change.
 */
function determineBumpType(
  from: string,
  to: string,
): 'major' | 'minor' | 'patch' | 'transition' {
  // Check for prerelease
  if (to.includes('-')) {
    return 'transition';
  }

  const [fromMajor, fromMinor] = from.split('-')[0].split('.').map(Number);
  const [toMajor, toMinor] = to.split('.').map(Number);

  if (toMajor > fromMajor) return 'major';
  if (toMinor > fromMinor) return 'minor';
  return 'patch';
}
