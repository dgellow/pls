/**
 * Commit parsing - convert raw commit data to structured commits.
 *
 * Pure functions, no I/O.
 *
 * NOTE: parseGitLog is in clients/git/parse.ts (git-format-specific).
 */

import type { RevisionId } from './vcs.ts';
import type { Commit } from './types.ts';

// Conventional commit pattern: type(scope)!: description
const COMMIT_REGEX = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;

// A breaking-change footer (Conventional Commits 1.0.0): the uppercase token
// at the start of a line, then a colon, a space and the description.
// BREAKING-CHANGE is a synonym of BREAKING CHANGE. The words inside a sentence
// are prose and declare nothing.
const BREAKING_FOOTER_REGEX = /^BREAKING[ -]CHANGE: \S/m;

/**
 * Parse a single commit message into structured format.
 */
export function parseCommitMessage(
  rev: RevisionId,
  message: string,
): Commit | null {
  const lines = message.split('\n');
  const firstLine = lines[0]?.trim();
  if (!firstLine) return null;

  const match = firstLine.match(COMMIT_REGEX);
  if (!match) {
    // Non-conventional commit - treat as chore
    return {
      rev,
      type: 'chore',
      scope: null,
      description: firstLine,
      breaking: false,
      body: lines.slice(1).join('\n').trim() || null,
      merge: false,
    };
  }

  const [, type, scope, bang, description] = match;
  const body = lines.slice(1).join('\n').trim() || null;

  // Breaking change indicated by ! or by a BREAKING CHANGE footer
  const breaking = bang === '!' || (body !== null && BREAKING_FOOTER_REGEX.test(body));

  return {
    rev,
    type: type.toLowerCase(),
    scope: scope || null,
    description,
    breaking,
    body,
    merge: false,
  };
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

    // Skip merge commits (prefer structured field, fall back to message heuristic)
    if (c.merge) return false;
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
