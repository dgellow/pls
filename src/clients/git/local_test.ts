/**
 * Integration tests for LocalGit client.
 *
 * These tests create real git repositories in temp directories.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { PlsError } from '../../lib/error.ts';
import { createTestRepo } from '../../../tests/e2e/test_helpers.ts';

// --- File Operations ---

Deno.test('LocalGit file operations', async (t) => {
  const { dir, git, cleanup } = await createTestRepo();

  try {
    await t.step('writeFile creates file with content', async () => {
      await git.writeFile('test.txt', 'hello world');

      const content = await Deno.readTextFile(`${dir}/test.txt`);
      assertEquals(content, 'hello world');
    });

    await t.step('writeFile creates nested directories', async () => {
      await git.writeFile('nested/deep/file.txt', 'nested content');

      const content = await Deno.readTextFile(`${dir}/nested/deep/file.txt`);
      assertEquals(content, 'nested content');
    });

    await t.step('readFile returns file content', async () => {
      const content = await git.readFile('test.txt');
      assertEquals(content, 'hello world');
    });

    await t.step('readFile returns null for missing file', async () => {
      const content = await git.readFile('nonexistent.txt');
      assertEquals(content, null);
    });

    await t.step('fileExists returns true for existing file', async () => {
      const exists = await git.fileExists('test.txt');
      assertEquals(exists, true);
    });

    await t.step('fileExists returns false for missing file', async () => {
      const exists = await git.fileExists('nonexistent.txt');
      assertEquals(exists, false);
    });
  } finally {
    await cleanup();
  }
});

// --- Commit Operations ---

Deno.test('LocalGit commit operations', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await t.step('commit stages and commits changes', async () => {
      await git.writeFile('file.txt', 'content');
      const rev = await git.commit('feat: initial commit');

      // Revision should be 40 hex characters
      assertEquals(rev.length, 40);
      assertEquals(/^[0-9a-f]+$/.test(rev), true);
    });

    await t.step('getHeadRevision returns current commit', async () => {
      const rev = await git.getHeadRevision();
      assertEquals(rev.length, 40);
    });

    await t.step('getCommitMessage returns commit message', async () => {
      const message = await git.getCommitMessage('HEAD');
      assertEquals(message.trim(), 'feat: initial commit');
    });

    await t.step('getCommitsSince returns commits after revision', async () => {
      const firstRev = await git.getHeadRevision();

      // Create more commits
      await git.writeFile('file2.txt', 'content2');
      await git.commit('fix: second commit');

      await git.writeFile('file3.txt', 'content3');
      await git.commit('feat: third commit');

      const commits = await git.getCommitsSince(firstRev);

      assertEquals(commits.length, 2);
      assertEquals(commits[0].type, 'feat');
      assertEquals(commits[0].description, 'third commit');
      assertEquals(commits[1].type, 'fix');
      assertEquals(commits[1].description, 'second commit');
    });

    await t.step('getCommitsSince with null returns all commits', async () => {
      const commits = await git.getCommitsSince(null);
      assertEquals(commits.length, 3);
    });
  } finally {
    await cleanup();
  }
});

// --- Tag Operations ---

Deno.test('LocalGit tag operations', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Create initial commit (required for tags)
    await git.writeFile('file.txt', 'content');
    await git.commit('feat: initial');
    const commitRev = await git.getHeadRevision();

    await t.step('createTag creates annotated tag', async () => {
      await git.createTag('v1.0.0', 'Release 1.0.0');

      // Verify tag exists
      const exists = await git.tagExists('v1.0.0');
      assertEquals(exists, true);
    });

    await t.step('getTagRevision returns commit revision', async () => {
      const rev = await git.getTagRevision('v1.0.0');
      assertEquals(rev, commitRev);
    });

    await t.step('getTagRevision returns null for missing tag', async () => {
      const rev = await git.getTagRevision('nonexistent');
      assertEquals(rev, null);
    });

    await t.step('getTagMessage returns tag message', async () => {
      const message = await git.getTagMessage('v1.0.0');
      assertEquals(message?.trim(), 'Release 1.0.0');
    });

    await t.step('tagExists returns false for missing tag', async () => {
      const exists = await git.tagExists('nonexistent');
      assertEquals(exists, false);
    });
  } finally {
    await cleanup();
  }
});

// --- Revision Operations ---

Deno.test('LocalGit revision operations', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await git.writeFile('file.txt', 'content');
    await git.commit('feat: initial');
    const rev = await git.getHeadRevision();

    await t.step('revExists returns true for valid revision', async () => {
      const exists = await git.revExists(rev);
      assertEquals(exists, true);
    });

    await t.step('revExists returns false for invalid revision', async () => {
      const exists = await git.revExists('0000000000000000000000000000000000000000');
      assertEquals(exists, false);
    });
  } finally {
    await cleanup();
  }
});

// --- Content Search ---

Deno.test('LocalGit findCommitByContent', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    // Create file with version
    await git.writeFile('.pls/versions.json', '{"version": "1.0.0"}');
    await git.commit('chore: release v1.0.0');
    const releaseRev = await git.getHeadRevision();

    // Create more commits
    await git.writeFile('other.txt', 'unrelated');
    await git.commit('feat: other change');

    await t.step('finds commit that introduced string', async () => {
      const rev = await git.findCommitByContent('"version": "1.0.0"', '.pls/versions.json');
      assertEquals(rev, releaseRev);
    });

    await t.step('returns null for non-existent string', async () => {
      const rev = await git.findCommitByContent('nonexistent', '.pls/versions.json');
      assertEquals(rev, null);
    });
  } finally {
    await cleanup();
  }
});

// --- Branch Operations ---

Deno.test('LocalGit branch operations', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await git.writeFile('file.txt', 'content');
    await git.commit('feat: initial');

    await t.step('getCurrentBranch returns branch name', async () => {
      const branch = await git.getCurrentBranch();
      assertEquals(branch, 'main');
    });

    await t.step('checkoutBranch creates and switches to branch', async () => {
      await git.checkoutBranch('feature', 'HEAD');
      const branch = await git.getCurrentBranch();
      assertEquals(branch, 'feature');
    });
  } finally {
    await cleanup();
  }
});

// --- Error Handling ---

Deno.test('LocalGit error handling', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await t.step('commit with no changes throws PlsError', async () => {
      await assertRejects(
        async () => {
          await git.commit('empty commit');
        },
        PlsError,
        'Git command failed',
      );
    });
  } finally {
    await cleanup();
  }
});

// --- Conventional Commits Parsing ---

Deno.test('LocalGit parses conventional commits', async (t) => {
  const { git, cleanup } = await createTestRepo();

  try {
    await t.step('parses type, scope, and description', async () => {
      await git.writeFile('file.txt', 'content');
      await git.commit('feat(api): add new endpoint');

      const commits = await git.getCommitsSince(null);
      assertEquals(commits.length, 1);
      assertEquals(commits[0].type, 'feat');
      assertEquals(commits[0].scope, 'api');
      assertEquals(commits[0].description, 'add new endpoint');
    });

    await t.step('parses breaking change indicator', async () => {
      await git.writeFile('file2.txt', 'content');
      await git.commit('feat!: breaking change');

      const commits = await git.getCommitsSince(null);
      const breaking = commits.find((c) => c.breaking);
      assertEquals(breaking?.breaking, true);
      assertEquals(breaking?.description, 'breaking change');
    });

    await t.step('parses BREAKING CHANGE footer', async () => {
      await git.writeFile('file3.txt', 'content');
      await git.commit('feat: normal commit\n\nBREAKING CHANGE: this breaks things');

      const commits = await git.getCommitsSince(null);
      const breaking = commits.find((c) => c.description === 'normal commit');
      assertEquals(breaking?.breaking, true);
    });
  } finally {
    await cleanup();
  }
});
