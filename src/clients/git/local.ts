/**
 * Local git client - wraps git CLI commands.
 *
 * Implements LocalRepo, BranchSyncable, and RemoteDetectable from domain/vcs.ts.
 */

import { ensureDir } from '@std/fs';
import { dirname, join } from '@std/path';
import type { Commit } from '../../domain/types.ts';
import type { BranchSyncable, LocalRepo, RemoteDetectable } from '../../domain/vcs.ts';
import { parseGitLogWithParents } from './parse.ts';
import { PlsError } from '../../lib/error.ts';

export class LocalGit implements LocalRepo, BranchSyncable, RemoteDetectable {
  constructor(private cwd: string = Deno.cwd()) {}

  /**
   * Execute a git command and return stdout.
   */
  private async exec(args: string[]): Promise<string> {
    const command = new Deno.Command('git', {
      args,
      cwd: this.cwd,
      stdout: 'piped',
      stderr: 'piped',
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const error = new TextDecoder().decode(stderr);
      throw new PlsError(
        `Git command failed: git ${args.join(' ')}\n${error}`,
        'GIT_ERROR',
        { args, error },
      );
    }

    return new TextDecoder().decode(stdout).trim();
  }

  /**
   * Execute git command, returning null on failure instead of throwing.
   */
  private async execSafe(args: string[]): Promise<string | null> {
    try {
      return await this.exec(args);
    } catch {
      return null;
    }
  }

  // --- Reading ---

  async readFile(path: string): Promise<string | null> {
    try {
      const fullPath = join(this.cwd, path);
      return await Deno.readTextFile(fullPath);
    } catch {
      return null;
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const fullPath = join(this.cwd, path);
      await Deno.stat(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  // --- Git History ---

  async getCommitsSince(rev: string | null): Promise<Commit[]> {
    const range = rev ? `${rev}..HEAD` : 'HEAD';
    const format = '%H%n%P%n%B%n---commit---';

    const output = await this.execSafe(['log', range, `--format=${format}`]);
    if (!output) return [];

    return parseGitLogWithParents(output);
  }

  async getHeadRevision(): Promise<string> {
    return await this.exec(['rev-parse', 'HEAD']);
  }

  async getCommitMessage(ref: string): Promise<string> {
    return await this.exec(['log', '-1', '--format=%B', ref]);
  }

  // --- Tags ---

  async getTagRevision(tag: string): Promise<string | null> {
    // Get the commit revision the tag points to (dereference annotated tags)
    return await this.execSafe(['rev-list', '-1', tag]);
  }

  async getTagMessage(tag: string): Promise<string | null> {
    // Get annotated tag message
    return await this.execSafe(['tag', '-l', '--format=%(contents)', tag]);
  }

  async tagExists(tag: string): Promise<boolean> {
    const result = await this.execSafe(['tag', '-l', tag]);
    return result === tag;
  }

  // --- Writing ---

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = join(this.cwd, path);
    await ensureDir(dirname(fullPath));
    await Deno.writeTextFile(fullPath, content);
  }

  async commit(message: string): Promise<string> {
    // Stage all changes
    await this.exec(['add', '-A']);

    // Commit
    await this.exec(['commit', '-m', message]);

    // Return new HEAD revision
    return await this.getHeadRevision();
  }

  async createTag(name: string, message: string): Promise<void> {
    // Create annotated tag with message
    await this.exec(['tag', '-a', name, '-m', message]);
  }

  async push(ref: string): Promise<void> {
    await this.exec(['push', 'origin', ref]);
  }

  // --- Additional utilities ---

  /**
   * Check if a revision exists in the repository.
   */
  async revExists(rev: string): Promise<boolean> {
    const result = await this.execSafe(['cat-file', '-t', rev]);
    return result === 'commit';
  }

  /**
   * Search for commit that changed a file to contain a specific string.
   * Used for fallback revision detection when tag is missing.
   */
  async findCommitByContent(
    searchString: string,
    filePath: string,
  ): Promise<string | null> {
    const output = await this.execSafe([
      'log',
      '-S',
      searchString,
      '--format=%H',
      '--',
      filePath,
    ]);

    if (!output) return null;

    // Return first (most recent) match
    const lines = output.split('\n').filter((l) => l.trim());
    return lines[0] || null;
  }

  // --- RemoteDetectable ---

  async getRemoteInfo(): Promise<{ owner: string; repo: string } | null> {
    const url = await this.execSafe(['remote', 'get-url', 'origin']);
    if (!url) return null;

    // Parse GitHub URL
    const patterns = [
      /github\.com[:/]([^/]+)\/([^/.]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return { owner: match[1], repo: match[2] };
      }
    }

    return null;
  }

  // --- BranchSyncable ---

  async fetch(remote = 'origin'): Promise<void> {
    await this.exec(['fetch', remote]);
  }

  async checkoutBranch(branch: string, fromRef: string): Promise<void> {
    await this.exec(['checkout', '-B', branch, fromRef]);
  }

  async rebase(onto: string): Promise<boolean> {
    const result = await this.execSafe(['rebase', onto]);
    if (result === null) {
      // Rebase failed - abort
      await this.execSafe(['rebase', '--abort']);
      return false;
    }
    return true;
  }

  async pushForceWithLease(remote: string, branch: string): Promise<boolean> {
    const result = await this.execSafe(['push', '--force-with-lease', remote, branch]);
    return result !== null;
  }

  /**
   * Get current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    return await this.exec(['rev-parse', '--abbrev-ref', 'HEAD']);
  }
}
