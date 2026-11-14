/**
 * Integration tests for local release workflow.
 *
 * These tests create real git repositories and test end-to-end release flows.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { PlsError } from '../lib/error.ts';
import type { LocalGit } from '../clients/git/local.ts';
import { localReleaseWorkflow, transitionWorkflow } from './local-release.ts';
import { createTestRepo, run } from '../../tests/e2e/test_helpers.ts';

/**
 * Set up a repo with initial version and tag.
 */
async function setupVersionedRepo(
  repo: LocalGit,
  version: string,
): Promise<void> {
  // Create versions.json
  await repo.writeFile(
    '.pls/versions.json',
    JSON.stringify({ '.': { version } }, null, 2),
  );

  // Create initial commit
  await repo.commitAll(`chore: init v${version}`);

  // Create initial tag
  await repo.createTag(`v${version}`, `Release ${version}`);
}

// --- Local Release Workflow ---

Deno.test('localReleaseWorkflow', async (t) => {
  await t.step('returns no changes when no commits since tag', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      const result = await localReleaseWorkflow(git, {
        dryRun: true,
        push: false,
      });

      assertEquals(result.released, false);
      assertEquals(result.version, null);
      assertEquals(result.bump, null);
    } finally {
      await cleanup();
    }
  });

  await t.step('calculates patch bump for fix commits', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      // Add a fix commit
      await git.writeFile('src/fix.ts', 'fixed code');
      await git.commitAll('fix: correct off-by-one error');

      const result = await localReleaseWorkflow(git, {
        dryRun: true,
        push: false,
      });

      assertEquals(result.released, false); // dry run
      assertEquals(result.dryRun, true);
      assertEquals(result.version, '1.0.1');
      assertEquals(result.tag, 'v1.0.1');
      assertEquals(result.bump?.type, 'patch');
      assertEquals(result.bump?.from, '1.0.0');
      assertEquals(result.bump?.to, '1.0.1');
    } finally {
      await cleanup();
    }
  });

  await t.step('calculates minor bump for feat commits', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      // Add feature commits
      await git.writeFile('src/feature.ts', 'new feature');
      await git.commitAll('feat: add new feature');

      await git.writeFile('src/fix.ts', 'fix');
      await git.commitAll('fix: small fix');

      const result = await localReleaseWorkflow(git, {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '1.1.0');
      assertEquals(result.bump?.type, 'minor');
    } finally {
      await cleanup();
    }
  });

  await t.step('calculates major bump for breaking changes', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      // Add breaking change
      await git.writeFile('src/api.ts', 'breaking api');
      await git.commitAll('feat!: redesign API');

      const result = await localReleaseWorkflow(git, {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '2.0.0');
      assertEquals(result.bump?.type, 'major');
    } finally {
      await cleanup();
    }
  });

  await t.step('creates release files when execute', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      // Add feature
      await git.writeFile('src/feature.ts', 'new feature');
      await git.commitAll('feat: add awesome feature');

      const result = await localReleaseWorkflow(git, {
        dryRun: false,
        push: false,
      });

      assertEquals(result.released, true);
      assertEquals(result.version, '1.1.0');
      assertEquals(result.tag, 'v1.1.0');

      // Verify files were created
      const versions = await git.readFile('.pls/versions.json');
      assertEquals(JSON.parse(versions!)['.'].version, '1.1.0');

      // Verify tag exists
      const tagExists = await git.tagExists('v1.1.0');
      assertEquals(tagExists, true);

      // Verify changelog was created
      const changelog = await git.readFile('CHANGELOG.md');
      assertStringIncludes(changelog!, '## 1.1.0');
      assertStringIncludes(changelog!, 'add awesome feature');
    } finally {
      await cleanup();
    }
  });

  await t.step('includes breaking changes in changelog', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      await git.writeFile('src/api.ts', 'new api');
      await git.commitAll('feat!: new authentication system');

      const result = await localReleaseWorkflow(git, {
        dryRun: false,
        push: false,
      });

      assertEquals(result.version, '2.0.0');

      const changelog = await git.readFile('CHANGELOG.md');
      assertStringIncludes(changelog!, 'Breaking Changes');
    } finally {
      await cleanup();
    }
  });
});

// --- Transition Workflow ---

Deno.test('a release commits its own files only', async (t) => {
  for (const kind of ['release', 'transition'] as const) {
    await t.step(kind, async () => {
      const { dir, git, cleanup } = await createTestRepo();

      try {
        await setupVersionedRepo(git, '1.0.0');
        await git.writeFile('src/feature.ts', 'export const a = 1;\n');
        await git.commitAll('feat: add a');

        // Work in progress that has nothing to do with the release.
        await git.writeFile('src/feature.ts', 'export const a = 2;\n');
        await git.writeFile('.env', 'TOKEN=secret\n');
        await git.writeFile('notes.md', 'staged\n');
        await run(dir, ['git', 'add', 'notes.md']);

        const result = kind === 'release'
          ? await localReleaseWorkflow(git, { dryRun: false, push: false })
          : await transitionWorkflow(git, 'alpha', 'minor', { dryRun: false, push: false });
        assertEquals(result.released, true);

        const changed = await run(dir, ['git', 'show', '--name-only', '--format=', 'HEAD']);
        assertEquals(changed.split('\n').sort(), ['.pls/versions.json', 'CHANGELOG.md']);

        // untracked, staged, modified and not staged
        const status = await run(dir, ['git', 'status', '--porcelain']);
        assertEquals(
          status.split('\n').map((line) => line.trim()).sort(),
          ['?? .env', 'A  notes.md', 'M src/feature.ts'],
        );
      } finally {
        await cleanup();
      }
    });
  }
});

