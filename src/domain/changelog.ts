/**
 * Changelog generation - convert commits to markdown.
 *
 * Pure functions, no I/O.
 */

import type { Commit, VersionBump } from './types.ts';
import { groupByType } from './commits.ts';

/** Display names for commit types */
const TYPE_LABELS: Record<string, string> = {
  feat: 'Features',
  fix: 'Bug Fixes',
  docs: 'Documentation',
  style: 'Styles',
  refactor: 'Code Refactoring',
  perf: 'Performance Improvements',
  test: 'Tests',
  build: 'Build System',
  ci: 'CI',
  chore: 'Chores',
  revert: 'Reverts',
};

/** Order for changelog sections */
const TYPE_ORDER = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

/**
 * Format a single commit for changelog.
 */
function formatCommit(commit: Commit): string {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  const breaking = commit.breaking ? '⚠️ BREAKING: ' : '';
  return `- ${breaking}${scope}${commit.description}`;
}

/**
 * Generate changelog section for a commit type.
 */
function formatSection(type: string, commits: Commit[]): string {
  const label = TYPE_LABELS[type] || type;
  const items = commits.map(formatCommit).join('\n');
  return `### ${label}\n\n${items}`;
}

/**
 * Generate full changelog markdown for a version bump.
 */
export function generateChangelog(bump: VersionBump): string {
  const sections: string[] = [];

  // Group commits by type
  const groups = groupByType(bump.commits);

  // Breaking changes first (special section)
  const breakingCommits = bump.commits.filter((c) => c.breaking);
  if (breakingCommits.length > 0) {
    const items = breakingCommits.map(formatCommit).join('\n');
    sections.push(`### ⚠️ Breaking Changes\n\n${items}`);
  }

  // Other sections in order
  for (const type of TYPE_ORDER) {
    const commits = groups.get(type);
    if (!commits || commits.length === 0) continue;

    // Skip breaking commits (already shown)
    const nonBreaking = commits.filter((c) => !c.breaking);
    if (nonBreaking.length === 0) continue;

    sections.push(formatSection(type, nonBreaking));
  }

  // Handle unknown types
  for (const [type, commits] of groups) {
    if (TYPE_ORDER.includes(type)) continue;
    const nonBreaking = commits.filter((c) => !c.breaking);
    if (nonBreaking.length === 0) continue;
    sections.push(formatSection(type, nonBreaking));
  }

  return sections.join('\n\n');
}

/**
 * Generate release notes (changelog with header).
 */
export function generateReleaseNotes(bump: VersionBump): string {
  const header = `## ${bump.to}`;
  const body = generateChangelog(bump);
  return body ? `${header}\n\n${body}` : header;
}

/**
 * Generate commit list (simple format for tag messages).
 */
export function generateCommitList(commits: Commit[]): string {
  return commits
    .map((c) => {
      const scope = c.scope ? `(${c.scope})` : '';
      return `- ${c.type}${scope}: ${c.description}`;
    })
    .join('\n');
}
