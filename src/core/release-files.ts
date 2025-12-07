/**
 * Unified file update logic for releases.
 *
 * This module handles updating all files needed for a release:
 * - deno.json / package.json (manifest files)
 * - .pls/versions.json
 * - version_info.ts (TypeScript version file)
 *
 * It works with any CommitBackend, allowing the same logic to be used for:
 * - Direct local releases (via LocalBackend)
 * - PR-based releases (via GitHubBackend)
 */

import type { CommitBackend } from '../backend/mod.ts';
import { generateReleaseCommitMessage } from './release-metadata.ts';

const VERSION_MAGIC_PATTERN = /^\/\/ @pls-version\s*$/m;
const VERSION_PATTERN = /^export const VERSION = ["'][^"']+["'];?$/m;

export interface ReleaseFilesOptions {
  version: string;
  from: string;
  type: 'major' | 'minor' | 'patch' | 'transition';
}

export interface UpdateResult {
  updatedFiles: string[];
  commitSha?: string;
}

/**
 * Stage all release file updates without committing.
 * Call backend.commit() separately if needed.
 */
export async function stageReleaseFiles(
  backend: CommitBackend,
  version: string,
): Promise<string[]> {
  const updatedFiles: string[] = [];

  // 1. Update root manifest (deno.json or package.json)
  const manifestUpdated = await updateManifest(backend, version);
  if (manifestUpdated) {
    updatedFiles.push(manifestUpdated);
  }

  // 2. Update workspace members (if any)
  const workspaceMembers = await getWorkspaceMembers(backend);
  for (const memberPath of workspaceMembers) {
    const memberManifest = await updateManifest(backend, version, memberPath);
    if (memberManifest) {
      updatedFiles.push(memberManifest);
    }
  }

  // 3. Update .pls/versions.json
  await updateVersionsManifest(backend, version, workspaceMembers);
  updatedFiles.push('.pls/versions.json');

  // 4. Update TypeScript version file (if configured)
  const versionFile = await updateVersionFile(backend, version);
  if (versionFile) {
    updatedFiles.push(versionFile);
  }

  return updatedFiles;
}

/**
 * Update all release files and commit using the provided backend.
 */
export async function updateReleaseFiles(
  backend: CommitBackend,
  options: ReleaseFilesOptions,
): Promise<UpdateResult> {
  const updatedFiles = await stageReleaseFiles(backend, options.version);

  // Create commit
  const commitMessage = generateReleaseCommitMessage({
    version: options.version,
    from: options.from,
    type: options.type,
  });

  const commitSha = await backend.commit(commitMessage);

  return { updatedFiles, commitSha };
}

/**
 * Update manifest file (deno.json or package.json).
 */
async function updateManifest(
  backend: CommitBackend,
  version: string,
  basePath: string = '',
): Promise<string | null> {
  const prefix = basePath ? `${basePath}/` : '';

  // Try deno.json first
  const denoJsonPath = `${prefix}deno.json`;
  const denoContent = await backend.read(denoJsonPath);
  if (denoContent) {
    try {
      const manifest = JSON.parse(denoContent);
      manifest.version = version;
      await backend.write(denoJsonPath, JSON.stringify(manifest, null, 2) + '\n');
      return denoJsonPath;
    } catch {
      // Invalid JSON, skip
    }
  }

  // Try package.json
  const packageJsonPath = `${prefix}package.json`;
  const packageContent = await backend.read(packageJsonPath);
  if (packageContent) {
    try {
      const manifest = JSON.parse(packageContent);
      manifest.version = version;
      await backend.write(packageJsonPath, JSON.stringify(manifest, null, 2) + '\n');
      return packageJsonPath;
    } catch {
      // Invalid JSON, skip
    }
  }

  return null;
}

/**
 * Get workspace member paths from root manifest.
 */
async function getWorkspaceMembers(backend: CommitBackend): Promise<string[]> {
  const denoContent = await backend.read('deno.json');
  if (!denoContent) return [];

  try {
    const manifest = JSON.parse(denoContent);
    const workspace = manifest.workspace || [];

    // Filter out glob patterns and normalize paths
    return workspace
      .filter((pattern: string) => !pattern.includes('*'))
      .map((path: string) => path.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

/**
 * Update .pls/versions.json with new version for all packages.
 */
async function updateVersionsManifest(
  backend: CommitBackend,
  version: string,
  workspaceMembers: string[],
): Promise<void> {
  let versions: Record<string, unknown> = {};

  // Read existing versions.json
  const content = await backend.read('.pls/versions.json');
  if (content) {
    try {
      const parsed = JSON.parse(content);
      // Preserve existing fields (like versionFile) but update version
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'object' && value !== null) {
          versions[key] = { ...value as object, version };
        } else {
          versions[key] = version;
        }
      }
    } catch {
      // Invalid JSON, start fresh
    }
  }

  // Update root version (preserving versionFile if present)
  if (typeof versions['.'] === 'object' && versions['.'] !== null) {
    (versions['.'] as Record<string, unknown>).version = version;
  } else {
    versions['.'] = version;
  }

  // Update workspace members
  for (const memberPath of workspaceMembers) {
    if (typeof versions[memberPath] === 'object' && versions[memberPath] !== null) {
      (versions[memberPath] as Record<string, unknown>).version = version;
    } else {
      versions[memberPath] = version;
    }
  }

  await backend.write('.pls/versions.json', JSON.stringify(versions, null, 2) + '\n');
}

/**
 * Update TypeScript version file if configured in versions.json.
 */
async function updateVersionFile(
  backend: CommitBackend,
  version: string,
): Promise<string | null> {
  // Check if versionFile is configured in versions.json
  const versionsContent = await backend.read('.pls/versions.json');
  if (!versionsContent) return null;

  try {
    const versions = JSON.parse(versionsContent);
    const rootEntry = versions['.'];

    if (!rootEntry || typeof rootEntry !== 'object') return null;

    const versionFilePath = (rootEntry as Record<string, unknown>).versionFile;
    if (typeof versionFilePath !== 'string') return null;

    // Read and update the version file
    const content = await backend.read(versionFilePath);
    if (!content) return null;

    // Verify it has the magic comment
    if (!VERSION_MAGIC_PATTERN.test(content)) return null;

    // Update the VERSION constant
    const updatedContent = content.replace(
      VERSION_PATTERN,
      `export const VERSION = '${version}';`,
    );

    if (updatedContent === content) return null;

    await backend.write(versionFilePath, updatedContent);
    return versionFilePath;
  } catch {
    return null;
  }
}
