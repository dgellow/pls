import { ensureDir } from '@std/fs';
import { dirname, join } from '@std/path';

const VERSIONS_FILE = '.pls/versions.json';

export interface VersionEntry {
  version: string;
  sha?: string;
}

export interface VersionsManifest {
  [path: string]: string | VersionEntry;
}

/**
 * Get version string from entry (handles both old string format and new object format)
 */
function getVersionFromEntry(entry: string | VersionEntry): string {
  return typeof entry === 'string' ? entry : entry.version;
}

/**
 * Get SHA from entry if available
 */
function getShaFromEntry(entry: string | VersionEntry): string | undefined {
  return typeof entry === 'string' ? undefined : entry.sha;
}

/**
 * Read the versions manifest file.
 * Returns empty object if file doesn't exist.
 */
export async function readVersions(root: string = Deno.cwd()): Promise<VersionsManifest> {
  const filePath = join(root, VERSIONS_FILE);
  try {
    const content = await Deno.readTextFile(filePath);
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write the versions manifest file.
 * Creates .pls directory if it doesn't exist.
 */
export async function writeVersions(
  versions: VersionsManifest,
  root: string = Deno.cwd(),
): Promise<void> {
  const filePath = join(root, VERSIONS_FILE);
  await ensureDir(dirname(filePath));
  const content = JSON.stringify(versions, null, 2) + '\n';
  await Deno.writeTextFile(filePath, content);
}

/**
 * Get version for a specific path (use "." for root package).
 */
export async function getVersion(
  path: string = '.',
  root: string = Deno.cwd(),
): Promise<string | null> {
  const versions = await readVersions(root);
  const entry = versions[path];
  if (!entry) return null;
  return getVersionFromEntry(entry);
}

/**
 * Get SHA for a specific path (use "." for root package).
 */
export async function getSha(
  path: string = '.',
  root: string = Deno.cwd(),
): Promise<string | null> {
  const versions = await readVersions(root);
  const entry = versions[path];
  if (!entry) return null;
  return getShaFromEntry(entry) ?? null;
}

/**
 * Set version for a specific path.
 */
export async function setVersion(
  version: string,
  path: string = '.',
  root: string = Deno.cwd(),
  sha?: string,
): Promise<void> {
  const versions = await readVersions(root);
  if (sha) {
    versions[path] = { version, sha };
  } else {
    // Keep existing SHA if present, or use simple format
    const existing = versions[path];
    const existingSha = existing ? getShaFromEntry(existing) : undefined;
    if (existingSha) {
      versions[path] = { version, sha: existingSha };
    } else {
      versions[path] = version;
    }
  }
  await writeVersions(versions, root);
}

/**
 * Set the same version for all paths (lock-step versioning).
 */
export async function setAllVersions(
  version: string,
  paths: string[] = ['.'],
  root: string = Deno.cwd(),
): Promise<void> {
  const versions = await readVersions(root);
  for (const path of paths) {
    versions[path] = version;
  }
  await writeVersions(versions, root);
}

/**
 * Check if versions manifest exists.
 */
export async function hasVersionsManifest(root: string = Deno.cwd()): Promise<boolean> {
  const filePath = join(root, VERSIONS_FILE);
  try {
    await Deno.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize versions manifest from current package versions.
 */
export async function initVersionsFromManifests(
  root: string = Deno.cwd(),
): Promise<VersionsManifest> {
  // Import here to avoid circular dependency
  const { detectWorkspace } = await import('../manifest/factory.ts');

  const workspace = await detectWorkspace(root);
  const versions: VersionsManifest = {};

  // Get root version
  if (workspace.root) {
    const rootVersion = await workspace.root.getVersion();
    if (rootVersion) {
      versions['.'] = rootVersion;
    }
  }

  // Get workspace member versions
  for (const member of workspace.members) {
    const memberVersion = await member.manifest.getVersion();
    if (memberVersion) {
      versions[member.path] = memberVersion;
    }
  }

  return versions;
}
