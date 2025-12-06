import { join } from '@std/path';
import type { Manifest } from './interface.ts';

/**
 * Manifest handler for package.json files.
 *
 * Preserves formatting by using regex replacement.
 */
export class NodeManifest implements Manifest {
  readonly type = 'node';
  readonly path = 'package.json';
  private readonly root: string;

  constructor(root: string = Deno.cwd()) {
    this.root = root;
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
      // Add version field - need to re-serialize
      const parsed = JSON.parse(content);
      parsed.version = version;
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
      return Array.isArray(parsed.workspaces);
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
      if (Array.isArray(parsed.workspaces)) {
        return parsed.workspaces;
      }
      return [];
    } catch {
      return [];
    }
  }
}

/**
 * Create a NodeManifest if package.json exists
 */
export async function createNodeManifest(root: string = Deno.cwd()): Promise<NodeManifest | null> {
  const manifest = new NodeManifest(root);
  if (await manifest.exists()) {
    return manifest;
  }
  return null;
}
