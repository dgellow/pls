/**
 * Integration tests for local release workflow.
 *
 * These tests create real git repositories and test end-to-end release flows.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import { LocalGit } from '../clients/local-git.ts';
import { localReleaseWorkflow, transitionWorkflow } from './local-release.ts';

/**
 * Helper to create a test git repository with initial setup.
 */
async function createTestRepo(): Promise<{
  dir: string;
  git: LocalGit;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: 'pls-workflow-test-' });

  // Initialize git repo with explicit branch name
  await run(dir, ['git', 'init', '-b', 'main']);

  // Configure git user for commits
  await run(dir, ['git', 'config', 'user.email', 'test@example.com']);
  await run(dir, ['git', 'config', 'user.name', 'Test User']);

  // Disable commit signing
  await run(dir, ['git', 'config', 'commit.gpgsign', 'false']);
  await run(dir, ['git', 'config', 'tag.gpgsign', 'false']);

  const git = new LocalGit(dir);

  const cleanup = async () => {
    await Deno.remove(dir, { recursive: true });
  };

  return { dir, git, cleanup };
}

/**
 * Run a command in a directory.
 */
async function run(cwd: string, cmd: string[]): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Command failed: ${cmd.join(' ')}\n${error}`);
  }

  return new TextDecoder().decode(stdout).trim();
}

/**
 * Set up a repo with initial version and tag.
 */
async function setupVersionedRepo(
  git: LocalGit,
  version: string,
): Promise<void> {
  // Create versions.json
  await git.writeFile(
    '.pls/versions.json',
    JSON.stringify({ '.': { version } }, null, 2),
  );

  // Create initial commit
  await git.commit(`chore: init v${version}`);

  // Create initial tag
  await git.createTag(`v${version}`, `Release ${version}`);
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
      await git.commit('fix: correct off-by-one error');

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
      await git.commit('feat: add new feature');

      await git.writeFile('src/fix.ts', 'fix');
      await git.commit('fix: small fix');

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
      await git.commit('feat!: redesign API');

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
      await git.commit('feat: add awesome feature');

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
      await git.commit('feat!: new authentication system');

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

      await git.commit('chore: init v1.0.0');
      await git.createTag('v1.0.0', 'Release 1.0.0');

      // Add a feature
      await git.writeFile('src/feature.ts', 'feature');
      await git.commit('feat: new feature');

      const result = await localReleaseWorkflow(git, {
        dryRun: false,
        push: false,
      });

      assertEquals(result.version, '1.1.0');

      // Verify version file was updated (uses single quotes)
      const versionContent = await git.readFile('src/version.ts');
      assertStringIncludes(versionContent!, "VERSION = '1.1.0'");
    } finally {
      await cleanup();
    }
  });
});
