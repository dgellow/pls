import { join } from '@std/path';
import type { Manifest } from './interface.ts';

/**
 * Manifest handler for deno.json / deno.jsonc files.
 *
 * Preserves formatting by using regex replacement instead of
 * JSON.parse/stringify which would lose comments and formatting.
 */
export class DenoManifest implements Manifest {
  readonly type = 'deno';
  readonly path: string;
  private readonly root: string;

  constructor(root: string = Deno.cwd(), filename: string = 'deno.json') {
    this.root = root;
    this.path = filename;
  }

  private get fullPath(): string {
    return join(this.root, this.path);
  }

  async exists(): Promise<boolean> {
    try {
      await Deno.stat(this.fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const content = await Deno.readTextFile(this.fullPath);
      const parsed = JSON.parse(content);
      return parsed.version ?? null;
    } catch {
      return null;
    }
  }

  async setVersion(version: string): Promise<void> {
    const content = await Deno.readTextFile(this.fullPath);

    // Try to preserve formatting by using regex replacement
    const versionPattern = /("version"\s*:\s*)"[^"]*"/;

    let newContent: string;
    if (versionPattern.test(content)) {
      // Replace existing version
      newContent = content.replace(versionPattern, `$1"${version}"`);
    } else {
      // Add version field after opening brace
      // Find the first { and insert after it
      const parsed = JSON.parse(content);
      parsed.version = version;

      // Re-serialize with 2-space indent to match deno fmt
      newContent = JSON.stringify(parsed, null, 2) + '\n';
    }

    await Deno.writeTextFile(this.fullPath, newContent);
  }

  /**
   * Check if this is a workspace root (has "workspaces" field)
   */
  async isWorkspaceRoot(): Promise<boolean> {
    try {
      const content = await Deno.readTextFile(this.fullPath);
      const parsed = JSON.parse(content);
      return Array.isArray(parsed.workspace);
    } catch {
      return false;
    }
  }

  /**
   * Get workspace member paths if this is a workspace root
   */
  async getWorkspaceMembers(): Promise<string[]> {
    try {
      const content = await Deno.readTextFile(this.fullPath);
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.workspace)) {
        return parsed.workspace;
      }
      return [];
    } catch {
      return [];
    }
  }
}

/**
 * Create a DenoManifest, checking for both deno.json and deno.jsonc
 */
export async function createDenoManifest(root: string = Deno.cwd()): Promise<DenoManifest | null> {
  // Try deno.json first, then deno.jsonc
  for (const filename of ['deno.json', 'deno.jsonc']) {
    const manifest = new DenoManifest(root, filename);
    if (await manifest.exists()) {
      return manifest;
    }
  }
  return null;
}
