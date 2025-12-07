/**
 * Local filesystem backend using Deno file operations and git CLI.
 */

import { expandGlob } from '@std/fs';
import { relative } from '@std/path';
import type { CommitBackend } from './interface.ts';

export class LocalBackend implements CommitBackend {
  private pendingWrites: Map<string, string> = new Map();

  constructor(private root: string = Deno.cwd()) {}

  async read(path: string): Promise<string | null> {
    // Check pending writes first
    if (this.pendingWrites.has(path)) {
      return this.pendingWrites.get(path)!;
    }

    try {
      const fullPath = this.resolvePath(path);
      return await Deno.readTextFile(fullPath);
    } catch {
      return null;
    }
  }

  write(path: string, content: string): Promise<void> {
    this.pendingWrites.set(path, content);
    return Promise.resolve();
  }

  async exists(path: string): Promise<boolean> {
    if (this.pendingWrites.has(path)) {
      return true;
    }

    try {
      const fullPath = this.resolvePath(path);
      await Deno.stat(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async glob(pattern: string): Promise<string[]> {
    const results: string[] = [];
    const fullPattern = this.resolvePath(pattern);

    for await (const entry of expandGlob(fullPattern)) {
      if (entry.isFile) {
        results.push(relative(this.root, entry.path));
      }
    }

    return results;
  }

  /**
   * Flush pending writes to disk and create a git commit.
   */
  async commit(message: string): Promise<string> {
    // Write all pending files to disk
    for (const [path, content] of this.pendingWrites) {
      const fullPath = this.resolvePath(path);

      // Ensure parent directory exists
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      await Deno.mkdir(dir, { recursive: true }).catch(() => {});

      await Deno.writeTextFile(fullPath, content);
    }

    // Clear pending writes
    this.pendingWrites.clear();

    // Stage all changes
    await this.git('add', '-A');

    // Create commit
    await this.git('commit', '-m', message, '--allow-empty');

    // Get commit SHA
    const sha = await this.gitOutput('rev-parse', 'HEAD');
    return sha.trim();
  }

  async push(): Promise<void> {
    const result = await this.gitWithResult('push', 'origin', 'HEAD', '--follow-tags');
    if (!result.success) {
      console.warn(`Warning: Failed to push to remote: ${result.stderr}`);
    }
  }

  private resolvePath(path: string): string {
    if (path.startsWith('/')) return path;
    return `${this.root}/${path}`;
  }

  private async git(...args: string[]): Promise<void> {
    const command = new Deno.Command('git', {
      args,
      cwd: this.root,
    });
    const { code, stderr } = await command.output();

    if (code !== 0) {
      const error = new TextDecoder().decode(stderr);
      throw new Error(`git ${args[0]} failed: ${error}`);
    }
  }

  private async gitOutput(...args: string[]): Promise<string> {
    const command = new Deno.Command('git', {
      args,
      cwd: this.root,
    });
    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const error = new TextDecoder().decode(stderr);
      throw new Error(`git ${args[0]} failed: ${error}`);
    }

    return new TextDecoder().decode(stdout);
  }

  private async gitWithResult(
    ...args: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const command = new Deno.Command('git', {
      args,
      cwd: this.root,
    });
    const { code, stdout, stderr } = await command.output();

    return {
      success: code === 0,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }
}
