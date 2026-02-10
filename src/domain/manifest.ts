/**
 * Manifest detection and version management.
 *
 * Centralizes all ecosystem-specific manifest knowledge.
 * Self-contained: no imports from sibling domain modules.
 * Pure functions + a readFile callback for I/O.
 */

/**
 * Manifests pls recognizes for project detection, in priority order.
 * First match wins in detectManifest().
 */
const KNOWN_MANIFESTS = [
  { path: 'deno.json', updatable: true },
  { path: 'package.json', updatable: true },
  { path: 'go.mod', updatable: false },
] as const;

export type ManifestPath = typeof KNOWN_MANIFESTS[number]['path'];

/** A detected project manifest. */
export interface DetectedManifest {
  path: ManifestPath;
  content: string;
  /** Extracted version, or null if the manifest doesn't carry one (e.g. go.mod). */
  version: string | null;
}

/** A manifest whose version field pls can update (JSON round-trips safely). */
export interface UpdatableManifest {
  path: string;
  content: string;
}

/**
 * Detect the primary project manifest.
 * Returns the first recognized manifest found, or null.
 */
export async function detectManifest(
  readFile: (path: string) => Promise<string | null>,
): Promise<DetectedManifest | null> {
  for (const known of KNOWN_MANIFESTS) {
    const content = await readFile(known.path);
    if (content !== null) {
      return {
        path: known.path,
        content,
        version: known.updatable ? extractVersionFromJson(content) : null,
      };
    }
  }
  return null;
}

/**
 * Read all manifests whose version field pls can update.
 * Returns only manifests that exist.
 */
export async function readUpdatableManifests(
  readFile: (path: string) => Promise<string | null>,
): Promise<UpdatableManifest[]> {
  const manifests: UpdatableManifest[] = [];
  for (const known of KNOWN_MANIFESTS) {
    if (!known.updatable) continue;
    const content = await readFile(known.path);
    if (content !== null) {
      manifests.push({ path: known.path, content });
    }
  }
  return manifests;
}

/**
 * Update the version in a manifest file.
 * Delegates to the appropriate updater based on file type.
 *
 * When adding non-JSON manifests (e.g. Cargo.toml), dispatch on path here.
 */
export function updateManifestVersion(_path: string, content: string, version: string): string {
  // All currently updatable manifests are JSON
  return updateJsonVersion(content, version);
}

/**
 * Update version in a JSON manifest (deno.json, package.json).
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
 * Extract version from a JSON manifest (deno.json or package.json).
 */
export function extractVersionFromJson(content: string): string | null {
  try {
    const json = JSON.parse(content);
    return json.version || null;
  } catch {
    return null;
  }
}
