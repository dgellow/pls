/**
 * Core domain types for pls.
 */

import type { RevisionId } from './vcs.ts';

/** Parsed conventional commit */
export interface Commit {
  rev: RevisionId;
  type: string; // feat, fix, chore, docs, etc.
  scope: string | null;
  description: string;
  breaking: boolean;
  body: string | null;
  merge: boolean;
}

/** Version bump calculation result */
export interface VersionBump {
  from: string;
  to: string;
  type: 'major' | 'minor' | 'patch';
  commits: Commit[];
}

/** Release metadata stored in commit/tag messages */
export interface ReleaseMetadata {
  version: string;
  from: string;
  type: 'major' | 'minor' | 'patch' | 'transition';
}

/** Version entry in versions.json (always object format) */
export interface VersionEntry {
  version: string;
  versionFile?: string;
}

/** versions.json schema */
export interface VersionsManifest {
  [path: string]: VersionEntry;
}

/** Pull request representation */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  branch: string;
  url: string;
}

/** Version option in PR body */
export interface VersionOption {
  version: string;
  type: 'major' | 'minor' | 'patch' | 'transition';
  label: string;
  selected: boolean;
  disabled: boolean;
  disabledReason?: string;
}

/** Parsed version selection from PR body */
export interface VersionSelection {
  options: VersionOption[];
  selected: VersionOption | null;
}

/** Files to be committed */
export type FileChanges = Map<string, string>;

/** Release tag info */
export interface ReleaseTag {
  name: string; // v1.2.3
  rev: RevisionId;
  message: string | null; // null for lightweight tags
  isPlsRelease: boolean; // has ---pls-release--- marker
  metadata: ReleaseMetadata | null;
}

/** Options for creating a pull request */
export interface CreatePROptions {
  title: string;
  body: string;
  head: string;
  base: string;
}

/** Options for updating a pull request */
export interface UpdatePROptions {
  title?: string;
  body?: string;
}
