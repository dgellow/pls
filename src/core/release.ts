import type { Commit, Release, Storage, VersionBump } from '../types.ts';
import { PlsError } from '../types.ts';
import { ensureFile } from '@std/fs';
import { updateAllVersions } from '../manifest/mod.ts';
import { setVersion as setVersionsManifest } from '../versions/mod.ts';

export type TagStrategy = 'github' | 'git';

export class ReleaseManager {
  constructor(private storage: Storage) {}

  private async updateChangelog(release: Release): Promise<void> {
    const changelogPath = 'CHANGELOG.md';

    try {
      // Ensure file exists
      await ensureFile(changelogPath);

      // Read existing content
      let existingContent = '';
      try {
        existingContent = await Deno.readTextFile(changelogPath);
      } catch {
        // File is empty or doesn't exist, that's fine
      }

      // Generate release section with date
      const date = release.createdAt.toISOString().split('T')[0];
      // Remove version header from notes since we're adding it with date
      const notesWithoutHeader = release.notes?.replace(/^## \d+\.\d+\.\d+.*\n\n/, '') || '';
      const releaseSection = `## ${release.version} (${date})\n\n${notesWithoutHeader}\n`;

      // Prepare new content
      let newContent: string;
      if (!existingContent || existingContent.trim() === '') {
        // Create new changelog
        newContent = `# Changelog\n\n${releaseSection}`;
      } else if (existingContent.startsWith('# Changelog')) {
        // Insert after header - find the first empty line after header
        const headerEndIndex = existingContent.indexOf('\n\n');
        if (headerEndIndex > -1) {
          const beforeHeader = existingContent.substring(0, headerEndIndex + 2);
          const afterHeader = existingContent.substring(headerEndIndex + 2);
          newContent = `${beforeHeader}${releaseSection}\n${afterHeader}`;
        } else {
          newContent = `${existingContent}\n\n${releaseSection}`;
        }
      } else {
        // No header, add it
        newContent = `# Changelog\n\n${releaseSection}\n${existingContent}`;
      }

      // Write back
      await Deno.writeTextFile(changelogPath, newContent);
      console.log(`Updated CHANGELOG.md`);
    } catch (error) {
      // Don't fail the release if changelog update fails
      console.warn(
        `Warning: Failed to update CHANGELOG.md: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  generateReleaseNotes(bump: VersionBump): string {
    const { from, to, type, commits } = bump;
    const lines: string[] = [];

    lines.push(`## ${to}`);
    lines.push('');

    // Handle transition releases specially
    if (type === 'transition') {
      lines.push(`Version transition from ${from} to ${to}`);
      lines.push('');
      return lines.join('\n').trim();
    }

    // Group commits by type
    const groups = new Map<string, Commit[]>();
    const otherCommits: Commit[] = [];

    for (const commit of commits) {
      const match = commit.message.match(/^(\w+)(?:\([^)]+\))?!?:/);
      if (match) {
        const type = match[1];
        if (!groups.has(type)) {
          groups.set(type, []);
        }
        groups.get(type)!.push(commit);
      } else {
        otherCommits.push(commit);
      }
    }

    // Add grouped commits
    const typeOrder = [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
    ];
    const typeLabels: Record<string, string> = {
      feat: 'Features',
      fix: 'Bug Fixes',
      docs: 'Documentation',
      style: 'Styles',
      refactor: 'Code Refactoring',
      perf: 'Performance Improvements',
      test: 'Tests',
      build: 'Builds',
      ci: 'Continuous Integration',
      chore: 'Chores',
    };

    for (const type of typeOrder) {
      const commits = groups.get(type);
      if (!commits || commits.length === 0) continue;

      lines.push(`### ${typeLabels[type] || type}`);
      lines.push('');

      for (const commit of commits) {
        const message = commit.message.replace(/^\w+(\([^)]+\))?!?:\s*/, '');
        lines.push(`- ${message} (${commit.sha.substring(0, 7)})`);
      }
      lines.push('');
    }

    // Add other commits if any
    if (otherCommits.length > 0) {
      lines.push('### Other Changes');
      lines.push('');
      for (const commit of otherCommits) {
        lines.push(`- ${commit.message} (${commit.sha.substring(0, 7)})`);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  private async updateManifests(version: string, dryRun: boolean): Promise<void> {
    if (dryRun) {
      // In dry-run, just detect what would be updated without modifying
      const { detectWorkspace } = await import('../manifest/factory.ts');
      const workspace = await detectWorkspace();
      const wouldUpdate: string[] = [];

      if (workspace.root) {
        wouldUpdate.push(workspace.root.path);
      }
      for (const member of workspace.members) {
        wouldUpdate.push(`${member.path}/${member.manifest.path}`);
      }

      if (wouldUpdate.length > 0) {
        console.log(`Would update version in: ${wouldUpdate.join(', ')}`);
      }
      console.log(`Would update .pls/versions.json`);
      return;
    }

    const result = await updateAllVersions(version);

    if (result.updated.length > 0) {
      console.log(`Updated version in: ${result.updated.join(', ')}`);
    }

    for (const error of result.errors) {
      console.warn(`Warning: Failed to update ${error.path}: ${error.error}`);
    }

    // Note: .pls/versions.json is updated after commit with SHA in createRelease
    console.log(`Updated manifest versions`);
  }

  /**
   * Create a release from an existing release commit.
   * This is used when a release PR is merged - the commit already has the correct
   * version in the manifest files, so we just need to create the tag and GitHub release.
   * This prevents the double-bump bug where the version gets recalculated.
   */
  async createReleaseFromCommit(
    version: string,
    sha: string,
    dryRun = false,
    tagStrategy: TagStrategy = 'github',
    notes?: string,
  ): Promise<Release> {
    const tag = `v${version}`;

    const release: Release = {
      version,
      tag,
      sha,
      createdAt: new Date(),
      notes: notes || `Release ${version}`,
    };

    if (dryRun) {
      console.log('Dry run - would create release:');
      console.log(`  Version: ${release.version}`);
      console.log(`  Tag: ${release.tag}`);
      console.log(`  SHA: ${release.sha}`);
      if (notes) {
        console.log('');
        console.log('Release Notes:');
        console.log(notes);
      }
      return release;
    }

    try {
      if (tagStrategy === 'git') {
        // Create tag locally using git CLI
        const tagCommand = new Deno.Command('git', {
          args: ['tag', '-a', tag, '-m', `Release ${tag}`],
        });
        const { code, stderr } = await tagCommand.output();

        if (code !== 0) {
          const error = new TextDecoder().decode(stderr);
          throw new PlsError(
            `Failed to create git tag: ${error}`,
            'GIT_TAG_ERROR',
          );
        }

        // Push tag to remote
        const pushCommand = new Deno.Command('git', {
          args: ['push', 'origin', tag],
        });
        const pushResult = await pushCommand.output();

        if (pushResult.code !== 0) {
          const error = new TextDecoder().decode(pushResult.stderr);
          console.warn(`Warning: Failed to push tag to remote: ${error}`);
        }
      }

      // Save release to storage (creates GitHub release, and tag if using github strategy)
      await this.storage.saveRelease(release);

      return release;
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to create release: ${error instanceof Error ? error.message : String(error)}`,
        'RELEASE_ERROR',
        error,
      );
    }
  }

  async createRelease(
    bump: VersionBump,
    sha: string,
    dryRun = false,
    tagStrategy: TagStrategy = 'github',
  ): Promise<Release> {
    const tag = `v${bump.to}`;
    const notes = this.generateReleaseNotes(bump);

    const release: Release = {
      version: bump.to,
      tag,
      sha,
      createdAt: new Date(),
      notes,
    };

    if (dryRun) {
      console.log('Dry run - would create release:');
      console.log(`  Version: ${release.version}`);
      console.log(`  Tag: ${release.tag}`);
      console.log(`  SHA: ${release.sha}`);
      console.log('');

      // Show what manifests would be updated
      await this.updateManifests(bump.to, true);

      console.log('');
      console.log('Release Notes:');
      console.log(notes);
      return release;
    }

    try {
      // Update version in manifest files first
      await this.updateManifests(bump.to, false);

      // Commit manifest changes
      const addCommand = new Deno.Command('git', {
        args: ['add', '-A'],
      });
      await addCommand.output();

      const commitCommand = new Deno.Command('git', {
        args: ['commit', '-m', `chore: release ${tag}`, '--allow-empty'],
      });
      await commitCommand.output();

      // Get the new commit SHA (after release commit)
      const shaCommand = new Deno.Command('git', {
        args: ['rev-parse', 'HEAD'],
      });
      const shaResult = await shaCommand.output();
      if (shaResult.code === 0) {
        release.sha = new TextDecoder().decode(shaResult.stdout).trim();
      }

      // Update .pls/versions.json with version AND SHA, then amend commit
      await setVersionsManifest(bump.to, '.', Deno.cwd(), release.sha);
      console.log(`Updated .pls/versions.json`);

      await new Deno.Command('git', { args: ['add', '.pls/versions.json'] }).output();
      await new Deno.Command('git', {
        args: ['commit', '--amend', '--no-edit'],
      }).output();

      // Update SHA again after amend
      const amendedShaResult = await new Deno.Command('git', {
        args: ['rev-parse', 'HEAD'],
      }).output();
      if (amendedShaResult.code === 0) {
        release.sha = new TextDecoder().decode(amendedShaResult.stdout).trim();
      }

      if (tagStrategy === 'git') {
        // Create tag locally using git CLI
        const tagCommand = new Deno.Command('git', {
          args: ['tag', '-a', tag, '-m', `Release ${tag}`],
        });
        const { code, stderr } = await tagCommand.output();

        if (code !== 0) {
          const error = new TextDecoder().decode(stderr);
          throw new PlsError(
            `Failed to create git tag: ${error}`,
            'GIT_TAG_ERROR',
          );
        }

        // Push commit and tag to remote
        const pushCommand = new Deno.Command('git', {
          args: ['push', 'origin', 'HEAD', '--follow-tags'],
        });
        const pushResult = await pushCommand.output();

        if (pushResult.code !== 0) {
          const error = new TextDecoder().decode(pushResult.stderr);
          console.warn(`Warning: Failed to push to remote: ${error}`);
        }
      } else {
        // Push commit only (tag will be created by storage.saveRelease via API)
        const pushCommand = new Deno.Command('git', {
          args: ['push', 'origin', 'HEAD'],
        });
        const pushResult = await pushCommand.output();

        if (pushResult.code !== 0) {
          const error = new TextDecoder().decode(pushResult.stderr);
          console.warn(`Warning: Failed to push to remote: ${error}`);
        }
      }

      // Save release to storage (creates GitHub release, and tag if using github strategy)
      await this.storage.saveRelease(release);

      // Update CHANGELOG.md
      await this.updateChangelog(release);

      return release;
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to create release: ${error instanceof Error ? error.message : String(error)}`,
        'RELEASE_ERROR',
        error,
      );
    }
  }
}
