import { join } from '@std/path';
import { expandGlob } from '@std/fs';
import type { Manifest, ManifestInfo } from './interface.ts';
import { createDenoManifest, DenoManifest } from './deno.ts';
import { createNodeManifest, NodeManifest } from './node.ts';

export type ManifestType = 'deno' | 'node' | 'auto';

/**
 * Detect and create appropriate manifest for a directory
 */
export async function createManifest(
  root: string = Deno.cwd(),
  type: ManifestType = 'auto',
): Promise<Manifest | null> {
  if (type === 'deno') {
    return createDenoManifest(root);
  }

  if (type === 'node') {
    return createNodeManifest(root);
  }

  // Auto-detect: prefer deno.json over package.json
  const deno = await createDenoManifest(root);
  if (deno) return deno;

  return createNodeManifest(root);
}

/**
 * Detect all manifests in a directory (for projects with both deno.json and package.json)
 */
export async function detectManifests(root: string = Deno.cwd()): Promise<Manifest[]> {
  const manifests: Manifest[] = [];

  const deno = await createDenoManifest(root);
  if (deno) manifests.push(deno);

  const node = await createNodeManifest(root);
  if (node) manifests.push(node);

  return manifests;
}

/**
 * Get info about all detected manifests
 */
export async function getManifestInfo(root: string = Deno.cwd()): Promise<ManifestInfo[]> {
  const manifests = await detectManifests(root);
  const info: ManifestInfo[] = [];

  for (const m of manifests) {
    info.push({
      type: m.type,
      path: m.path,
      version: await m.getVersion(),
    });
  }

  return info;
}

/**
 * Workspace member with its manifest
 */
export interface WorkspaceMember {
  path: string;
  manifest: Manifest;
}

/**
 * Resolve workspace members from glob patterns
 */
async function resolveWorkspaceGlobs(
  root: string,
  patterns: string[],
): Promise<WorkspaceMember[]> {
  const members: WorkspaceMember[] = [];

  for (const pattern of patterns) {
    // If pattern doesn't have glob chars, treat as direct path
    if (!pattern.includes('*')) {
      const memberPath = join(root, pattern);
      const manifest = await createManifest(memberPath);
      if (manifest) {
        members.push({ path: pattern, manifest });
      }
      continue;
    }

    // Expand glob pattern
    for await (const entry of expandGlob(pattern, { root, includeDirs: true })) {
      if (!entry.isDirectory) continue;

      const manifest = await createManifest(entry.path);
      if (manifest) {
        // Get relative path from root
        const relativePath = entry.path.replace(root, '').replace(/^\//, '');
        members.push({ path: relativePath, manifest });
      }
    }
  }

  return members;
}

/**
 * Detect workspace configuration and return all member manifests
 */
export async function detectWorkspace(root: string = Deno.cwd()): Promise<{
  root: Manifest | null;
  members: WorkspaceMember[];
  isWorkspace: boolean;
}> {
  const rootManifest = await createManifest(root);
  if (!rootManifest) {
    return { root: null, members: [], isWorkspace: false };
  }

  // Check for workspace configuration
  let memberPatterns: string[] = [];

  if (rootManifest instanceof DenoManifest) {
    memberPatterns = await rootManifest.getWorkspaceMembers();
  } else if (rootManifest instanceof NodeManifest) {
    memberPatterns = await rootManifest.getWorkspaceMembers();
  }

  if (memberPatterns.length === 0) {
    // Not a workspace, just a single package
    return { root: rootManifest, members: [], isWorkspace: false };
  }

  // Resolve workspace members
  const members = await resolveWorkspaceGlobs(root, memberPatterns);

  return {
    root: rootManifest,
    members,
    isWorkspace: true,
  };
}

/**
 * Update version in all manifests (root + workspace members)
 */
export async function updateAllVersions(
  version: string,
  root: string = Deno.cwd(),
): Promise<{ updated: string[]; errors: Array<{ path: string; error: string }> }> {
  const workspace = await detectWorkspace(root);
  const updated: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  // Update root manifest
  if (workspace.root) {
    try {
      await workspace.root.setVersion(version);
      updated.push(workspace.root.path);
    } catch (e) {
      errors.push({
        path: workspace.root.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Update workspace members
  for (const member of workspace.members) {
    try {
      await member.manifest.setVersion(version);
      updated.push(join(member.path, member.manifest.path));
    } catch (e) {
      errors.push({
        path: join(member.path, member.manifest.path),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { updated, errors };
}
