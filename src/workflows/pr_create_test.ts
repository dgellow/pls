/**
 * Tests for the prep workflow: what it does when the base branch moves while
 * it runs.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { CodeHost, HostCommit, LocalRepo } from '../domain/vcs.ts';
import type { Commit, FileChanges, PullRequest } from '../domain/types.ts';
import { PlsError } from '../lib/error.ts';
import { prepWorkflow } from './pr-create.ts';

const VERSIONS = '{\n  ".": {\n    "version": "1.0.0"\n  }\n}\n';

function commit(description: string): Commit {
  return {
    rev: description,
    type: 'feat',
    scope: null,
    description,
    breaking: false,
    body: null,
    merge: false,
  };
}

/**
 * A repository at 1.0.0 whose base branch points at each of `tips` in turn,
 * one per time prep asks. `history` maps a tip to the commits since v1.0.0.
 */
function fixture(
  tips: string[],
  history: Record<string, Commit[]>,
  existingPR: PullRequest | null = null,
  ahead: HostCommit[] = [],
) {
  const comments: string[] = [];
  const asked: string[] = [];
  const reads: Array<string | undefined> = [];
  const commits: Array<{ parent: string; changelog: string }> = [];
  const branchUpdates: string[] = [];
  const prBodies: string[] = [];
  let tipCalls = 0;

  const repo = {
    getHeadRevision: () => Promise.resolve(tips[0]),
    getCommitsSince: (_rev: string | null, until?: string) => {
      asked.push(until ?? 'HEAD');
      return Promise.resolve(history[until ?? tips[0]]);
    },
    findCommitByContent: () => Promise.resolve(null),
  } as unknown as LocalRepo;

  const host = {
    getBranchRevision: () => Promise.resolve(tips[Math.min(tipCalls++, tips.length - 1)]),
    readFile: (path: string, ref?: string) => {
      reads.push(ref);
      return Promise.resolve(path === '.pls/versions.json' ? VERSIONS : null);
    },
    getTag: () =>
      Promise.resolve({
        name: 'v1.0.0',
        rev: 'v1',
        message: null,
        isPlsRelease: true,
        metadata: null,
      }),
    findPR: () => Promise.resolve(existingPR),
    updatePR: () => Promise.resolve(),
    getCommitsAhead: () => Promise.resolve(ahead),
    commentOnPR: (_number: number, body: string) => {
      comments.push(body);
      return Promise.resolve();
    },
    commit: (files: FileChanges, _message: string, parent: string) => {
      commits.push({ parent, changelog: files.get('CHANGELOG.md') ?? '' });
      return Promise.resolve(`release-on-${parent}`);
    },
    ensureBranch: (_branch: string, rev: string) => {
      branchUpdates.push(rev);
      return Promise.resolve();
    },
    createPR: (options: { title: string; body: string; head: string }) => {
      prBodies.push(options.body);
      return Promise.resolve({
        number: 1,
        title: options.title,
        body: options.body,
        branch: options.head,
        url: 'u',
      });
    },
  } as unknown as CodeHost;

  return { repo, host, asked, reads, commits, branchUpdates, prBodies, comments };
}

const options = { baseBranch: 'main', releaseBranch: 'pls-release', dryRun: false };

Deno.test('prepWorkflow and a moving base branch', async (t) => {
  await t.step('reads and builds on one commit of the base branch', async () => {
    const f = fixture(['c1'], { c1: [commit('add export command')] });

    const result = await prepWorkflow(f.repo, f.host, options);

    assertEquals(result.bump?.to, '1.1.0');
    assertEquals(f.branchUpdates, ['release-on-c1']);
    // Every file is read at that commit, never at "whatever main is now".
    assertEquals([...new Set(f.reads)], ['c1']);
  });

  await t.step('prepares the release again when the branch moved before the write', async () => {
    // Snapshot c1, and by the time the commit is built main is at c2.
    const f = fixture(['c1', 'c2'], {
      c1: [commit('add export command')],
      c2: [commit('handle empty input'), commit('add export command')],
    });

    const result = await prepWorkflow(f.repo, f.host, options);

    // The stale attempt wrote neither the branch nor the PR.
    assertEquals(f.branchUpdates, ['release-on-c2']);
    assertEquals(f.prBodies.length, 1);
    assertEquals(result.bump?.commits.length, 2);
    assertEquals(f.commits.at(-1)?.changelog.includes('handle empty input'), true);
    // The second attempt asked for the history up to the new tip.
    assertEquals(f.asked, ['HEAD', 'c2']);
  });

  await t.step('gives up, without writing, when the branch keeps moving', async () => {
    const tips = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    const f = fixture(tips, Object.fromEntries(tips.map((tip) => [tip, [commit('change')]])));

    const error = await assertRejects(() => prepWorkflow(f.repo, f.host, options), PlsError);

    assertEquals(error.code, 'BASE_BRANCH_MOVING');
    assertEquals(f.branchUpdates, []);
    assertEquals(f.prBodies, []);
  });

  await t.step('a dry run writes nothing and does not need the second look', async () => {
    const f = fixture(['c1', 'c2'], { c1: [commit('add export command')] });

    const result = await prepWorkflow(f.repo, f.host, { ...options, dryRun: true });

    assertEquals(result.dryRun, true);
    assertEquals(f.commits, []);
    assertEquals(f.branchUpdates, []);
  });
});

Deno.test('prepWorkflow and commits pushed to the release branch', async (t) => {
  const pr: PullRequest = { number: 9, title: 't', body: '', branch: 'pls-release', url: 'u' };
  const generated: HostCommit = {
    rev: 'aaaaaaa1',
    message:
      'chore: release v1.1.0\n\n---pls-release---\nversion: 1.1.0\nfrom: 1.0.0\ntype: minor\n---pls-release---',
    parents: ['c0'],
  };

  await t.step('names the discarded commit in a comment on the PR', async () => {
    const f = fixture(['c1'], { c1: [commit('add export command')] }, pr, [
      generated,
      { rev: 'bbbbbbb2cccc', message: 'docs: reword changelog', parents: ['aaaaaaa1'] },
    ]);

    await prepWorkflow(f.repo, f.host, options);

    assertEquals(f.branchUpdates, ['release-on-c1']);
    assertEquals(f.comments.length, 1);
    assertEquals(f.comments[0].includes('`bbbbbbb` docs: reword changelog'), true);
  });

  await t.step('says nothing when the branch holds only what pls generated', async () => {
    const f = fixture(['c1'], { c1: [commit('add export command')] }, pr, [generated]);

    await prepWorkflow(f.repo, f.host, options);

    assertEquals(f.comments, []);
  });
});
