/**
 * Tests for commit parsing.
 */

import { assertEquals } from '@std/assert';
import {
  filterReleasableCommits,
  groupByType,
  parseCommitMessage,
  parseGitLog,
} from './commits.ts';
import type { Commit } from './types.ts';

Deno.test('parseCommitMessage', async (t) => {
  await t.step('parses conventional commit with type and description', () => {
    const result = parseCommitMessage('abc123', 'feat: add new feature');
    assertEquals(result?.type, 'feat');
    assertEquals(result?.scope, null);
    assertEquals(result?.description, 'add new feature');
    assertEquals(result?.breaking, false);
  });

  await t.step('parses commit with scope', () => {
    const result = parseCommitMessage('abc123', 'fix(api): resolve endpoint issue');
    assertEquals(result?.type, 'fix');
    assertEquals(result?.scope, 'api');
    assertEquals(result?.description, 'resolve endpoint issue');
  });

  await t.step('parses breaking change with !', () => {
    const result = parseCommitMessage('abc123', 'feat!: breaking change');
    assertEquals(result?.type, 'feat');
    assertEquals(result?.breaking, true);
    assertEquals(result?.description, 'breaking change');
  });

  await t.step('parses breaking change with scope', () => {
    const result = parseCommitMessage('abc123', 'refactor(core)!: major refactor');
    assertEquals(result?.type, 'refactor');
    assertEquals(result?.scope, 'core');
    assertEquals(result?.breaking, true);
  });

  await t.step('treats non-conventional commit as chore', () => {
    const result = parseCommitMessage('abc123', 'Random commit message');
    assertEquals(result?.type, 'chore');
    assertEquals(result?.description, 'Random commit message');
    assertEquals(result?.breaking, false);
  });

  await t.step('parses various commit types', () => {
    assertEquals(parseCommitMessage('a', 'fix: bug fix')?.type, 'fix');
    assertEquals(parseCommitMessage('a', 'docs: update readme')?.type, 'docs');
    assertEquals(parseCommitMessage('a', 'style: format code')?.type, 'style');
    assertEquals(parseCommitMessage('a', 'refactor: cleanup')?.type, 'refactor');
    assertEquals(parseCommitMessage('a', 'test: add tests')?.type, 'test');
    assertEquals(parseCommitMessage('a', 'chore: update deps')?.type, 'chore');
    assertEquals(parseCommitMessage('a', 'perf: optimize')?.type, 'perf');
    assertEquals(parseCommitMessage('a', 'ci: update workflow')?.type, 'ci');
    assertEquals(parseCommitMessage('a', 'build: update config')?.type, 'build');
  });

  await t.step('parses multiline message with body', () => {
    const result = parseCommitMessage(
      'abc123',
      'feat: add feature\n\nThis is the body\nwith multiple lines',
    );
    assertEquals(result?.description, 'add feature');
    assertEquals(result?.body, 'This is the body\nwith multiple lines');
  });

  await t.step('detects breaking change in body', () => {
    const result = parseCommitMessage(
      'abc123',
      'feat: add feature\n\nBREAKING CHANGE: API changed',
    );
    assertEquals(result?.breaking, true);
  });
});

Deno.test('parseGitLog', async (t) => {
  await t.step('parses single commit', () => {
    const log = `abc123
feat: add feature

---commit---`;
    const commits = parseGitLog(log);
    assertEquals(commits.length, 1);
    assertEquals(commits[0].sha, 'abc123');
    assertEquals(commits[0].description, 'add feature');
    assertEquals(commits[0].type, 'feat');
  });

  await t.step('parses multiple commits', () => {
    const log = `abc123
feat: first feature

---commit---
def456
fix: fix bug

---commit---
ghi789
docs: update docs

---commit---`;
    const commits = parseGitLog(log);
    assertEquals(commits.length, 3);
    assertEquals(commits[0].sha, 'abc123');
    assertEquals(commits[0].type, 'feat');
    assertEquals(commits[1].sha, 'def456');
    assertEquals(commits[1].type, 'fix');
    assertEquals(commits[2].sha, 'ghi789');
    assertEquals(commits[2].type, 'docs');
  });

  await t.step('returns empty array for empty input', () => {
    assertEquals(parseGitLog(''), []);
    assertEquals(parseGitLog('   '), []);
  });
});

Deno.test('filterReleasableCommits', async (t) => {
  const makeCommit = (type: string, description: string): Commit => ({
    sha: 'abc123',
    type,
    scope: null,
    description,
    breaking: false,
    body: null,
  });

  await t.step('keeps regular commits', () => {
    const commits = [
      makeCommit('feat', 'add feature'),
      makeCommit('fix', 'fix bug'),
    ];
    const result = filterReleasableCommits(commits);
    assertEquals(result.length, 2);
  });

  await t.step('excludes release commits', () => {
    const commits = [
      makeCommit('chore', 'release v1.0.0'),
      makeCommit('feat', 'add feature'),
    ];
    const result = filterReleasableCommits(commits);
    assertEquals(result.length, 1);
    assertEquals(result[0].description, 'add feature');
  });

  await t.step('excludes merge commits', () => {
    const commits = [
      makeCommit('chore', 'Merge pull request #123'),
      makeCommit('feat', 'add feature'),
    ];
    const result = filterReleasableCommits(commits);
    assertEquals(result.length, 1);
  });
});

Deno.test('groupByType', async (t) => {
  const makeCommit = (type: string): Commit => ({
    sha: 'abc123',
    type,
    scope: null,
    description: 'message',
    breaking: false,
    body: null,
  });

  await t.step('groups commits by type', () => {
    const commits = [
      makeCommit('feat'),
      makeCommit('fix'),
      makeCommit('feat'),
      makeCommit('docs'),
    ];
    const grouped = groupByType(commits);

    assertEquals(grouped.get('feat')?.length, 2);
    assertEquals(grouped.get('fix')?.length, 1);
    assertEquals(grouped.get('docs')?.length, 1);
  });
});
