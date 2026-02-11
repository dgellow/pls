/**
 * Git log parsing — converts git CLI output to structured commits.
 *
 * Git-specific: parses the --format output from `git log`.
 * This is a client-layer concern, not domain logic.
 */

import type { Commit } from '../../domain/types.ts';
import { parseCommitMessage } from '../../domain/commits.ts';

/**
 * Parse multiple commits from git log output.
 *
 * Expected format (use --format="%H%n%B%n---commit---"):
 * revision-hash
 * message body
 * ---commit---
 */
export function parseGitLog(output: string): Commit[] {
  const commits: Commit[] = [];
  const entries = output.split('---commit---').filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    const rev = lines[0]?.trim();
    if (!rev) continue;

    const message = lines.slice(1).join('\n').trim();
    const commit = parseCommitMessage(rev, message);
    if (commit) {
      commits.push(commit);
    }
  }

  return commits;
}

/**
 * Parse git log output that includes parent hashes for merge detection.
 *
 * Expected format (use --format="%H%n%P%n%B%n---commit---"):
 * commit-hash
 * parent-hashes (space-separated, 2+ = merge)
 * message body
 * ---commit---
 */
export function parseGitLogWithParents(output: string): Commit[] {
  const commits: Commit[] = [];
  const entries = output.split('---commit---').filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    const rev = lines[0]?.trim();
    if (!rev) continue;

    const parents = lines[1]?.trim() || '';
    const isMerge = parents.split(' ').filter((p) => p).length > 1;

    const message = lines.slice(2).join('\n').trim();
    const commit = parseCommitMessage(rev, message);
    if (commit) {
      commit.merge = isMerge;
      commits.push(commit);
    }
  }

  return commits;
}
