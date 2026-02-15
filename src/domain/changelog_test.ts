/**
 * Tests for changelog generation.
 */

import { assertEquals } from '@std/assert';
import { generateChangelog, generateCommitList, generateReleaseNotes } from './changelog.ts';
import { prependChangelog } from './files.ts';
import type { Commit, VersionBump } from './types.ts';

const makeCommit = (
  type: string,
  description: string,
  scope: string | null = null,
  breaking = false,
  body: string | null = null,
): Commit => ({
  rev: 'abc1234567890',
  type,
  scope,
  description,
  breaking,
  body,
  merge: false,
});

Deno.test('generateCommitList', async (t) => {
  await t.step('generates list with commit info', () => {
    const commits = [makeCommit('feat', 'add feature')];
    const result = generateCommitList(commits);

    assertEquals(result.includes('feat:'), true);
    assertEquals(result.includes('add feature'), true);
  });

  await t.step('includes scope in output', () => {
    const commits = [makeCommit('fix', 'resolve issue', 'api')];
    const result = generateCommitList(commits);

    assertEquals(result.includes('fix(api):'), true);
  });

  await t.step('handles multiple commits', () => {
    const commits = [
      makeCommit('feat', 'feature one'),
      makeCommit('fix', 'fix one'),
      makeCommit('feat', 'feature two'),
    ];
    const result = generateCommitList(commits);

    assertEquals(result.includes('feature one'), true);
    assertEquals(result.includes('fix one'), true);
    assertEquals(result.includes('feature two'), true);
  });

  await t.step('returns empty string for no commits', () => {
    assertEquals(generateCommitList([]), '');
  });
});

Deno.test('generateReleaseNotes', async (t) => {
  await t.step('generates release notes from bump', () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [
        makeCommit('feat', 'feature one'),
        makeCommit('fix', 'fix one'),
      ],
    };
    const result = generateReleaseNotes(bump);

    assertEquals(result.includes('## 1.1.0'), true);
    assertEquals(result.includes('feature one'), true);
    assertEquals(result.includes('fix one'), true);
  });

  await t.step('includes breaking changes section', () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '2.0.0',
      type: 'major',
      commits: [makeCommit('feat', 'breaking feature', null, true)],
    };
    const result = generateReleaseNotes(bump);

    assertEquals(result.includes('Breaking Changes'), true);
    assertEquals(result.includes('breaking feature'), true);
  });
});

Deno.test('generateChangelog', async (t) => {
  await t.step('generates changelog sections by type', () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [
        makeCommit('feat', 'new feature'),
        makeCommit('fix', 'bug fix'),
      ],
    };
    const result = generateChangelog(bump);

    assertEquals(result.includes('Features'), true);
    assertEquals(result.includes('Bug Fixes'), true);
    assertEquals(result.includes('new feature'), true);
    assertEquals(result.includes('bug fix'), true);
  });

  await t.step('shows breaking changes first', () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '2.0.0',
      type: 'major',
      commits: [
        makeCommit('feat', 'normal feature'),
        makeCommit('feat', 'breaking feature', null, true),
      ],
    };
    const result = generateChangelog(bump);

    const breakingIndex = result.indexOf('Breaking Changes');
    const featuresIndex = result.indexOf('Features');

    assertEquals(breakingIndex < featuresIndex, true);
  });

  await t.step('returns empty for empty commits', () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [],
    };
    const result = generateChangelog(bump);
    assertEquals(result, '');
  });
});

async function assertDenoFmtCompatible(content: string, label: string) {
  const tmpFile = await Deno.makeTempFile({ suffix: '.md' });
  try {
    await Deno.writeTextFile(tmpFile, content);
    const check = new Deno.Command('deno', {
      args: ['fmt', '--check', tmpFile],
      stdout: 'piped',
      stderr: 'piped',
    });
    const output = await check.output();
    if (output.code !== 0) {
      const fmt = new Deno.Command('deno', { args: ['fmt', tmpFile] });
      await fmt.output();
      const formatted = await Deno.readTextFile(tmpFile);
      assertEquals(content, formatted, `${label}: not deno fmt compatible`);
    }
  } finally {
    await Deno.remove(tmpFile);
  }
}

Deno.test('changelog output is deno fmt compatible', async (t) => {
  await t.step('simple commits', async () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [
        makeCommit('feat', 'add new feature'),
        makeCommit('fix', 'fix a bug'),
      ],
    };
    const notes = generateReleaseNotes(bump);
    const changelog = prependChangelog(null, notes);
    await assertDenoFmtCompatible(changelog, 'simple commits');
  });

  await t.step('commit with body', async () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [
        makeCommit(
          'feat',
          'add new feature',
          null,
          false,
          'This is the body of the commit.\nIt has multiple lines.',
        ),
      ],
    };
    const notes = generateReleaseNotes(bump);
    const changelog = prependChangelog(null, notes);
    await assertDenoFmtCompatible(changelog, 'commit with body');
  });

  await t.step('breaking change with body', async () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '2.0.0',
      type: 'major',
      commits: [
        makeCommit(
          'feat',
          'redesign API',
          null,
          true,
          'This is a breaking change.\n\nMigration steps:\n1. Update config\n2. Run migration',
        ),
      ],
    };
    const notes = generateReleaseNotes(bump);
    const changelog = prependChangelog(null, notes);
    await assertDenoFmtCompatible(changelog, 'breaking change with body');
  });

  await t.step('multiple sections', async () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [
        makeCommit('feat', 'feature one'),
        makeCommit('feat', 'feature two', 'core'),
        makeCommit('fix', 'bug fix'),
        makeCommit('docs', 'update readme'),
        makeCommit('chore', 'update deps'),
      ],
    };
    const notes = generateReleaseNotes(bump);
    const changelog = prependChangelog(null, notes);
    await assertDenoFmtCompatible(changelog, 'multiple sections');
  });

  await t.step('appending to existing changelog', async () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [makeCommit('feat', 'new feature')],
    };
    const notes = generateReleaseNotes(bump);
    const existing = '# Changelog\n\n## 1.0.0\n\n### Features\n\n- initial release\n';
    const changelog = prependChangelog(existing, notes);
    await assertDenoFmtCompatible(changelog, 'appending to existing');
  });
});
