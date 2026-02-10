/**
 * End-to-end release cycle tests per ecosystem.
 *
 * Each test creates a real git repo with realistic project files,
 * runs through init and release, then verifies every output artifact.
 *
 * File contents are verified with assertSnapshot for precise regression
 * detection. Run with `-- --update` to regenerate snapshots.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { assertSnapshot } from '@std/testing/snapshot';
import { createTestRepo } from './test_helpers.ts';
import { initWorkflow } from '../../src/workflows/init.ts';
import { localReleaseWorkflow } from '../../src/workflows/local-release.ts';
import { PlsError } from '../../src/lib/error.ts';

// --- Deno ecosystem ---

Deno.test('e2e: Deno project — full release cycle', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Setup: deno.json with version + version file with @pls-version marker
    await git.writeFile(
      'deno.json',
      JSON.stringify({ name: '@test/app', version: '1.0.0' }, null, 2) + '\n',
    );
    await git.writeFile(
      'src/version.ts',
      '// @pls-version\nexport const VERSION = "1.0.0";\n',
    );
    await git.commit('chore: initial project');

    await t.step('init detects version from deno.json', async (t) => {
      const result = await initWorkflow(git, {
        versionFile: 'src/version.ts',
        dryRun: false,
      });

      assertEquals(result.version, '1.0.0');
      assertEquals(result.tag, 'v1.0.0');
      assertEquals(result.dryRun, false);
      assertEquals(result.filesCreated.includes('.pls/versions.json'), true);
      assertEquals(await git.tagExists('v1.0.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Deno > init > versions.json',
      });
    });

    // Commit init files (initWorkflow writes but doesn't commit)
    await git.commit('chore: initialize pls');

    await t.step('release after feat commit bumps minor', async (t) => {
      // Add a feature
      await git.writeFile('src/greeting.ts', 'export function hello() { return "hi"; }\n');
      await git.commit('feat: add greeting');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '1.1.0');
      assertEquals(result.tag, 'v1.1.0');
      assertEquals(result.bump?.type, 'minor');
      assertEquals(result.bump?.from, '1.0.0');
      assertEquals(result.bump?.to, '1.1.0');
      assertEquals(await git.tagExists('v1.1.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Deno > release > versions.json',
      });
      await assertSnapshot(t, await git.readFile('deno.json'), {
        name: 'Deno > release > deno.json',
      });
      await assertSnapshot(t, await git.readFile('src/version.ts'), {
        name: 'Deno > release > version.ts',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Deno > release > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Deno > release > commit message',
      });
    });

    await t.step('second release after fix commit bumps patch', async (t) => {
      await git.writeFile('src/greeting.ts', 'export function hello() { return "hello"; }\n');
      await git.commit('fix: correct greeting message');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '1.1.1');
      assertEquals(result.tag, 'v1.1.1');
      assertEquals(result.bump?.type, 'patch');
      assertEquals(result.bump?.from, '1.1.0');
      assertEquals(result.bump?.to, '1.1.1');
      assertEquals(await git.tagExists('v1.1.1'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Deno > release2 > versions.json',
      });
      await assertSnapshot(t, await git.readFile('deno.json'), {
        name: 'Deno > release2 > deno.json',
      });
      await assertSnapshot(t, await git.readFile('src/version.ts'), {
        name: 'Deno > release2 > version.ts',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Deno > release2 > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Deno > release2 > commit message',
      });
    });
  } finally {
    await cleanup();
  }
});

// --- Node ecosystem ---

Deno.test('e2e: Node project — full release cycle', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await git.writeFile(
      'package.json',
      JSON.stringify({ name: 'test-app', version: '2.0.0' }, null, 2) + '\n',
    );
    await git.writeFile(
      'src/version.ts',
      '// @pls-version\nexport const VERSION = "2.0.0";\n',
    );
    await git.commit('chore: initial project');

    await t.step('init detects version from package.json', async (t) => {
      const result = await initWorkflow(git, {
        versionFile: 'src/version.ts',
        dryRun: false,
      });

      assertEquals(result.version, '2.0.0');
      assertEquals(result.tag, 'v2.0.0');
      assertEquals(await git.tagExists('v2.0.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Node > init > versions.json',
      });
    });

    await git.commit('chore: initialize pls');

    await t.step('release after fix commit bumps patch', async (t) => {
      await git.writeFile('src/bug.ts', 'export function fixed() {}\n');
      await git.commit('fix: resolve crash on startup');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '2.0.1');
      assertEquals(result.bump?.type, 'patch');
      assertEquals(await git.tagExists('v2.0.1'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Node > release > versions.json',
      });
      await assertSnapshot(t, await git.readFile('package.json'), {
        name: 'Node > release > package.json',
      });
      await assertSnapshot(t, await git.readFile('src/version.ts'), {
        name: 'Node > release > version.ts',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Node > release > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Node > release > commit message',
      });
    });

    await t.step('second release after feat commit bumps minor', async (t) => {
      await git.writeFile('src/feature.ts', 'export function newFeature() {}\n');
      await git.commit('feat: add new feature');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '2.1.0');
      assertEquals(result.tag, 'v2.1.0');
      assertEquals(result.bump?.type, 'minor');
      assertEquals(result.bump?.from, '2.0.1');
      assertEquals(result.bump?.to, '2.1.0');
      assertEquals(await git.tagExists('v2.1.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Node > release2 > versions.json',
      });
      await assertSnapshot(t, await git.readFile('package.json'), {
        name: 'Node > release2 > package.json',
      });
      await assertSnapshot(t, await git.readFile('src/version.ts'), {
        name: 'Node > release2 > version.ts',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Node > release2 > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Node > release2 > commit message',
      });
    });
  } finally {
    await cleanup();
  }
});

// --- Go ecosystem (modeled after openai/openai-go) ---

Deno.test('e2e: Go project — full release cycle', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Realistic Go project layout: go.mod + internal/version.go with PackageVersion constant
    await git.writeFile('go.mod', 'module github.com/example/app\n\ngo 1.22\n');
    await git.writeFile('go.sum', '');
    await git.writeFile(
      'internal/version.go',
      'package internal\n\n// @pls-version\nconst PackageVersion = "1.0.0"\n',
    );
    await git.writeFile(
      'cmd/app/main.go',
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n',
    );
    await git.commit('chore: initial project');

    await t.step('init without --version fails for Go', async () => {
      await assertRejects(
        () => initWorkflow(git, { versionFile: 'internal/version.go', dryRun: false }),
        PlsError,
        'Could not detect version',
      );
    });

    await t.step('init with --version succeeds', async (t) => {
      const result = await initWorkflow(git, {
        version: '1.0.0',
        versionFile: 'internal/version.go',
        dryRun: false,
      });

      assertEquals(result.version, '1.0.0');
      assertEquals(await git.tagExists('v1.0.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Go > init > versions.json',
      });
    });

    await git.commit('chore: initialize pls');

    await t.step('release updates version file but not go.mod', async (t) => {
      await git.writeFile('internal/client.go', 'package internal\n\ntype Client struct{}\n');
      await git.commit('feat: add HTTP client');

      await git.writeFile('internal/handler.go', 'package internal\n\nfunc Handle() {}\n');
      await git.commit('fix: handle edge case');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '1.1.0');
      assertEquals(await git.tagExists('v1.1.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Go > release > versions.json',
      });
      await assertSnapshot(t, await git.readFile('internal/version.go'), {
        name: 'Go > release > version.go',
      });
      await assertSnapshot(t, await git.readFile('go.mod'), {
        name: 'Go > release > go.mod (unchanged)',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Go > release > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Go > release > commit message',
      });
    });

    await t.step('second release after fix commit bumps patch', async (t) => {
      await git.writeFile(
        'internal/handler.go',
        'package internal\n\nfunc Handle() error { return nil }\n',
      );
      await git.commit('fix: return error from handler');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '1.1.1');
      assertEquals(result.tag, 'v1.1.1');
      assertEquals(result.bump?.type, 'patch');
      assertEquals(result.bump?.from, '1.1.0');
      assertEquals(result.bump?.to, '1.1.1');
      assertEquals(await git.tagExists('v1.1.1'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Go > release2 > versions.json',
      });
      await assertSnapshot(t, await git.readFile('internal/version.go'), {
        name: 'Go > release2 > version.go',
      });
      await assertSnapshot(t, await git.readFile('go.mod'), {
        name: 'Go > release2 > go.mod (unchanged)',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Go > release2 > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Go > release2 > commit message',
      });
    });
  } finally {
    await cleanup();
  }
});

// --- Python/uv ecosystem (modeled after openai/openai-python) ---

Deno.test('e2e: Python/uv project — full release cycle', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Realistic uv project layout: pyproject.toml + src/pkg/_version.py
    const pyprojectToml = [
      '[project]',
      'name = "mypackage"',
      'version = "0.1.0"',
      'description = "A test package"',
      'requires-python = ">= 3.10"',
      '',
      '[build-system]',
      'requires = ["hatchling"]',
      'build-backend = "hatchling.build"',
      '',
    ].join('\n');
    await git.writeFile('pyproject.toml', pyprojectToml);
    await git.writeFile(
      'src/mypackage/_version.py',
      '# @pls-version\n__version__ = "0.1.0"\n',
    );
    await git.writeFile('src/mypackage/__init__.py', 'from ._version import __version__\n');
    await git.writeFile('src/mypackage/core.py', 'def run() -> None:\n    pass\n');
    await git.commit('chore: initial project');

    await t.step('init without --version fails (no recognized manifest)', async () => {
      await assertRejects(
        () =>
          initWorkflow(git, {
            versionFile: 'src/mypackage/_version.py',
            dryRun: false,
          }),
        PlsError,
        'Could not detect version',
      );
    });

    await t.step('init with --version succeeds', async (t) => {
      const result = await initWorkflow(git, {
        version: '0.1.0',
        versionFile: 'src/mypackage/_version.py',
        dryRun: false,
      });

      assertEquals(result.version, '0.1.0');
      assertEquals(await git.tagExists('v0.1.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Python > init > versions.json',
      });
    });

    await git.commit('chore: initialize pls');

    await t.step('release updates version file, pyproject.toml unchanged', async (t) => {
      await git.writeFile('src/mypackage/feature.py', 'def new_feature() -> None:\n    pass\n');
      await git.commit('feat: add new feature');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '0.2.0');
      assertEquals(await git.tagExists('v0.2.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Python > release > versions.json',
      });
      await assertSnapshot(t, await git.readFile('src/mypackage/_version.py'), {
        name: 'Python > release > _version.py',
      });
      await assertSnapshot(t, await git.readFile('pyproject.toml'), {
        name: 'Python > release > pyproject.toml (unchanged)',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Python > release > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Python > release > commit message',
      });
    });

    await t.step('second release after fix commit bumps patch', async (t) => {
      await git.writeFile(
        'src/mypackage/feature.py',
        'def new_feature() -> str:\n    return "fixed"\n',
      );
      await git.commit('fix: correct feature return type');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '0.2.1');
      assertEquals(result.tag, 'v0.2.1');
      assertEquals(result.bump?.type, 'patch');
      assertEquals(result.bump?.from, '0.2.0');
      assertEquals(result.bump?.to, '0.2.1');
      assertEquals(await git.tagExists('v0.2.1'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Python > release2 > versions.json',
      });
      await assertSnapshot(t, await git.readFile('src/mypackage/_version.py'), {
        name: 'Python > release2 > _version.py',
      });
      await assertSnapshot(t, await git.readFile('pyproject.toml'), {
        name: 'Python > release2 > pyproject.toml (unchanged)',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Python > release2 > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Python > release2 > commit message',
      });
    });
  } finally {
    await cleanup();
  }
});

// --- Multi-manifest ---

Deno.test('e2e: Multi-manifest project — both deno.json and package.json updated', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await git.writeFile(
      'deno.json',
      JSON.stringify({ name: '@test/multi', version: '3.0.0' }, null, 2) + '\n',
    );
    await git.writeFile(
      'package.json',
      JSON.stringify({ name: 'test-multi', version: '3.0.0' }, null, 2) + '\n',
    );
    await git.writeFile(
      'src/version.ts',
      '// @pls-version\nexport const VERSION = "3.0.0";\n',
    );
    await git.commit('chore: initial project');

    await t.step('init detects version from deno.json (priority)', async () => {
      const result = await initWorkflow(git, {
        versionFile: 'src/version.ts',
        dryRun: false,
      });

      assertEquals(result.version, '3.0.0');
    });

    await git.commit('chore: initialize pls');

    await t.step('release updates both manifests', async (t) => {
      await git.writeFile('src/feature.ts', 'export const x = 1;\n');
      await git.commit('feat!: breaking redesign');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '4.0.0');
      assertEquals(result.bump?.type, 'major');
      assertEquals(await git.tagExists('v4.0.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Multi > release > versions.json',
      });
      await assertSnapshot(t, await git.readFile('deno.json'), {
        name: 'Multi > release > deno.json',
      });
      await assertSnapshot(t, await git.readFile('package.json'), {
        name: 'Multi > release > package.json',
      });
      await assertSnapshot(t, await git.readFile('src/version.ts'), {
        name: 'Multi > release > version.ts',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Multi > release > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Multi > release > commit message',
      });
    });

    await t.step('second release after feat commit bumps minor', async (t) => {
      await git.writeFile('src/utils.ts', 'export function helper() { return true; }\n');
      await git.commit('feat: add utility helpers');

      const result = await localReleaseWorkflow(git, { dryRun: false, push: false });

      assertEquals(result.released, true);
      assertEquals(result.version, '4.1.0');
      assertEquals(result.tag, 'v4.1.0');
      assertEquals(result.bump?.type, 'minor');
      assertEquals(result.bump?.from, '4.0.0');
      assertEquals(result.bump?.to, '4.1.0');
      assertEquals(await git.tagExists('v4.1.0'), true);

      await assertSnapshot(t, await git.readFile('.pls/versions.json'), {
        name: 'Multi > release2 > versions.json',
      });
      await assertSnapshot(t, await git.readFile('deno.json'), {
        name: 'Multi > release2 > deno.json',
      });
      await assertSnapshot(t, await git.readFile('package.json'), {
        name: 'Multi > release2 > package.json',
      });
      await assertSnapshot(t, await git.readFile('src/version.ts'), {
        name: 'Multi > release2 > version.ts',
      });
      await assertSnapshot(t, await git.readFile('CHANGELOG.md'), {
        name: 'Multi > release2 > CHANGELOG.md',
      });
      await assertSnapshot(t, await git.getCommitMessage('HEAD'), {
        name: 'Multi > release2 > commit message',
      });
    });
  } finally {
    await cleanup();
  }
});
