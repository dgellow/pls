/**
 * Version file management for TypeScript projects.
 *
 * Handles scanning for and updating version.ts files that contain
 * a version constant marked with the magic comment `// @pls-version`.
 *
 * Example version file:
 * ```typescript
 * // @pls-version
 * export const VERSION = "1.2.3";
 * ```
 */

import { walk } from '@std/fs';
import { join, relative } from '@std/path';
import { getVersionFile, setVersionFile } from '../versions/mod.ts';

// Regex to detect magic comment on its own line (not as a string constant)
const VERSION_MAGIC_PATTERN = /^\/\/ @pls-version\s*$/m;
const VERSION_PATTERN = /^export const VERSION = ["']([^"']+)["'];?$/m;

export interface VersionFileResult {
  path: string;
  version: string;
}

/**
 * Scan for a version file containing the magic comment.
 * Searches in src/**\/*.ts by default.
 */
export async function scanForVersionFile(
  root: string = Deno.cwd(),
): Promise<string | null> {
  const srcDir = join(root, 'src');

  try {
    await Deno.stat(srcDir);
  } catch {
    // No src directory, skip scanning
    return null;
  }

  for await (
    const entry of walk(srcDir, {
      exts: ['.ts'],
      skip: [/_test\.ts$/, /\.test\.ts$/],
    })
  ) {
    if (!entry.isFile) continue;

    try {
      const content = await Deno.readTextFile(entry.path);
      if (VERSION_MAGIC_PATTERN.test(content)) {
        return relative(root, entry.path);
      }
    } catch {
      // Skip files we can't read
      continue;
    }
  }

  return null;
}

/**
 * Read version from a version file.
 */
export async function readVersionFile(
  filePath: string,
  root: string = Deno.cwd(),
): Promise<string | null> {
  const fullPath = join(root, filePath);

  try {
    const content = await Deno.readTextFile(fullPath);
    if (!VERSION_MAGIC_PATTERN.test(content)) {
      return null;
    }

    const match = content.match(VERSION_PATTERN);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Update the version in a version file.
 */
export async function updateVersionFile(
  filePath: string,
  newVersion: string,
  root: string = Deno.cwd(),
): Promise<boolean> {
  const fullPath = join(root, filePath);

  try {
    const content = await Deno.readTextFile(fullPath);
    if (!VERSION_MAGIC_PATTERN.test(content)) {
      return false;
    }

    const newContent = content.replace(
      VERSION_PATTERN,
      `export const VERSION = "${newVersion}";`,
    );

    if (newContent === content) {
      // No change needed or pattern didn't match
      return false;
    }

    await Deno.writeTextFile(fullPath, newContent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the version file path for a package, checking:
 * 1. .pls/versions.json[path].versionFile (cached/configured)
 * 2. Scan for magic comment (and cache if found, unless dryRun)
 *
 * Returns null if no version file is configured or found.
 */
export async function resolveVersionFile(
  packagePath: string = '.',
  root: string = Deno.cwd(),
  dryRun: boolean = false,
): Promise<string | null> {
  // 1. Check if already configured in versions.json
  const configured = await getVersionFile(packagePath, root);
  if (configured) {
    return configured;
  }

  // 2. Scan for magic comment
  const found = await scanForVersionFile(root);
  if (found) {
    // Lock it in to versions.json for future runs (skip in dry-run)
    if (!dryRun) {
      await setVersionFile(found, packagePath, root);
    }
    return found;
  }

  return null;
}

/**
 * Update version file as part of a release.
 * Resolves the file path and updates if found.
 * Returns the path that was updated, or null if no version file.
 */
export async function syncVersionFile(
  newVersion: string,
  packagePath: string = '.',
  root: string = Deno.cwd(),
): Promise<string | null> {
  const versionFilePath = await resolveVersionFile(packagePath, root);
  if (!versionFilePath) {
    return null;
  }

  const updated = await updateVersionFile(versionFilePath, newVersion, root);
  return updated ? versionFilePath : null;
}
