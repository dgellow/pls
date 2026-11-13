/**
 * Version bump calculation - determine next version from commits.
 *
 * Pure functions, no I/O.
 */

import type { Commit, VersionBump } from './types.ts';
import * as semver from '../lib/semver.ts';

/**
 * Determine bump type from commits.
 *
 * Rules:
 * - Any breaking change → major
 * - Any feat → minor
 * - Otherwise → patch
 */
export function determineBumpType(
  commits: Commit[],
  currentVersion?: string,
): 'major' | 'minor' | 'patch' | null {
  if (commits.length === 0) return null;

  const hasBreaking = commits.some((c) => c.breaking);
  if (hasBreaking) {
    // Pre-1.0: breaking changes bump minor, not major (semver spec)
    if (currentVersion) {
      const parsed = semver.parse(currentVersion);
      if (parsed && parsed.major === 0) return 'minor';
    }
    return 'major';
  }

  const hasFeature = commits.some((c) => c.type === 'feat');
  if (hasFeature) return 'minor';

  // Any other commit type triggers patch
  return 'patch';
}

/**
 * Calculate the next version based on commits.
 *
 * Special handling for prereleases:
 * - In prerelease: increment build number (alpha.0 → alpha.1)
 * - Commits don't affect prerelease version type
 */
export function calculateBump(
  currentVersion: string,
  commits: Commit[],
): VersionBump | null {
  const bumpType = determineBumpType(commits, currentVersion);
  if (!bumpType) return null;

  const stage = semver.getStage(currentVersion);

  let nextVersion: string;
  if (stage !== 'stable') {
    // In prerelease: just increment build number
    nextVersion = semver.bumpPrerelease(currentVersion);
  } else {
    // Stable: apply bump type
    nextVersion = semver.bump(currentVersion, bumpType);
  }

  return {
    from: currentVersion,
    to: nextVersion,
    type: bumpType,
    commits,
  };
}

/**
 * Calculate transition bump (for pls transition command).
 */
export function calculateTransition(
  currentVersion: string,
  target: 'alpha' | 'beta' | 'rc' | 'stable',
  bumpType: 'major' | 'minor' | 'patch' = 'minor',
): { from: string; to: string } {
  const currentStage = semver.getStage(currentVersion);

  let nextVersion: string;

  if (currentStage === 'stable' && target !== 'stable') {
    // Stable → prerelease: bump first, then add suffix
    nextVersion = semver.toPrerelease(currentVersion, bumpType, target);
  } else {
    // Prerelease → prerelease or stable: just transition
    nextVersion = semver.transition(currentVersion, target);
  }

  return { from: currentVersion, to: nextVersion };
}

/**
 * Every version that is one release step away from `from`.
 *
 * From a stable version: a patch, minor or major bump, as a stable release or
 * as the first alpha, beta or rc of it. From a prerelease: its next build, the
 * first build of a later stage, or the stable version.
 *
 * A version outside this list is not something pls proposes, so it is not
 * accepted from text a person can edit (the release PR body).
 */
export function nextVersions(from: string): string[] {
  const stage = semver.getStage(from);

  if (stage === 'stable') {
    const versions: string[] = [];
    for (const type of ['patch', 'minor', 'major'] as const) {
      const base = semver.bump(from, type);
      versions.push(base, `${base}-alpha.0`, `${base}-beta.0`, `${base}-rc.0`);
    }
    return versions;
  }

  const base = semver.getBase(from);
  const stages = ['alpha', 'beta', 'rc'];
  const versions = [semver.bumpPrerelease(from)];
  for (const later of stages.slice(stages.indexOf(stage) + 1)) {
    versions.push(`${base}-${later}.0`);
  }
  versions.push(base);
  return versions;
}

/**
 * Classify the step between two versions for release metadata.
 */
export function classifyStep(
  from: string,
  to: string,
): 'major' | 'minor' | 'patch' | 'transition' {
  // To or from a prerelease
  if (to.includes('-') || from.includes('-')) {
    return 'transition';
  }

  const [fromMajor, fromMinor] = from.split('.').map(Number);
  const [toMajor, toMinor] = to.split('.').map(Number);

  if (toMajor > fromMajor) return 'major';
  if (toMinor > fromMinor) return 'minor';
  return 'patch';
}
