/**
 * Manifest interface for reading/writing versions in project files.
 *
 * Implementations handle specific file formats:
 * - deno.json / deno.jsonc
 * - package.json
 * - go.mod (future)
 * - pyproject.toml (future)
 * - Cargo.toml (future)
 */
export interface Manifest {
  /** Unique identifier for this manifest type */
  readonly type: string;

  /** File path relative to project root */
  readonly path: string;

  /** Check if this manifest file exists */
  exists(): Promise<boolean>;

  /** Read current version from manifest, null if not set */
  getVersion(): Promise<string | null>;

  /** Write new version to manifest */
  setVersion(version: string): Promise<void>;
}

/**
 * Result of manifest detection
 */
export interface ManifestInfo {
  type: string;
  path: string;
  version: string | null;
}

/**
 * Options for workspace detection
 */
export interface WorkspaceOptions {
  /** Root directory to scan */
  root?: string;
}
