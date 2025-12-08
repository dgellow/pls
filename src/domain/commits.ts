/**
 * Commit parsing - convert git log output to structured commits.
 *
 * Pure functions, no I/O.
 */

import type { Commit } from './types.ts';

// Conventional commit pattern: type(scope)!: description
const COMMIT_REGEX = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;

/**
 * Parse a single commit message into structured format.
 */
export function parseCommitMessage(
  sha: string,
  message: string,
): Commit | null {
  const lines = message.split('\n');
  const firstLine = lines[0]?.trim();
  if (!firstLine) return null;

  const match = firstLine.match(COMMIT_REGEX);
  if (!match) {
    // Non-conventional commit - treat as chore
    return {
      sha,
      type: 'chore',
      scope: null,
      description: firstLine,
      breaking: false,
      body: lines.slice(1).join('\n').trim() || null,
    };
  }

  const [, type, scope, bang, description] = match;
  const body = lines.slice(1).join('\n').trim() || null;

  // Breaking change indicated by ! or BREAKING CHANGE in body
  const breaking = bang === '!' ||
    (body?.includes('BREAKING CHANGE') ?? false);

  return {
    sha,
    type: type.toLowerCase(),
    scope: scope || null,
    description,
    breaking,
    body,
  };
}

/**
 * Parse multiple commits from git log output.
 *
 * Expected format (use --format="%H%n%B%n---commit---"):
 * sha
 * message body
 * ---commit---
 */
export function parseGitLog(output: string): Commit[] {
  const commits: Commit[] = [];
  const entries = output.split('---commit---').filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    const sha = lines[0]?.trim();
    if (!sha) continue;

    const message = lines.slice(1).join('\n').trim();
    const commit = parseCommitMessage(sha, message);
    if (commit) {
      commits.push(commit);
    }
  }

  return commits;
}

/**
 * Filter commits that should trigger a release.
 * Excludes merge commits, release commits, etc.
 */
export function filterReleasableCommits(commits: Commit[]): Commit[] {
  return commits.filter((c) => {
    // Skip release commits
    if (c.description.startsWith('release v')) return false;
    if (c.description.startsWith('chore: release')) return false;

    // Skip merge commits (detected by message pattern)
    if (c.description.startsWith('Merge ')) return false;

    return true;
  });
}

/**
 * Group commits by type for changelog generation.
 */
export function groupByType(commits: Commit[]): Map<string, Commit[]> {
  const groups = new Map<string, Commit[]>();

  for (const commit of commits) {
    const existing = groups.get(commit.type) || [];
    existing.push(commit);
    groups.set(commit.type, existing);
  }

  return groups;
}
