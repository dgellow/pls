/**
 * What the simulator needs to know about a release tool.
 *
 * An adapter describes how a project adopts the tool, which CI workflows the
 * tool's documentation tells users to set up, and how people express intent
 * with it (how a change is marked as a feature or a breaking change, how a
 * maintainer overrides the version). Scenarios are written against this
 * interface so the same scenario runs against every tool.
 */

import type { Workflow } from '../actions/runner.ts';
import type { PullRequest } from '../github/model.ts';
import type { Files, World } from '../scenario/world.ts';

export type ChangeKind = 'feature' | 'fix' | 'breaking' | 'chore' | 'docs';

export interface Change {
  kind: ChangeKind;
  summary: string;
  /** Extra text for the commit body. */
  body?: string;
}

export interface MappedChange {
  message: string;
  files: Files;
  labels: string[];
}

export interface WorkflowOptions {
  /** Credential the workflows use for API calls and pushes. */
  token: 'GITHUB_TOKEN' | 'PAT';
  /** Override the checkout depth the tool's documentation prescribes. */
  fetchDepth?: number;
  /**
   * Shell snippet that publishes the package. When set, the adapter adds it to
   * the release workflow, guarded by whatever the tool offers to tell "a
   * release was just created" within the same workflow.
   */
  publish?: string;
}

export type Capability =
  /** Opens a pull request that a person merges to release. */
  | 'release-pr'
  /** A person can pick a different version in the release pull request. */
  | 'pr-version-override'
  /** alpha/beta/rc flows. */
  | 'prerelease'
  /** Creates a GitHub Release object. */
  | 'github-release'
  /** Writes a CHANGELOG.md into the repository. */
  | 'changelog-file'
  /** Derives the bump from commit messages. */
  | 'conventional-commits'
  /** Works with only a git remote, no host API. */
  | 'no-host';

export interface Tool {
  name: string;
  /** Version string of the tool under test. */
  version(): Promise<string>;
  /** One-time installation into the simulator cache. */
  prepare?(): Promise<void>;
  capabilities: Capability[];
  /** Extra environment (PATH additions, caches) for workflow steps and the maintainer's shell. */
  env?(w: World): Promise<Record<string, string>>;
  /** Bring a fresh repository to "tool adopted, `version` already released". */
  adopt(w: World, version: string): Promise<void>;
  /** Workflows the tool's documentation prescribes. */
  workflows(w: World, opts: WorkflowOptions): Workflow[];
  /** How a change of a given kind is expressed with this tool. */
  change(w: World, change: Change): Promise<MappedChange> | MappedChange;
  /** The tool's open release pull request, if any. */
  releasePR(w: World): PullRequest | undefined;
  /** Tag the tool creates for a version. */
  tagName(version: string): string;
  /** Version recorded in the repository's files at a ref. */
  versionAt(w: World, ref: string): Promise<string | null>;
  /** A maintainer picks another version for the pending release. */
  selectVersion?(w: World, version: string): Promise<void>;
  /** Commit-message text with which an outside contribution could try to force a release. */
  spoof?(version: string): string;
  /** Edit the release pull request body to smuggle in a version the tool did not offer. */
  tamper?(w: World, pr: PullRequest, version: string): void;
  /** Make the tool keep the version in an extra file with the given mode. */
  trackFile?(w: World, path: string, content: string, mode: number): Promise<void>;
}

export function has(tool: Tool, capability: Capability): boolean {
  return tool.capabilities.includes(capability);
}

/** Conventional-commit mapping shared by tools that read commit messages. */
export function conventional(change: Change): MappedChange {
  const prefix = {
    feature: 'feat',
    fix: 'fix',
    breaking: 'feat!',
    chore: 'chore',
    docs: 'docs',
  }[change.kind];
  const message = `${prefix}: ${change.summary}` + (change.body ? `\n\n${change.body}` : '');
  return { message, files: {}, labels: [] };
}
