/**
 * PR Release Workflow - pls release
 *
 * Creates tag and GitHub Release after PR merge.
 * Runs on every push to targetBranch for self-healing.
 */

import type { GitHub } from '../clients/github.ts';
import type { LocalGit } from '../clients/local-git.ts';
import type { VersionsManifest } from '../domain/types.ts';
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
}

/**
 * Execute pls release workflow.
 *
 * Self-healing: runs on every push, creates missing tags.
 */
export async function releaseWorkflow(
  git: LocalGit,
  github: GitHub,
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
      return {
        released: false,
        version: null,
        tag: null,
        url: null,
        alreadyExists: false,
        recovered: false,
      };
    }

    const versions: VersionsManifest = JSON.parse(versionsContent);
    version = versions['.']?.version;

    if (!version) {
      return {
        released: false,
        version: null,
        tag: null,
        url: null,
        alreadyExists: false,
        recovered: false,
      };
    }

    // Try to determine from/type from tag history
    fromVersion = await findPreviousVersion(github, version);
    bumpType = 'patch'; // Default, actual type unknown
  }

  const tag = `v${version}`;

  // 2. Check if tag already exists
  const existingTag = await github.getTag(tag);
  if (existingTag?.isPlsRelease) {
    // Already released
    const releaseExists = await github.releaseExists(tag);
    return {
      released: false,
      version,
      tag,
      url: null,
      alreadyExists: true,
      recovered: false,
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

  // 4. Generate tag message
  const commits = await git.getCommitsSince(null); // Get recent commits for changelog
  const relevantCommits = filterReleasableCommits(commits).slice(0, 50);
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
        released: false,
        version,
        tag,
        url: null,
        alreadyExists: true,
        recovered: false,
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

  return {
    released: true,
    version,
    tag,
    url: releaseUrl,
    alreadyExists: false,
    recovered,
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
