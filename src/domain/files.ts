/**
 * Release files - build file contents for a release.
 *
 * Pure functions, no I/O.
 */

import type { FileChanges, ReleaseMetadata, VersionsManifest } from './types.ts';
import { generateReleaseCommitMessage } from './release-metadata.ts';

const VERSION_MAGIC_PATTERN = /^\/\/ @pls-version\s*$/m;
const VERSION_EXPORT_PATTERN = /^export const VERSION = ['"][^'"]+['"];?$/m;

export interface BuildFilesInput {
  /** New version */
  version: string;
  /** Previous version */
  from: string;
  /** Bump type */
  type: 'major' | 'minor' | 'patch' | 'transition';
  /** Current deno.json content (if exists) */
  denoJson: string | null;
  /** Current package.json content (if exists) */
  packageJson: string | null;
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

  // 1. Update deno.json
  if (input.denoJson) {
    const updated = updateJsonVersion(input.denoJson, input.version);
    files.set('deno.json', updated);
  }

  // 2. Update package.json
  if (input.packageJson) {
    const updated = updateJsonVersion(input.packageJson, input.version);
    files.set('package.json', updated);
  }

  // 3. Update .pls/versions.json
  const versionsJson = updateVersionsManifest(
    input.versionsJson,
    input.version,
  );
  files.set('.pls/versions.json', versionsJson);

  // 4. Update version file (if configured)
  if (input.versionFile) {
    const updated = updateVersionFile(input.versionFile.content, input.version);
    if (updated) {
      files.set(input.versionFile.path, updated);
    }
  }

  // 5. Update CHANGELOG.md
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
 * Update version in JSON file (deno.json or package.json).
 */
export function updateJsonVersion(content: string, version: string): string {
  try {
    const json = JSON.parse(content);
    json.version = version;
    return JSON.stringify(json, null, 2) + '\n';
  } catch {
    // If parsing fails, return original
    return content;
  }
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
 * Update TypeScript version file.
 * Only updates if file has // @pls-version magic comment.
 */
export function updateVersionFile(
  content: string,
  version: string,
): string | null {
  if (!VERSION_MAGIC_PATTERN.test(content)) {
    return null;
  }

  return content.replace(
    VERSION_EXPORT_PATTERN,
    `export const VERSION = '${version}';`,
  );
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

/**
 * Extract version from deno.json or package.json content.
 */
export function extractVersionFromManifest(content: string): string | null {
  try {
    const json = JSON.parse(content);
    return json.version || null;
  } catch {
    return null;
  }
}
