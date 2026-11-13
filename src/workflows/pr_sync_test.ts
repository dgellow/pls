/**
 * Tests for PR sync workflow utilities.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { generateReleaseNotes } from '../domain/changelog.ts';
import { buildReleaseFiles } from '../domain/files.ts';
import { generatePRBody } from '../domain/pr-body.ts';
import type { Commit, FileChanges, PullRequest, VersionBump } from '../domain/types.ts';
import type { CodeHost } from '../domain/vcs.ts';
import { PlsError } from '../lib/error.ts';
import { determineBumpType, syncWorkflow } from './pr-sync.ts';

Deno.test('determineBumpType', async (t) => {
  await t.step('detects major bump', () => {
    assertEquals(determineBumpType('1.2.3', '2.0.0'), 'major');
    assertEquals(determineBumpType('0.9.0', '1.0.0'), 'major');
  });

  await t.step('detects minor bump', () => {
    assertEquals(determineBumpType('1.2.3', '1.3.0'), 'minor');
    assertEquals(determineBumpType('1.0.0', '1.1.0'), 'minor');
  });

  await t.step('detects patch bump', () => {
    assertEquals(determineBumpType('1.2.3', '1.2.4'), 'patch');
    assertEquals(determineBumpType('1.0.0', '1.0.1'), 'patch');
  });

  await t.step('detects transition to prerelease', () => {
    assertEquals(determineBumpType('1.2.3', '1.3.0-alpha.0'), 'transition');
    assertEquals(determineBumpType('1.2.3', '2.0.0-beta.0'), 'transition');
  });

  await t.step('detects transition from prerelease to stable', () => {
    // BUG: This currently returns 'patch' instead of 'transition'
    assertEquals(determineBumpType('1.3.0-alpha.0', '1.3.0'), 'transition');
    assertEquals(determineBumpType('1.3.0-rc.2', '1.3.0'), 'transition');
    assertEquals(determineBumpType('2.0.0-beta.5', '2.0.0'), 'transition');
  });

  await t.step('handles prerelease to prerelease', () => {
    assertEquals(determineBumpType('1.3.0-alpha.0', '1.3.0-beta.0'), 'transition');
    assertEquals(determineBumpType('1.3.0-beta.0', '1.3.0-rc.0'), 'transition');
  });
});

/**
 * A repository at 1.0.0 with a release PR for 1.1.0, as `pls prep` leaves it.
 * Files are kept per branch; commit() and pointBranch() move the release branch.
 */
function releasePRFixture(): {
  host: CodeHost;
  pr: PullRequest;
  branchFile: (path: string) => string | undefined;
  commits: Array<{ files: FileChanges; message: string }>;
} {
  const commit: Commit = {
    rev: 'abc123',
    type: 'feat',
    scope: null,
    description: 'add export command',
    breaking: false,
    body: null,
    merge: false,
  };
  const bump: VersionBump = { from: '1.0.0', to: '1.1.0', type: 'minor', commits: [commit] };

  const main = new Map<string, string>([
    ['.pls/versions.json', '{\n  ".": {\n    "version": "1.0.0"\n  }\n}\n'],
    ['deno.json', '{\n  "name": "@test/app",\n  "version": "1.0.0"\n}\n'],
    ['CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\n- Initial release\n'],
  ]);
  const prepared = buildReleaseFiles({
    version: '1.1.0',
    from: '1.0.0',
    type: 'minor',
    manifests: [{ path: 'deno.json', content: main.get('deno.json')! }],
    versionsJson: main.get('.pls/versions.json')!,
    versionFile: null,
    changelog: generateReleaseNotes(bump),
    existingChangelog: main.get('CHANGELOG.md')!,
  });
  let branch = new Map([...main, ...prepared.files]);

  const pr: PullRequest = {
    number: 7,
    title: 'chore: release v1.1.0',
    body: generatePRBody(bump, '### Features\n\n- add export command'),
    branch: 'pls-release',
    url: 'https://github.com/test/repo/pull/7',
  };

  const commits: Array<{ files: FileChanges; message: string }> = [];
  const pending = new Map<string, Map<string, string>>();

  const host = {
    readFile: (path: string, ref?: string) =>
      Promise.resolve((ref === 'pls-release' ? branch : main).get(path) ?? null),
    getPR: () => Promise.resolve(pr),
    getBranchRevision: () => Promise.resolve('main-rev'),
    commit: (files: FileChanges, message: string) => {
      commits.push({ files, message });
      const rev = `rev-${commits.length}`;
      pending.set(rev, new Map([...main, ...files]));
      return Promise.resolve(rev);
    },
    pointBranch: (_branch: string, rev: string) => {
      branch = pending.get(rev)!;
      return Promise.resolve();
    },
    updatePR: (_number: number, options: { title?: string; body?: string }) => {
      if (options.title) pr.title = options.title;
      if (options.body) pr.body = options.body;
      return Promise.resolve();
    },
  } as unknown as CodeHost;

  return { host, pr, branchFile: (path) => branch.get(path), commits };
}

