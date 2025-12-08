/**
 * Semantic version parsing utilities.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null; // e.g., "alpha.0", "beta.1", "rc.2"
}

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/;

/**
 * Parse a semver string into components.
 */
export function parse(version: string): ParsedVersion | null {
  const match = version.match(SEMVER_REGEX);
  if (!match) return null;

  const [, major, minor, patch, stage, build] = match;
  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    prerelease: stage ? `${stage}.${build}` : null,
  };
}

/**
 * Format parsed version back to string.
 */
export function format(v: ParsedVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

/**
 * Get the prerelease stage (alpha, beta, rc) or null for stable.
 */
export function getStage(version: string): 'alpha' | 'beta' | 'rc' | 'stable' {
  if (version.includes('-alpha')) return 'alpha';
  if (version.includes('-beta')) return 'beta';
  if (version.includes('-rc')) return 'rc';
  return 'stable';
}

/**
 * Get base version without prerelease suffix.
 */
export function getBase(version: string): string {
  return version.split('-')[0];
}

/**
 * Bump version by type.
 */
export function bump(
  version: string,
  type: 'major' | 'minor' | 'patch',
): string {
  const parsed = parse(version);
  if (!parsed) {
    throw new Error(`Invalid version: ${version}`);
  }

  // Strip prerelease for bumping
  const base: ParsedVersion = { ...parsed, prerelease: null };

  switch (type) {
    case 'major':
      return format({ ...base, major: base.major + 1, minor: 0, patch: 0 });
    case 'minor':
      return format({ ...base, minor: base.minor + 1, patch: 0 });
    case 'patch':
      return format({ ...base, patch: base.patch + 1 });
  }
}

/**
 * Increment prerelease build number.
 * 1.0.0-alpha.0 → 1.0.0-alpha.1
 */
export function bumpPrerelease(version: string): string {
  const parsed = parse(version);
  if (!parsed || !parsed.prerelease) {
    throw new Error(`Not a prerelease version: ${version}`);
  }

  const [stage, buildStr] = parsed.prerelease.split('.');
  const build = parseInt(buildStr, 10);
  return format({ ...parsed, prerelease: `${stage}.${build + 1}` });
}

/**
 * Create prerelease version from stable.
 * 1.2.3 + minor + alpha → 1.3.0-alpha.0
 */
export function toPrerelease(
  version: string,
  bumpType: 'major' | 'minor' | 'patch',
  stage: 'alpha' | 'beta' | 'rc',
): string {
  const bumped = bump(version, bumpType);
  const parsed = parse(bumped);
  if (!parsed) throw new Error(`Invalid version: ${bumped}`);
  return format({ ...parsed, prerelease: `${stage}.0` });
}

/**
 * Transition to next stage.
 * alpha → beta → rc → stable
 */
export function transition(
  version: string,
  target: 'alpha' | 'beta' | 'rc' | 'stable',
): string {
  const parsed = parse(version);
  if (!parsed) throw new Error(`Invalid version: ${version}`);

  const base = getBase(version);

  if (target === 'stable') {
    return base;
  }

  return `${base}-${target}.0`;
}

/**
 * Compare two versions. Returns -1, 0, or 1.
 */
export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`Invalid versions: ${a}, ${b}`);

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // Both stable
  if (!pa.prerelease && !pb.prerelease) return 0;
  // Stable > prerelease
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;

  // Compare prerelease stages
  const stages = ['alpha', 'beta', 'rc'];
  const [stageA, buildA] = pa.prerelease.split('.');
  const [stageB, buildB] = pb.prerelease.split('.');

  const stageIdxA = stages.indexOf(stageA);
  const stageIdxB = stages.indexOf(stageB);
  if (stageIdxA !== stageIdxB) return stageIdxA - stageIdxB;

  return parseInt(buildA, 10) - parseInt(buildB, 10);
}
