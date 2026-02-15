/**
 * E2E tests for prep workflow — version recalculation on re-runs.
 *
 * Tests the scenario where a user pushes, pls prep creates a release PR,
 * then the user amends/changes commits and pushes again. The second prep
 * run should recalculate the version from commits, not preserve the stale
 * version from the previous PR.
 */

import { assertEquals } from '@std/assert';
import { createTestRepo, run } from './test_helpers.ts';
import { prepWorkflow } from '../../src/workflows/pr-create.ts';
import { initWorkflow } from '../../src/workflows/init.ts';
import type { CodeHost } from '../../src/domain/vcs.ts';
import type {
  CreatePROptions,
  FileChanges,
  PullRequest,
  UpdatePROptions,
} from '../../src/domain/types.ts';

/**
 * Stateful mock CodeHost that tracks PRs and file commits.
 *
 * Stores files committed via commit() and PRs created/updated via
 * createPR()/updatePR(), so subsequent prepWorkflow calls see the
 * state from previous runs.
 */
function createStatefulHost(
  initialFiles: Map<string, string>,
): {
  host: CodeHost;
  getPR: () => PullRequest | null;
  getCommittedFiles: () => Map<string, string>;
} {
  // Base files represent the main branch — never modified by commits
  const baseFiles = new Map(initialFiles);
  // Committed files represent what was written to the release branch
  const committedFiles = new Map<string, string>();
  let currentPR: PullRequest | null = null;
  let revCounter = 0;

  const host: CodeHost = {
    readFile: (path: string, _ref?: string) => Promise.resolve(baseFiles.get(path) ?? null),
    fileExists: (path: string, _ref?: string) => Promise.resolve(baseFiles.has(path)),
    commit: (changes: FileChanges, _message: string, _parentRev: string) => {
      for (const [path, content] of changes) {
        committedFiles.set(path, content);
      }
      revCounter++;
      return Promise.resolve(`rev-${revCounter}`);
    },
    getBranchRevision: () => Promise.resolve('base-rev'),
    pointBranch: () => Promise.resolve(),
    createBranch: () => Promise.resolve(),
    branchExists: () => Promise.resolve(false),
    ensureBranch: () => Promise.resolve(),
    createTag: () => Promise.resolve(),
    // Return null so findReleaseRevision falls through to
    // repo.findCommitByContent(), which searches the real git history.
    getTag: () => Promise.resolve(null),
    findPR: () => Promise.resolve(currentPR),
    findMergedPR: () => Promise.resolve(null),
    getPR: (number: number) => {
      if (currentPR && currentPR.number === number) {
        return Promise.resolve(currentPR);
      }
      return Promise.resolve({ number, title: '', body: '', branch: '', url: '' });
    },
    createPR: (options: CreatePROptions) => {
      currentPR = {
        number: 1,
        title: options.title,
        body: options.body,
        branch: options.head,
        url: 'https://github.com/test/repo/pull/1',
      };
      return Promise.resolve(currentPR);
    },
    updatePR: (_number: number, options: UpdatePROptions) => {
      if (currentPR) {
        if (options.title) currentPR.title = options.title;
        if (options.body) currentPR.body = options.body;
      }
      return Promise.resolve();
    },
    createRelease: () => Promise.resolve(''),
    releaseExists: () => Promise.resolve(false),
  };

  return {
    host,
    getPR: () => currentPR,
    getCommittedFiles: () => committedFiles,
  };
}

Deno.test('e2e: prep workflow — version recalculation on re-run', async (t) => {
  const { git, dir, cleanup } = await createTestRepo();

  try {
    // Setup: deno.json at 0.3.0
    await git.writeFile(
      'deno.json',
      JSON.stringify({ name: '@test/app', version: '0.3.0' }, null, 2) + '\n',
    );
    await git.commit('chore: initial project');

    // Init pls at 0.3.0
    await initWorkflow(git, { dryRun: false });
    await git.commit('chore: initialize pls');

    // Read initial files for the mock host
    const versionsJson = await git.readFile('.pls/versions.json');
    const initialFiles = new Map<string, string>();
    initialFiles.set('.pls/versions.json', versionsJson!);
    initialFiles.set('deno.json', await git.readFile('deno.json') as string);

    const { host, getPR, getCommittedFiles } = createStatefulHost(initialFiles);

    await t.step('first prep with feat! on pre-1.0 produces 0.4.0 minor', async () => {
      // Add breaking feature commit — but on pre-1.0, breaking bumps minor
      await git.writeFile('src/app.ts', 'export class App {}\n');
      await git.commit('feat!: redesign API');

      const result = await prepWorkflow(git, host, {
        baseBranch: 'main',
        releaseBranch: 'pls-release',
        dryRun: false,
      });

      assertEquals(result.bump?.to, '0.4.0');
      assertEquals(result.bump?.type, 'minor');
      assertEquals(result.bump?.from, '0.3.0');

      const pr = getPR();
      assertEquals(pr !== null, true);
      assertEquals(pr!.title, 'chore: release v0.4.0');
    });

    await t.step(
      'amend commit to feat (non-breaking), re-run prep → should recalculate to 0.4.0',
      async () => {
        // Amend the commit: change feat! to feat
        await run(dir, ['git', 'reset', '--soft', 'HEAD~1']);
        await run(dir, ['git', 'commit', '-m', 'feat: redesign API']);

        const result = await prepWorkflow(git, host, {
          baseBranch: 'main',
          releaseBranch: 'pls-release',
          dryRun: false,
        });

        // The version should be recalculated based on new commits
        assertEquals(result.bump?.to, '0.4.0', 'version should be recalculated to 0.4.0');
        assertEquals(result.bump?.type, 'minor', 'type should be minor');
        assertEquals(result.bump?.from, '0.3.0');

        const pr = getPR();
        assertEquals(pr!.title, 'chore: release v0.4.0');

        // Verify committed versions.json is consistent
        const committedVersions = getCommittedFiles().get('.pls/versions.json');
        if (committedVersions) {
          const versions = JSON.parse(committedVersions);
          assertEquals(versions['.'].version, '0.4.0', 'committed version should be 0.4.0');
        }
      },
    );
  } finally {
    await cleanup();
  }
});

