/**
 * Backend abstraction for file operations.
 *
 * Provides a unified interface for release operations that can work with:
 * - Local filesystem (Deno file ops + git CLI)
 * - GitHub API (Git Data API)
 */

export type { CommitBackend, FileBackend, ReleaseContext } from './interface.ts';
export { LocalBackend } from './local.ts';
export { GitHubBackend, type GitHubBackendOptions } from './github.ts';
