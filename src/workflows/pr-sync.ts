/**
 * PR Sync Workflow - pls sync
 *
 * Syncs PR branch when user changes version selection.
 */

import type { CodeHost } from '../domain/vcs.ts';
import type { VersionsManifest } from '../domain/types.ts';
import { classifyStep, nextVersions } from '../domain/bump.ts';
import { extractChangelogEntry, retitleChangelogEntry } from '../domain/changelog.ts';
import { buildReleaseFiles } from '../domain/files.ts';
import { readUpdatableManifests } from '../domain/manifest.ts';
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
  host: CodeHost,
  options: SyncOptions,
): Promise<SyncResult> {
  const { prNumber, baseBranch } = options;

  // 1. Get PR details
  const pr = await host.getPR(prNumber);

  // 2. Parse selected version from body
  const selectedVersion = getSelectedVersion(pr.body);
  if (!selectedVersion) {
    return { synced: false, oldVersion: null, newVersion: null };
  }

  // 3. The version the release branch holds now. The branch is what gets
  // merged, so it decides whether there is anything to do. The PR title does
  // not: people reword titles.
  const branchVersionsContent = await host.readFile('.pls/versions.json', pr.branch);
  const branchVersion = branchVersionsContent
    ? (JSON.parse(branchVersionsContent) as VersionsManifest)['.']?.version ?? null
    : null;

  // 4. Check if already synced
  if (branchVersion === selectedVersion) {
    return {
      synced: false,
      oldVersion: branchVersion,
      newVersion: selectedVersion,
    };
  }

  // 5. Read current state from base branch
  const versionsContent = await host.readFile('.pls/versions.json', baseBranch);
  if (!versionsContent) {
    throw new PlsError('No .pls/versions.json found', 'NO_VERSIONS_MANIFEST');
  }

  const versions: VersionsManifest = JSON.parse(versionsContent);
  const fromVersion = versions['.']?.version;
  if (!fromVersion) {
    throw new PlsError('No root version found', 'NO_ROOT_VERSION');
  }

  // 6. The selection comes from the PR body, which anyone who can edit the PR
  // can change. Accept only a version pls would propose itself.
  const allowed = nextVersions(fromVersion);
  if (!allowed.includes(selectedVersion)) {
    throw new PlsError(
      `The release PR selects version "${selectedVersion}", which is not one release step ` +
        `from ${fromVersion}.\n` +
        `Versions pls accepts here: ${allowed.join(', ')}.\n` +
        `Edit the PR description: tick one of the listed options and remove any other change ` +
        `to the version list.`,
      'VERSION_NOT_ALLOWED',
      { selected: selectedVersion, from: fromVersion, allowed },
    );
  }

  // 7. Build files for new version
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

  // Determine bump type from selection
  const bumpType = determineBumpType(fromVersion, selectedVersion);

  // The changelog entry is the one `pls prep` wrote to the release branch,
  // under the new version's heading. Only the version changes here.
  const branchChangelog = await host.readFile('CHANGELOG.md', pr.branch);
  const entry = branchVersion && branchChangelog
    ? extractChangelogEntry(branchChangelog, branchVersion)
    : null;
  if (!entry) {
    throw new PlsError(
      `Cannot switch the release to ${selectedVersion}: CHANGELOG.md on "${pr.branch}" has no ` +
        `"## ${branchVersion ?? '<version>'}" entry to carry over.\n` +
        `Run "pls prep" (or push to ${baseBranch}) to rebuild the release PR, then select the ` +
        `version again.`,
      'CHANGELOG_ENTRY_NOT_FOUND',
      { branch: pr.branch, branchVersion, selected: selectedVersion },
    );
  }
  const changelog = retitleChangelogEntry(entry, selectedVersion);

  const { files, commitMessage } = buildReleaseFiles({
    version: selectedVersion,
    from: fromVersion,
    type: bumpType,
    manifests,
    versionsJson: versionsContent,
    versionFile,
    changelog,
    existingChangelog,
  });

  // 8. Create new commit from base branch
  const baseRev = await host.getBranchRevision(baseBranch);
  if (!baseRev) {
    throw new PlsError(`Base branch ${baseBranch} not found`, 'BRANCH_NOT_FOUND');
  }

  const commitRev = await host.commit(files, commitMessage, baseRev);

  // 9. Force update PR branch (single commit principle)
  await host.pointBranch(pr.branch, commitRev, true);

  // 10. Update PR title and body
  const newTitle = `chore: release v${selectedVersion}`;
  const newBody = updatePRBody(pr.body, selectedVersion);

  await host.updatePR(prNumber, {
    title: newTitle,
    body: newBody,
  });

  return {
    synced: true,
    oldVersion: branchVersion,
    newVersion: selectedVersion,
  };
}

/**
 * Determine bump type from version change.
 * Exported for testing.
 */
export function determineBumpType(
  from: string,
  to: string,
): 'major' | 'minor' | 'patch' | 'transition' {
  return classifyStep(from, to);
}