Deno.test('e2e: prep workflow — unchanged commits preserve version', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Setup: deno.json at 1.0.0
    await git.writeFile(
      'deno.json',
      JSON.stringify({ name: '@test/app', version: '1.0.0' }, null, 2) + '\n',
    );
    await git.commit('chore: initial project');

    await initWorkflow(git, { dryRun: false });
    await git.commit('chore: initialize pls');

    const versionsJson = await git.readFile('.pls/versions.json');
    const initialFiles = new Map<string, string>();
    initialFiles.set('.pls/versions.json', versionsJson!);
    initialFiles.set('deno.json', await git.readFile('deno.json') as string);

    const { host, getPR } = createStatefulHost(initialFiles);

    await t.step('first prep with feat → 1.1.0 minor', async () => {
      await git.writeFile('src/feature.ts', 'export function hello() {}\n');
      await git.commit('feat: add greeting');

      const result = await prepWorkflow(git, host, {
        baseBranch: 'main',
        releaseBranch: 'pls-release',
        dryRun: false,
      });

      assertEquals(result.bump?.to, '1.1.0');
      assertEquals(result.bump?.type, 'minor');
    });

    await t.step('second prep with same commits → still 1.1.0 minor', async () => {
      const result = await prepWorkflow(git, host, {
        baseBranch: 'main',
        releaseBranch: 'pls-release',
        dryRun: false,
      });

      assertEquals(result.bump?.to, '1.1.0');
      assertEquals(result.bump?.type, 'minor');

      const pr = getPR();
      assertEquals(pr!.title, 'chore: release v1.1.0');
    });
  } finally {
    await cleanup();
  }
});

Deno.test('e2e: prep workflow — respects explicit user version selection', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Setup: deno.json at 1.0.0
    await git.writeFile(
      'deno.json',
      JSON.stringify({ name: '@test/app', version: '1.0.0' }, null, 2) + '\n',
    );
    await git.commit('chore: initial project');

    await initWorkflow(git, { dryRun: false });
    await git.commit('chore: initialize pls');

    const versionsJson = await git.readFile('.pls/versions.json');
    const initialFiles = new Map<string, string>();
    initialFiles.set('.pls/versions.json', versionsJson!);
    initialFiles.set('deno.json', await git.readFile('deno.json') as string);

    const { host, getPR } = createStatefulHost(initialFiles);

    await t.step('first prep → 1.1.0 minor', async () => {
      await git.writeFile('src/feature.ts', 'export function hello() {}\n');
      await git.commit('feat: add greeting');

      const result = await prepWorkflow(git, host, {
        baseBranch: 'main',
        releaseBranch: 'pls-release',
        dryRun: false,
      });

      assertEquals(result.bump?.to, '1.1.0');
      assertEquals(result.bump?.type, 'minor');
    });

    await t.step('user checks alpha checkbox, re-run prep → keeps 1.1.0-alpha.0', async () => {
      // Simulate user checking the alpha checkbox in PR body
      const pr = getPR()!;
      const updatedBody = pr.body
        .replace(
          '- [ ] 1.1.0-alpha.0 (alpha)',
          '- [x] 1.1.0-alpha.0 (alpha)',
        );
      pr.body = updatedBody;

      const result = await prepWorkflow(git, host, {
        baseBranch: 'main',
        releaseBranch: 'pls-release',
        dryRun: false,
      });

      // User explicitly selected alpha — should be preserved
      assertEquals(result.bump?.to, '1.1.0-alpha.0', 'user selection should be preserved');

      const pr2 = getPR();
      assertEquals(pr2!.title, 'chore: release v1.1.0-alpha.0');
    });
  } finally {
    await cleanup();
  }
});

Deno.test('e2e: prep workflow — type matches actual version transition', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Setup: deno.json at 0.3.0
    await git.writeFile(
      'deno.json',
      JSON.stringify({ name: '@test/app', version: '0.3.0' }, null, 2) + '\n',
    );
    await git.commit('chore: initial project');

    await initWorkflow(git, { dryRun: false });
    await git.commit('chore: initialize pls');

    const versionsJson = await git.readFile('.pls/versions.json');
    const initialFiles = new Map<string, string>();
    initialFiles.set('.pls/versions.json', versionsJson!);
    initialFiles.set('deno.json', await git.readFile('deno.json') as string);

    const { host, getCommittedFiles } = createStatefulHost(initialFiles);

    await t.step('feat! on 0.3.0 → type should be minor, version 0.4.0', async () => {
      await git.writeFile('src/app.ts', 'export class App {}\n');
      await git.commit('feat!: breaking change');

      const result = await prepWorkflow(git, host, {
        baseBranch: 'main',
        releaseBranch: 'pls-release',
        dryRun: false,
      });

      assertEquals(result.bump?.to, '0.4.0');
      assertEquals(result.bump?.type, 'minor');

      // Verify committed versions.json is consistent
      const committedVersions = getCommittedFiles().get('.pls/versions.json');
      if (committedVersions) {
        const versions = JSON.parse(committedVersions);
        assertEquals(versions['.'].version, '0.4.0');
      }
    });
  } finally {
    await cleanup();
  }
});