Deno.test('a release with push', async (t) => {
  await t.step('pushes the release commit and the tag', async () => {
    const { dir, git, cleanup } = await createTestRepo();
    const remote = await Deno.makeTempDir({ prefix: 'pls-test-remote-' });

    try {
      await run(remote, ['git', 'init', '--bare', '-b', 'main']);
      await run(dir, ['git', 'remote', 'add', 'origin', remote]);
      await setupVersionedRepo(git, '1.0.0');
      await git.writeFile('src/feature.ts', 'export const a = 1;\n');
      await git.commitAll('feat: add a');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: true });
      assertEquals(result.tag, 'v1.1.0');

      assertEquals(await run(remote, ['git', 'rev-parse', 'main']), await git.getHeadRevision());
      assertEquals(await run(remote, ['git', 'tag']), 'v1.1.0');
    } finally {
      await cleanup();
      await Deno.remove(remote, { recursive: true });
    }
  });

  for (const kind of ['release', 'transition'] as const) {
    await t.step(`${kind}: a failed push says that the release exists`, async () => {
      // No remote: the push cannot work.
      const { git, cleanup } = await createTestRepo();

      try {
        await setupVersionedRepo(git, '1.0.0');
        await git.writeFile('src/feature.ts', 'export const a = 1;\n');
        await git.commitAll('feat: add a');

        const tag = kind === 'release' ? 'v1.1.0' : 'v1.1.0-alpha.0';
        const error = await assertRejects(
          () =>
            kind === 'release'
              ? localReleaseWorkflow(git, { dryRun: false, push: true })
              : transitionWorkflow(git, 'alpha', 'minor', { dryRun: false, push: true }),
          PlsError,
        );
        assertEquals(error.code, 'PUSH_FAILED');
        assertStringIncludes(error.message, `Released ${tag} in this repository`);
        assertStringIncludes(error.message, 'git push origin HEAD');
        assertStringIncludes(error.message, `git push origin HEAD && git push origin ${tag}`);
        assertEquals(await git.tagExists(tag), true);
      } finally {
        await cleanup();
      }
    });
  }
});

Deno.test('transitionWorkflow', async (t) => {
  await t.step('transitions stable to alpha', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      const result = await transitionWorkflow(git, 'alpha', 'minor', {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '1.1.0-alpha.0');
      assertEquals(result.tag, 'v1.1.0-alpha.0');
    } finally {
      await cleanup();
    }
  });

  await t.step('transitions alpha to beta', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.1.0-alpha.3');

      const result = await transitionWorkflow(git, 'beta', 'minor', {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '1.1.0-beta.0');
    } finally {
      await cleanup();
    }
  });

  await t.step('transitions beta to rc', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.1.0-beta.2');

      const result = await transitionWorkflow(git, 'rc', 'minor', {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '1.1.0-rc.0');
    } finally {
      await cleanup();
    }
  });

  await t.step('transitions rc to stable', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.1.0-rc.1');

      const result = await transitionWorkflow(git, 'stable', 'minor', {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '1.1.0');
    } finally {
      await cleanup();
    }
  });

  await t.step('creates files when execute', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      const result = await transitionWorkflow(git, 'alpha', 'minor', {
        dryRun: false,
        push: false,
      });

      assertEquals(result.released, true);
      assertEquals(result.version, '1.1.0-alpha.0');

      // Verify tag created
      const tagExists = await git.tagExists('v1.1.0-alpha.0');
      assertEquals(tagExists, true);

      // Verify versions updated
      const versions = await git.readFile('.pls/versions.json');
      assertEquals(JSON.parse(versions!)['.'].version, '1.1.0-alpha.0');
    } finally {
      await cleanup();
    }
  });

  await t.step('respects major bump type', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      const result = await transitionWorkflow(git, 'alpha', 'major', {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '2.0.0-alpha.0');
    } finally {
      await cleanup();
    }
  });

  await t.step('respects patch bump type', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      await setupVersionedRepo(git, '1.0.0');

      const result = await transitionWorkflow(git, 'alpha', 'patch', {
        dryRun: true,
        push: false,
      });

      assertEquals(result.version, '1.0.1-alpha.0');
    } finally {
      await cleanup();
    }
  });
});

// --- Version File Sync ---

Deno.test('workflow syncs TypeScript version file', async (t) => {
  await t.step('updates versionFile when configured', async () => {
    const { git, cleanup } = await createTestRepo();

    try {
      // Set up with versionFile configured
      await git.writeFile(
        '.pls/versions.json',
        JSON.stringify(
          {
            '.': {
              version: '1.0.0',
              versionFile: 'src/version.ts',
            },
          },
          null,
          2,
        ),
      );

      // Create the version file (requires magic comment)
      await git.writeFile(
        'src/version.ts',
        '// @pls-version\nexport const VERSION = "1.0.0";\n',
      );

      await git.commitAll('chore: init v1.0.0');
      await git.createTag('v1.0.0', 'Release 1.0.0');

      // Add a feature
      await git.writeFile('src/feature.ts', 'feature');
      await git.commitAll('feat: new feature');

      const result = await localReleaseWorkflow(git, {
        dryRun: false,
        push: false,
      });

      assertEquals(result.version, '1.1.0');

      // Verify version file was updated (preserves original double quotes)
      const versionContent = await git.readFile('src/version.ts');
      assertStringIncludes(versionContent!, 'VERSION = "1.1.0"');
    } finally {
      await cleanup();
    }
  });
});
