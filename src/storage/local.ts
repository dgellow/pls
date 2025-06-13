import { ensureDir } from '@std/fs';
import { join } from '@std/path';
import type { Release, Storage, StorageOptions } from '../types.ts';
import { PlsError } from '../types.ts';

const STATE_FILE = 'state.json';

interface LocalState {
  lastRelease: Release | null;
  releases: Release[];
}

export class LocalStorage implements Storage {
  private stateDir: string;

  constructor(_options: StorageOptions = {}) {
    this.stateDir = '.pls';
  }

  private async getRepoRoot(): Promise<string> {
    try {
      const command = new Deno.Command('git', {
        args: ['rev-parse', '--show-toplevel'],
      });
      const { code, stdout } = await command.output();
      
      if (code !== 0) {
        // Not in a git repo, use current directory
        return Deno.cwd();
      }
      
      return new TextDecoder().decode(stdout).trim();
    } catch {
      // Git not available, use current directory
      return Deno.cwd();
    }
  }

  private async ensureStateDir(): Promise<void> {
    const repoRoot = await this.getRepoRoot();
    const fullStateDir = join(repoRoot, this.stateDir);
    await ensureDir(fullStateDir);
  }

  private async getStatePath(): Promise<string> {
    const repoRoot = await this.getRepoRoot();
    return join(repoRoot, this.stateDir, STATE_FILE);
  }

  private async readState(): Promise<LocalState> {
    await this.ensureStateDir();
    const statePath = await this.getStatePath();

    try {
      const content = await Deno.readTextFile(statePath);
      const state = JSON.parse(content);

      // Convert date strings back to Date objects
      if (state.lastRelease) {
        state.lastRelease.createdAt = new Date(state.lastRelease.createdAt);
      }
      if (state.releases) {
        state.releases = state.releases.map((r: Release & { createdAt: string }) => ({
          ...r,
          createdAt: new Date(r.createdAt),
        }));
      }

      return state;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { lastRelease: null, releases: [] };
      }
      throw new PlsError(
        `Failed to read local state: ${error instanceof Error ? error.message : String(error)}`,
        'LOCAL_READ_ERROR',
        error,
      );
    }
  }

  private async writeState(state: LocalState): Promise<void> {
    await this.ensureStateDir();
    const statePath = await this.getStatePath();

    try {
      const content = JSON.stringify(state, null, 2);
      await Deno.writeTextFile(statePath, content);
    } catch (error) {
      throw new PlsError(
        `Failed to write local state: ${error instanceof Error ? error.message : String(error)}`,
        'LOCAL_WRITE_ERROR',
        error,
      );
    }
  }

  async getLastRelease(): Promise<Release | null> {
    const state = await this.readState();
    return state.lastRelease;
  }

  async saveRelease(release: Release): Promise<void> {
    const state = await this.readState();

    // Update last release
    state.lastRelease = release;

    // Add to releases list (avoiding duplicates)
    const existingIndex = state.releases.findIndex((r) => r.version === release.version);
    if (existingIndex >= 0) {
      state.releases[existingIndex] = release;
    } else {
      state.releases.push(release);
    }

    // Sort releases by version (newest first)
    state.releases.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    await this.writeState(state);
  }

  async listReleases(): Promise<Release[]> {
    const state = await this.readState();
    return state.releases;
  }
}
