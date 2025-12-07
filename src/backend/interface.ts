/**
 * File backend interface for abstracting file operations.
 *
 * This allows the same release logic to work with:
 * - Local filesystem (for direct releases)
 * - GitHub API (for PR-based releases)
 */

export interface FileBackend {
  /**
   * Read file content. Returns null if file doesn't exist.
   */
  read(path: string): Promise<string | null>;

  /**
   * Write file content.
   */
  write(path: string, content: string): Promise<void>;

  /**
   * Check if file exists.
   */
  exists(path: string): Promise<boolean>;

  /**
   * List files matching a glob pattern.
   */
  glob(pattern: string): Promise<string[]>;
}

export interface CommitBackend extends FileBackend {
  /**
   * Create a commit with the pending writes.
   * Returns the commit SHA.
   */
  commit(message: string): Promise<string>;

  /**
   * Push commits to remote (if applicable).
   */
  push?(): Promise<void>;
}

/**
 * Context for file operations during a release.
 */
export interface ReleaseContext {
  version: string;
  from: string;
  type: 'major' | 'minor' | 'patch' | 'transition';
  dryRun: boolean;
}
