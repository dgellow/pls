import { format, increment, parse } from '@std/semver';
import type { Commit, VersionBump } from '../types.ts';
import { PlsError } from '../types.ts';

export interface ConventionalCommit {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
}

export class Version {
  private parseConventionalCommit(message: string): ConventionalCommit | null {
    // Basic conventional commit regex
    // Format: type(scope)!: description
    const match = message.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)/);

    if (!match) {
      return null;
    }

    const [, type, scope, breaking, description] = match;

    return {
      type,
      scope: scope || undefined,
      breaking: !!breaking || message.includes('BREAKING CHANGE:'),
      description,
    };
  }

  determineBumpType(commits: Commit[]): 'major' | 'minor' | 'patch' | null {
    if (commits.length === 0) {
      return null;
    }

    let hasBreaking = false;
    let hasFeature = false;
    let hasFix = false;

    for (const commit of commits) {
      const parsed = this.parseConventionalCommit(commit.message);
      if (!parsed) continue;

      if (parsed.breaking) {
        hasBreaking = true;
        break; // Major bump takes precedence
      }

      if (parsed.type === 'feat') {
        hasFeature = true;
      } else if (parsed.type === 'fix') {
        hasFix = true;
      }
    }

    if (hasBreaking) return 'major';
    if (hasFeature) return 'minor';
    if (hasFix) return 'patch';

    // Default to patch for any other changes
    return 'patch';
  }

  async getCurrentVersion(): Promise<string | null> {
    // Try to read from package.json if it exists
    try {
      const packageJson = await Deno.readTextFile('package.json');
      const pkg = JSON.parse(packageJson);
      if (pkg.version) {
        return pkg.version;
      }
    } catch {
      // Not a Node.js project, that's fine
    }

    // Try to read from deno.json
    try {
      const denoJson = await Deno.readTextFile('deno.json');
      const config = JSON.parse(denoJson);
      if (config.version) {
        return config.version;
      }
    } catch {
      // No deno.json or no version field
    }

    return null;
  }

  calculateNextVersion(
    currentVersion: string,
    bumpType: 'major' | 'minor' | 'patch',
  ): string {
    try {
      const parsed = parse(currentVersion);
      const incremented = increment(parsed, bumpType);
      return format(incremented);
    } catch (error) {
      throw new PlsError(
        `Invalid version format: ${currentVersion}`,
        'VERSION_PARSE_ERROR',
        error,
      );
    }
  }

  async determineVersionBump(
    lastVersion: string | null,
    commits: Commit[],
  ): Promise<VersionBump | null> {
    const bumpType = this.determineBumpType(commits);
    if (!bumpType) {
      return null;
    }

    // Get current version from files or use last release version
    let fromVersion = lastVersion;
    if (!fromVersion) {
      fromVersion = await this.getCurrentVersion();
    }

    if (!fromVersion) {
      // Default to 0.0.0 if no version found
      fromVersion = '0.0.0';
    }

    const toVersion = this.calculateNextVersion(fromVersion, bumpType);

    return {
      from: fromVersion,
      to: toVersion,
      type: bumpType,
      commits,
    };
  }
}