Deno.test('syncWorkflow', async (t) => {
  await t.step('a reworded PR title changes nothing', async () => {
    const { host, pr, commits, branchFile } = releasePRFixture();
    pr.title = 'Release: export command';

    const result = await syncWorkflow(host, { prNumber: 7, baseBranch: 'main' });

    assertEquals(result.synced, false);
    assertEquals(commits.length, 0);
    assertEquals(pr.title, 'Release: export command');
    assertStringIncludes(branchFile('CHANGELOG.md')!, '- add export command');
  });

  await t.step('choosing a version keeps the changelog entry under the new heading', async () => {
    const { host, pr, commits, branchFile } = releasePRFixture();
    pr.body = pr.body.replace('- [ ] 1.1.0-beta.0 ', '- [x] 1.1.0-beta.0 ');

    const result = await syncWorkflow(host, { prNumber: 7, baseBranch: 'main' });

    assertEquals(result, { synced: true, oldVersion: '1.1.0', newVersion: '1.1.0-beta.0' });
    assertEquals(commits.length, 1);
    assertEquals(
      branchFile('CHANGELOG.md'),
      '# Changelog\n\n## 1.1.0-beta.0\n\n### Features\n\n- add export command\n\n' +
        '## 1.0.0\n\n- Initial release\n',
    );
    assertStringIncludes(branchFile('.pls/versions.json')!, '"version": "1.1.0-beta.0"');
    assertStringIncludes(branchFile('deno.json')!, '"version": "1.1.0-beta.0"');
    assertStringIncludes(commits[0].message, 'version: 1.1.0-beta.0');
    assertEquals(pr.title, 'chore: release v1.1.0-beta.0');
    assertStringIncludes(pr.body, ':current:chosen -->');
  });

  await t.step('a second sync with nothing new to apply changes nothing', async () => {
    const { host, pr, commits } = releasePRFixture();
    pr.body = pr.body.replace('- [ ] 2.0.0 ', '- [x] 2.0.0 ');
    await syncWorkflow(host, { prNumber: 7, baseBranch: 'main' });

    const again = await syncWorkflow(host, { prNumber: 7, baseBranch: 'main' });

    assertEquals(again.synced, false);
    assertEquals(commits.length, 1);
  });

  await t.step('refuses a version that is not one release step away', async () => {
    const { host, pr, commits, branchFile } = releasePRFixture();
    pr.body = pr.body.replace(
      '<!-- pls:options:end -->',
      '- [x] 9.9.9-evil.1 (custom) <!-- pls:v:9.9.9-evil.1:major -->\n<!-- pls:options:end -->',
    );

    const error = await assertRejects(
      () => syncWorkflow(host, { prNumber: 7, baseBranch: 'main' }),
      PlsError,
    );

    assertEquals(error.code, 'VERSION_NOT_ALLOWED');
    assertStringIncludes(error.message, '9.9.9-evil.1');
    assertStringIncludes(error.message, '2.0.0');
    assertEquals(commits.length, 0);
    assertStringIncludes(branchFile('.pls/versions.json')!, '"version": "1.1.0"');
  });

  await t.step('says how to recover when the branch has no changelog entry to keep', async () => {
    const { host, pr, commits } = releasePRFixture();
    pr.body = pr.body.replace('- [ ] 2.0.0 ', '- [x] 2.0.0 ');
    const read = host.readFile.bind(host);
    host.readFile = (path, ref) =>
      path === 'CHANGELOG.md' && ref === 'pls-release'
        ? Promise.resolve('# Changelog\n\nVersion changed from 1.0.0 to 1.1.0\n')
        : read(path, ref);

    const error = await assertRejects(
      () => syncWorkflow(host, { prNumber: 7, baseBranch: 'main' }),
      PlsError,
    );

    assertEquals(error.code, 'CHANGELOG_ENTRY_NOT_FOUND');
    assertStringIncludes(error.message, 'pls prep');
    assertEquals(commits.length, 0);
  });
});
