import type { Commit, Release, Storage, VersionBump } from '../types.ts';
import { PlsError } from '../types.ts';
import { ensureFile } from '@std/fs';

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
      console.log(`📝 Updated CHANGELOG.md`);
    } catch (error) {
      // Don't fail the release if changelog update fails
      console.warn(`⚠️  Failed to update CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  generateReleaseNotes(bump: VersionBump): string {
    const { from, to, type, commits } = bump;
    const lines: string[] = [];

    lines.push(`## ${to}`);
    lines.push('');
    
    // Handle transition releases specially
    if (type === 'transition' as any) {
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
      feat: '✨ Features',
      fix: '🐛 Bug Fixes',
      docs: '📚 Documentation',
      style: '💎 Styles',
      refactor: '📦 Code Refactoring',
      perf: '🚀 Performance Improvements',
      test: '🚨 Tests',
      build: '🛠 Builds',
      ci: '⚙️ Continuous Integration',
      chore: '♻️ Chores',
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

  async createRelease(
    bump: VersionBump,
    sha: string,
    dryRun = false,
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
      console.log('🏷️  Dry run - would create release:');
      console.log(`   Version: ${release.version}`);
      console.log(`   Tag: ${release.tag}`);
      console.log(`   SHA: ${release.sha}`);
      console.log('');
      console.log('📝 Release Notes:');
      console.log(notes);
      return release;
    }

    try {
      // Create git tag locally
      const tagCommand = new Deno.Command('git', {
        args: ['tag', '-a', tag, '-m', `Release ${tag}`, sha],
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

      // Save release to storage
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
