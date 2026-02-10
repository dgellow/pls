/**
 * Release files - build file contents for a release.
 *
 * Pure functions, no I/O.
 */

import type { FileChanges, ReleaseMetadata, VersionsManifest } from './types.ts';
import type { UpdatableManifest } from './manifest.ts';
import { updateManifestVersion } from './manifest.ts';
import { generateReleaseCommitMessage } from './release-metadata.ts';

const VERSION_MARKER = /@pls-version(?![ \t]+\w)/;
const SEMVER = /\d+\.\d+\.\d+(-[\w.]+)?/;

export interface BuildFilesInput {
  /** New version */
  version: string;
  /** Previous version */
  from: string;
  /** Bump type */
  type: 'major' | 'minor' | 'patch' | 'transition';
  /** Project manifests to update (deno.json, package.json, etc.) */
  manifests: UpdatableManifest[];
  /** Current versions.json content (if exists) */
  versionsJson: string | null;
  /** Current version file content (if exists) */
  versionFile: { path: string; content: string } | null;
  /** Changelog content to prepend */
  changelog: string;
  /** Existing CHANGELOG.md content (if exists) */
  existingChangelog: string | null;
}

export interface BuildFilesOutput {
  files: FileChanges;
  commitMessage: string;
}

/**
 * Build all files needed for a release.
 */
export function buildReleaseFiles(input: BuildFilesInput): BuildFilesOutput {
  const files: FileChanges = new Map();

  // 1. Update project manifests (deno.json, package.json, etc.)
  for (const manifest of input.manifests) {
    const updated = updateManifestVersion(manifest.path, manifest.content, input.version);
    files.set(manifest.path, updated);
  }

  // 2. Update .pls/versions.json
  const versionsJson = updateVersionsManifest(
    input.versionsJson,
    input.version,
  );
  files.set('.pls/versions.json', versionsJson);

  // 3. Update version file (if configured)
  if (input.versionFile) {
    const updated = updateVersionFile(input.versionFile.content, input.version);
    if (updated) {
      files.set(input.versionFile.path, updated);
    }
  }

  // 4. Update CHANGELOG.md
  const changelog = prependChangelog(input.existingChangelog, input.changelog);
  files.set('CHANGELOG.md', changelog);

  // Generate commit message
  const metadata: ReleaseMetadata = {
    version: input.version,
    from: input.from,
    type: input.type,
  };
  const commitMessage = generateReleaseCommitMessage(metadata);

  return { files, commitMessage };
}

/**
 * Update versions.json manifest.
 * Always uses object format: { ".": { "version": "x.y.z" } }
 */
export function updateVersionsManifest(
  content: string | null,
  version: string,
): string {
  const manifest: VersionsManifest = {};

  if (content) {
    try {
      const parsed = JSON.parse(content);
      // Convert any string values to object format
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          manifest[key] = { version: value };
        } else if (typeof value === 'object' && value !== null) {
          manifest[key] = value as VersionsManifest[string];
        }
      }
    } catch {
      // Invalid JSON, start fresh
    }
  }

  // Update root version (preserve versionFile if present)
  const existing = manifest['.'];
  manifest['.'] = {
    version,
    ...(existing?.versionFile && { versionFile: existing.versionFile }),
  };

  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Update version in file marked with @pls-version.
 * Replaces only the semver on the line after the marker.
 */
export function updateVersionFile(
  content: string,
  version: string,
): string | null {
  if (!VERSION_MARKER.test(content)) return null;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (VERSION_MARKER.test(lines[i]) && SEMVER.test(lines[i + 1])) {
      lines[i + 1] = lines[i + 1].replace(SEMVER, version);
      return lines.join('\n');
    }
  }
  return null;
}

/**
 * Prepend new changelog entry to existing changelog.
 */
export function prependChangelog(
  existing: string | null,
  newEntry: string,
): string {
  const header = '# Changelog\n\n';

  if (!existing) {
    return header + newEntry + '\n';
  }

  // Remove existing header if present
  let body = existing;
  if (body.startsWith('# Changelog')) {
    const headerEnd = body.indexOf('\n\n');
    body = headerEnd > 0 ? body.slice(headerEnd + 2) : '';
  }

  return header + newEntry + '\n\n' + body;
}

/**
 * Create initial versions.json for bootstrap.
 */
export function createInitialVersionsManifest(
  version: string,
  versionFile?: string,
): string {
  const manifest: VersionsManifest = {
    '.': {
      version,
      ...(versionFile && { versionFile }),
    },
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}
