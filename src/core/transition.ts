import { format, increment, parse, SemVer } from '@std/semver';
import { PlsError } from '../types.ts';

export type PrereleaseType = 'alpha' | 'beta' | 'rc';
export type TransitionTarget = PrereleaseType | 'stable';
export type VersionBumpType = 'major' | 'minor' | 'patch';

export class VersionTransition {
  /**
   * Parse version and extract base version without prerelease
   */
  private getBaseVersion(version: string): SemVer {
    const parsed = parse(version);
    // Return version without prerelease
    return {
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: [],
      build: [],
    };
  }

  /**
   * Check if version has prerelease
   */
  private isPrerelease(version: string): boolean {
    const parsed = parse(version);
    return parsed.prerelease !== undefined && parsed.prerelease.length > 0;
  }

  /**
   * Get current prerelease type if any
   */
  private getPrereleaseType(version: string): PrereleaseType | null {
    const parsed = parse(version);
    if (!parsed.prerelease || parsed.prerelease.length === 0) return null;
    
    const prereleaseStr = String(parsed.prerelease[0]);
    if (prereleaseStr === 'alpha') return 'alpha';
    if (prereleaseStr === 'beta') return 'beta';
    if (prereleaseStr === 'rc') return 'rc';
    
    return null;
  }

  /**
   * Transition version to new target
   */
  transition(
    currentVersion: string,
    target: TransitionTarget,
    bumpType?: VersionBumpType,
  ): string {
    try {
      const parsed = parse(currentVersion);
      const isCurrentlyPrerelease = this.isPrerelease(currentVersion);

      // Transitioning to stable
      if (target === 'stable') {
        if (!isCurrentlyPrerelease) {
          throw new PlsError(
            'Already on stable version. Use normal release flow.',
            'INVALID_TRANSITION',
          );
        }
        // Simply remove prerelease suffix
        const base = this.getBaseVersion(currentVersion);
        return format(base);
      }

      // Transitioning to prerelease
      if (isCurrentlyPrerelease) {
        // Already in prerelease, transition to new prerelease type
        const base = this.getBaseVersion(currentVersion);
        return format({
          ...base,
          prerelease: [target, 0],
        });
      } else {
        // From stable to prerelease, need to bump version
        const base = this.getBaseVersion(currentVersion);
        const bumpedBase = increment(base, bumpType || 'minor');
        
        return format({
          ...bumpedBase,
          prerelease: [target, 0],
        });
      }
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to transition version: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSITION_ERROR',
        error,
      );
    }
  }

  /**
   * Get next version based on current state
   * In prerelease: increment build number
   * In stable: follow conventional commits
   */
  getNextVersion(
    currentVersion: string,
    conventionalBumpType: VersionBumpType | null,
  ): string | null {
    const isCurrentlyPrerelease = this.isPrerelease(currentVersion);

    if (isCurrentlyPrerelease) {
      // In prerelease, always increment build number
      const parsed = parse(currentVersion);
      if (!parsed.prerelease || parsed.prerelease.length === 0) {
        throw new PlsError(
          'Invalid prerelease version format',
          'INVALID_PRERELEASE',
        );
      }
      const prereleaseType = parsed.prerelease[0];
      const currentBuild = Number(parsed.prerelease[1]) || 0;
      
      return format({
        ...this.getBaseVersion(currentVersion),
        prerelease: [prereleaseType, currentBuild + 1],
      });
    } else {
      // In stable, follow conventional commits
      if (!conventionalBumpType) return null;
      
      const parsed = parse(currentVersion);
      const bumped = increment(parsed, conventionalBumpType);
      return format(bumped);
    }
  }
}