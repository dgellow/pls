/**
 * Client interfaces for infrastructure operations.
 *
 * All I/O is isolated in these clients.
 */

import type { Commit, FileChanges, PullRequest, ReleaseTag } from '../domain/types.ts';

/**
 * Git operations interface (local git CLI).
 */
export interface GitClient {
  // Reading
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;

  // Git history
  getCommitsSince(sha: string | null): Promise<Commit[]>;
  getHeadSha(): Promise<string>;
  getCommitMessage(ref: string): Promise<string>;

  // Tags
  getTagSha(tag: string): Promise<string | null>;
  getTagMessage(tag: string): Promise<string | null>;
  tagExists(tag: string): Promise<boolean>;

  // Writing (local)
  writeFile(path: string, content: string): Promise<void>;
  commit(message: string): Promise<string>;
  createTag(name: string, message: string): Promise<void>;
  push(ref: string): Promise<void>;
}

/**
 * GitHub API operations interface.
 */
export interface GitHubClient {
  // Reading files
  readFile(path: string, ref?: string): Promise<string | null>;
  fileExists(path: string, ref?: string): Promise<boolean>;

  // Atomic commit (files → tree → commit)
  commit(files: FileChanges, message: string, parentSha: string): Promise<string>;

  // Branch operations (branch is PARAMETER, not config)
  getBranchSha(branch: string): Promise<string | null>;
  pointBranch(branch: string, sha: string, force?: boolean): Promise<void>;
  createBranch(branch: string, sha: string): Promise<void>;
  branchExists(branch: string): Promise<boolean>;

  // Tag operations
  createTag(name: string, sha: string, message: string): Promise<void>;
  getTag(name: string): Promise<ReleaseTag | null>;

  // PR operations
  findPR(headBranch: string): Promise<PullRequest | null>;
  getPR(number: number): Promise<PullRequest>;
  createPR(options: CreatePROptions): Promise<PullRequest>;
  updatePR(number: number, options: UpdatePROptions): Promise<void>;

  // GitHub Releases
  createRelease(tag: string, name: string, body: string, prerelease?: boolean): Promise<string>;
  releaseExists(tag: string): Promise<boolean>;
}

export interface CreatePROptions {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface UpdatePROptions {
  title?: string;
  body?: string;
}
