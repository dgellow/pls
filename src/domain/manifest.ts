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
 *
 * Only the value of the top-level "version" field is replaced, in place.
 * Indentation, key order, line endings, comments (deno.json may have them)
 * and the end of the file stay byte for byte as they were: a release must
 * not reformat a file the project formats its own way.
 *
 * A manifest without a "version" field gets one added, which re-serializes
 * the file. Content that is not JSON is returned unchanged.
 */
export function updateJsonVersion(content: string, version: string): string {
  const span = findTopLevelValue(content, 'version');
  if (span && content[span.start] === '"') {
    return content.slice(0, span.start) + JSON.stringify(version) + content.slice(span.end);
  }

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
 * Find the value of a top-level key in JSON text.
 *
 * Returns the half-open span of the value token, or null if the text is not
 * an object or has no such key. This walks the text token by token (strings
 * with escapes, nested objects and arrays, comments), so a "version" inside a
 * nested object or inside a string is never mistaken for the field.
 */
function findTopLevelValue(text: string, key: string): { start: number; end: number } | null {
  let i = 0;

  const skipSpace = (): void => {
    while (i < text.length) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') {
        i++;
      } else if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (ch === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        i = close === -1 ? text.length : close + 2;
      } else {
        return;
      }
    }
  };

  // Advance past a string literal starting at i. Returns false if it never closes.
  const skipString = (): boolean => {
    i++; // opening quote
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
      } else if (text[i] === '"') {
        i++;
        return true;
      } else {
        i++;
      }
    }
    return false;
  };

  // Advance past any value starting at i.
  const skipValue = (): boolean => {
    if (text[i] === '"') return skipString();

    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < text.length) {
        skipSpace();
        const ch = text[i];
        if (ch === '"') {
          if (!skipString()) return false;
        } else if (ch === '{' || ch === '[') {
          depth++;
          i++;
        } else if (ch === '}' || ch === ']') {
          depth--;
          i++;
          if (depth === 0) return true;
        } else {
          i++;
        }
      }
      return false;
    }

    // number, true, false, null
    const start = i;
    while (i < text.length && !',}] \t\r\n/'.includes(text[i])) i++;
    return i > start;
  };

  skipSpace();
  if (text[i] !== '{') return null;
  i++;

  while (i < text.length) {
    skipSpace();
    if (text[i] === '}') return null;
    if (text[i] !== '"') return null;

    const nameStart = i;
    if (!skipString()) return null;
    let name: unknown;
    try {
      name = JSON.parse(text.slice(nameStart, i));
    } catch {
      return null;
    }

    skipSpace();
    if (text[i] !== ':') return null;
    i++;
    skipSpace();

    const start = i;
    if (!skipValue()) return null;
    if (name === key) return { start, end: i };

    skipSpace();
    if (text[i] === ',') i++;
  }

  return null;
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
