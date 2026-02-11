/**
 * VCS abstractions for pls.
 *
 * Two separate concerns:
 * 1. LocalRepo — local repository operations (the VCS itself: git, hg, jj, etc.)
 * 2. CodeHost — remote platform operations (GitHub, GitLab, etc.)
 *
 * Designed for distributed VCS (git, hg, sapling, jj, pijul).
 * Centralized VCS (SVN, Perforce) would have semantic mismatches.
 */

import type {
  Commit,
  CreatePROptions,
  FileChanges,
  PullRequest,
  ReleaseTag,
  UpdatePROptions,
} from './types.ts';

/** Opaque revision identifier. Never parse or assume format. */
export type RevisionId = string;

/** Local repository operations (the VCS itself). */
export interface LocalRepo {
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  getCommitsSince(rev: RevisionId | null): Promise<Commit[]>;
  getHeadRevision(): Promise<RevisionId>;
  getCommitMessage(ref: string): Promise<string>;
  tagExists(tag: string): Promise<boolean>;
  getTagRevision(tag: string): Promise<RevisionId | null>;
  getTagMessage(tag: string): Promise<string | null>;
  createTag(name: string, message: string): Promise<void>;
  commit(message: string): Promise<RevisionId>;
  push(ref: string): Promise<void>;
  findCommitByContent(searchString: string, filePath: string): Promise<RevisionId | null>;
}

/** Branch sync operations. Only needed by Strategy B (next branch). */
export interface BranchSyncable {
  fetch(remote?: string): Promise<void>;
  checkoutBranch(branch: string, fromRef: string): Promise<void>;
  rebase(onto: string): Promise<boolean>;
  pushForceWithLease(remote: string, branch: string): Promise<boolean>;
}

/** Remote repo metadata. Used by CLI only for auto-detecting owner/repo. */
export interface RemoteDetectable {
  getRemoteInfo(): Promise<{ owner: string; repo: string } | null>;
}

/** Code hosting platform (GitHub, GitLab, etc.). */
export interface CodeHost {
  readFile(path: string, ref?: string): Promise<string | null>;
  fileExists(path: string, ref?: string): Promise<boolean>;
  commit(files: FileChanges, message: string, parentRev: RevisionId): Promise<RevisionId>;
  getBranchRevision(branch: string): Promise<RevisionId | null>;
  pointBranch(branch: string, rev: RevisionId, force?: boolean): Promise<void>;
  createBranch(branch: string, rev: RevisionId): Promise<void>;
  branchExists(branch: string): Promise<boolean>;
  ensureBranch(branch: string, rev: RevisionId): Promise<void>;
  createTag(name: string, rev: RevisionId, message: string): Promise<void>;
  getTag(name: string): Promise<ReleaseTag | null>;
  findPR(headBranch: string): Promise<PullRequest | null>;
  findMergedPR(headBranch: string): Promise<PullRequest | null>;
  getPR(number: number): Promise<PullRequest>;
  createPR(options: CreatePROptions): Promise<PullRequest>;
  updatePR(number: number, options: UpdatePROptions): Promise<void>;
  createRelease(tag: string, name: string, body: string, prerelease?: boolean): Promise<string>;
  releaseExists(tag: string): Promise<boolean>;
}
