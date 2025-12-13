/**
 * Tests for PR release workflow.
 */

import { assertEquals } from '@std/assert';
import type { LocalGit } from '../clients/local-git.ts';
import type { GitHub } from '../clients/github.ts';
import type { Commit, ReleaseTag } from '../domain/types.ts';
import { releaseWorkflow } from './pr-release.ts';

/**
 * Create a mock LocalGit client.
 */
function createMockGit(overrides: Partial<LocalGit> = {}): LocalGit {
  return {
    readFile: () => Promise.resolve(null),
    fileExists: () => Promise.resolve(false),
    getCommitsSince: () => Promise.resolve([]),
    getHeadSha: () => Promise.resolve('head-sha'),
    getCommitMessage: () => Promise.resolve(''),
    getTagSha: () => Promise.resolve(null),
    getTagMessage: () => Promise.resolve(null),
    tagExists: () => Promise.resolve(false),
    writeFile: () => Promise.resolve(),
    commit: () => Promise.resolve('new-sha'),
    createTag: () => Promise.resolve(),
    push: () => Promise.resolve(),
    findCommitByContent: () => Promise.resolve(null),
    ...overrides,
  } as LocalGit;
}

/**
 * Create a mock GitHub client.
 */
function createMockGitHub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    readFile: () => Promise.resolve(null),
    fileExists: () => Promise.resolve(false),
    commit: () => Promise.resolve('new-sha'),
    getBranchSha: () => Promise.resolve(null),
    pointBranch: () => Promise.resolve(),
    createBranch: () => Promise.resolve(),
    branchExists: () => Promise.resolve(false),
    ensureBranch: () => Promise.resolve(),
    createTag: () => Promise.resolve(),
    getTag: () => Promise.resolve(null),
    findPR: () => Promise.resolve(null),
    findMergedPR: () => Promise.resolve(null),
    getPR: () => Promise.resolve({ number: 1, title: '', body: '', branch: '', url: '' }),
    createPR: () => Promise.resolve({ number: 1, title: '', body: '', branch: '', url: '' }),
    updatePR: () => Promise.resolve(),
    createRelease: () => Promise.resolve(''),
    releaseExists: () => Promise.resolve(false),
    ...overrides,
  } as GitHub;
}

function makeCommit(type: string, description: string): Commit {
  return {
    sha: 'abc123',
    type,
    scope: null,
    description,
    breaking: false,
    body: null,
  };
}

Deno.test('releaseWorkflow', async (t) => {
  await t.step('gets commits since previous release tag, not all commits', async () => {
    const previousTagSha = 'previous-release-sha';
    let capturedSinceSha: string | null = 'not-called';

    const git = createMockGit({
      getHeadSha: () => Promise.resolve('head-sha'),
      getCommitMessage: () =>
        Promise.resolve(`chore: release v1.1.0

---pls-release---
version: 1.1.0
from: 1.0.0
type: minor
---pls-release---`),
      getCommitsSince: (sha) => {
        capturedSinceSha = sha;
        return Promise.resolve([makeCommit('feat', 'new feature')]);
      },
    });

    const github = createMockGitHub({
      getTag: (name) => {
        if (name === 'v1.1.0') {
          // New tag doesn't exist yet
          return Promise.resolve(null);
        }
        if (name === 'v1.0.0') {
          // Previous release tag exists
          return Promise.resolve({
            name: 'v1.0.0',
            sha: previousTagSha,
            message: 'Release v1.0.0',
            isPlsRelease: true,
            metadata: { version: '1.0.0', from: '0.9.0', type: 'minor' },
          } as ReleaseTag);
        }
        return Promise.resolve(null);
      },
      createTag: () => Promise.resolve(),
      createRelease: () => Promise.resolve('https://github.com/test/releases/v1.1.0'),
    });

    await releaseWorkflow(git, github);

    // Should have called getCommitsSince with the previous tag's SHA
    assertEquals(capturedSinceSha, previousTagSha);
  });

  await t.step('handles missing previous tag gracefully', async () => {
    let capturedSinceSha: string | null = 'not-called';

    const git = createMockGit({
      getHeadSha: () => Promise.resolve('head-sha'),
      getCommitMessage: () =>
        Promise.resolve(`chore: release v1.0.0

---pls-release---
version: 1.0.0
from: 0.0.0
type: minor
---pls-release---`),
      getCommitsSince: (sha) => {
        capturedSinceSha = sha;
        return Promise.resolve([makeCommit('feat', 'initial feature')]);
      },
    });

    const github = createMockGitHub({
      getTag: () => Promise.resolve(null), // No tags exist
      createTag: () => Promise.resolve(),
      createRelease: () => Promise.resolve('https://github.com/test/releases/v1.0.0'),
    });

    await releaseWorkflow(git, github);

    // Should have called getCommitsSince with null (no previous tag)
    assertEquals(capturedSinceSha, null);
  });
});
