/**
 * Tests for PR release workflow.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { CodeHost, LocalRepo } from '../domain/vcs.ts';
import type { Commit, ReleaseTag } from '../domain/types.ts';
import { PlsError } from '../lib/error.ts';
import { releaseWorkflow } from './pr-release.ts';

/**
 * Create a mock LocalRepo.
 */
function createMockRepo(overrides: Partial<LocalRepo> = {}): LocalRepo {
  return {
    readFile: () => Promise.resolve(null),
    fileExists: () => Promise.resolve(false),
    getCommitsSince: () => Promise.resolve([]),
    getHeadRevision: () => Promise.resolve('head-rev'),
    getCommitMessage: () => Promise.resolve(''),
    getTagRevision: () => Promise.resolve(null),
    getTagMessage: () => Promise.resolve(null),
    tagExists: () => Promise.resolve(false),
    writeFile: () => Promise.resolve(),
    commit: () => Promise.resolve('new-rev'),
    createTag: () => Promise.resolve(),
    push: () => Promise.resolve(),
    findCommitByContent: () => Promise.resolve(null),
    ...overrides,
  } as LocalRepo;
}

/**
 * Create a mock GitHub client.
 */
function createMockHost(overrides: Partial<CodeHost> = {}): CodeHost {
  return {
    readFile: () => Promise.resolve(null),
    fileExists: () => Promise.resolve(false),
    commit: () => Promise.resolve('new-rev'),
    getBranchRevision: () => Promise.resolve(null),
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
    getReleaseUrl: () => Promise.resolve(null),
    ...overrides,
  } as CodeHost;
}

/** Overrides for a repository whose HEAD is the release commit that set `version`. */
function atReleaseCommit(
  version: string,
  from: string,
  type: 'major' | 'minor' | 'patch' = 'minor',
): Partial<LocalRepo> {
  return {
    getHeadRevision: () => Promise.resolve('head-rev'),
    readFile: (path) =>
      Promise.resolve(
        path === '.pls/versions.json' ? JSON.stringify({ '.': { version } }, null, 2) + '\n' : null,
      ),
    findCommitByContent: () => Promise.resolve('head-rev'),
    getCommitMessage: () =>
      Promise.resolve(
        `chore: release v${version}\n\n---pls-release---\nversion: ${version}\n` +
          `from: ${from}\ntype: ${type}\n---pls-release---`,
      ),
  };
}

function makeCommit(type: string, description: string): Commit {
  return {
    rev: 'abc123',
    type,
    scope: null,
    description,
    breaking: false,
    body: null,
    merge: false,
  };
}

Deno.test('releaseWorkflow', async (t) => {
  await t.step('gets commits since previous release tag, not all commits', async () => {
    const previousTagRev = 'previous-release-rev';
    let capturedSinceRev: string | null = 'not-called';

    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
      getCommitsSince: (rev) => {
        capturedSinceRev = rev;
        return Promise.resolve([makeCommit('feat', 'new feature')]);
      },
    });

    const host = createMockHost({
      getTag: (name) => {
        if (name === 'v1.1.0') {
          // New tag doesn't exist yet
          return Promise.resolve(null);
        }
        if (name === 'v1.0.0') {
          // Previous release tag exists
          return Promise.resolve({
            name: 'v1.0.0',
            rev: previousTagRev,
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

    await releaseWorkflow(repo, host);

    // Should have called getCommitsSince with the previous tag's revision
    assertEquals(capturedSinceRev, previousTagRev);
  });

  await t.step('handles missing previous tag gracefully', async () => {
    let capturedSinceRev: string | null = 'not-called';

    const repo = createMockRepo({
      ...atReleaseCommit('1.0.0', '0.0.0'),
      getCommitsSince: (rev) => {
        capturedSinceRev = rev;
        return Promise.resolve([makeCommit('feat', 'initial feature')]);
      },
    });

    const host = createMockHost({
      getTag: () => Promise.resolve(null), // No tags exist
      createTag: () => Promise.resolve(),
      createRelease: () => Promise.resolve('https://github.com/test/releases/v1.0.0'),
    });

    await releaseWorkflow(repo, host);

    // Should have called getCommitsSince with null (no previous tag)
    assertEquals(capturedSinceRev, null);
  });

  await t.step('creates GitHub Release when tag already exists but release missing', async () => {
    let createReleaseCalled = false;

    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
      getCommitsSince: () => Promise.resolve([makeCommit('feat', 'new feature')]),
    });

    const host = createMockHost({
      getTag: (name) => {
        if (name === 'v1.1.0') {
          return Promise.resolve({
            name: 'v1.1.0',
            rev: 'tag-rev',
            message:
              'Release v1.1.0\n\n---pls-release---\nversion: 1.1.0\nfrom: 1.0.0\ntype: minor\n---pls-release---',
            isPlsRelease: true,
            metadata: { version: '1.1.0', from: '1.0.0', type: 'minor' as const },
          });
        }
        if (name === 'v1.0.0') {
          return Promise.resolve({
            name: 'v1.0.0',
            rev: 'prev-rev',
            message: 'Release v1.0.0',
            isPlsRelease: true,
            metadata: { version: '1.0.0', from: '0.0.0', type: 'minor' as const },
          });
        }
        return Promise.resolve(null);
      },
      createRelease: () => {
        createReleaseCalled = true;
        return Promise.resolve('https://github.com/test/releases/v1.1.0');
      },
    });

    const result = await releaseWorkflow(repo, host);

    assertEquals(result.alreadyExists, true);
    assertEquals(result.url, 'https://github.com/test/releases/v1.1.0');
    assertEquals(createReleaseCalled, true);
  });

  await t.step('returns existing release URL when both tag and release exist', async () => {
    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
      getCommitsSince: () => Promise.resolve([makeCommit('feat', 'feature')]),
    });

    const host = createMockHost({
      getTag: (name) => {
        if (name === 'v1.1.0') {
          return Promise.resolve({
            name: 'v1.1.0',
            rev: 'tag-rev',
            message:
              'Release v1.1.0\n\n---pls-release---\nversion: 1.1.0\nfrom: 1.0.0\ntype: minor\n---pls-release---',
            isPlsRelease: true,
            metadata: { version: '1.1.0', from: '1.0.0', type: 'minor' as const },
          });
        }
        return Promise.resolve(null);
      },
      createRelease: () => {
        throw new PlsError('Validation Failed', 'GITHUB_API_ERROR', { status: 422 });
      },
      getReleaseUrl: () => Promise.resolve('https://github.com/test/releases/v1.1.0'),
    });

    const result = await releaseWorkflow(repo, host);

    assertEquals(result.alreadyExists, true);
    assertEquals(result.url, 'https://github.com/test/releases/v1.1.0');
  });

  await t.step('fails when the release neither exists nor can be created', async () => {
    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
      getCommitsSince: () => Promise.resolve([]),
    });

    const host = createMockHost({
      getTag: (name) => {
        if (name === 'v1.1.0') {
          return Promise.resolve({
            name: 'v1.1.0',
            rev: 'tag-rev',
            message:
              'Release v1.1.0\n\n---pls-release---\nversion: 1.1.0\nfrom: 1.0.0\ntype: minor\n---pls-release---',
            isPlsRelease: true,
            metadata: { version: '1.1.0', from: '1.0.0', type: 'minor' as const },
          });
        }
        return Promise.resolve(null);
      },
      createRelease: () => {
        throw new PlsError(
          'GitHub API error: 403 Forbidden\n{"message":"Resource not accessible by integration"}',
          'GITHUB_API_ERROR',
          { status: 403 },
        );
      },
      getReleaseUrl: () => Promise.resolve(null),
    });

    const error = await assertRejects(() => releaseWorkflow(repo, host), PlsError);
    assertEquals(error.code, 'RELEASE_CREATE_FAILED');
    assertStringIncludes(error.message, 'v1.1.0');
    assertStringIncludes(error.message, '403');
    assertStringIncludes(error.message, 'contents: write');
  });

  await t.step('finds the release when the response to creating it was lost', async () => {
    let created = false;
    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
      getCommitsSince: () => Promise.resolve([makeCommit('feat', 'new feature')]),
    });

    const host = createMockHost({
      createRelease: () => {
        created = true; // GitHub applied the request, the answer never arrived
        throw new TypeError('connection closed before message completed');
      },
      getReleaseUrl: () =>
        Promise.resolve(created ? 'https://github.com/test/releases/v1.1.0' : null),
    });

    const result = await releaseWorkflow(repo, host);

    assertEquals(result.released, true);
    assertEquals(result.url, 'https://github.com/test/releases/v1.1.0');
  });

  await t.step('does not try to create a release that exists', async () => {
    let createReleaseCalled = false;
    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
    });

    const host = createMockHost({
      getTag: (name) =>
        Promise.resolve(
          name === 'v1.1.0'
            ? {
              name: 'v1.1.0',
              rev: 'tag-rev',
              message: null,
              isPlsRelease: true,
              metadata: { version: '1.1.0', from: '1.0.0', type: 'minor' as const },
            }
            : null,
        ),
      createRelease: () => {
        createReleaseCalled = true;
        return Promise.resolve('unexpected');
      },
      getReleaseUrl: () => Promise.resolve('https://github.com/test/releases/v1.1.0'),
    });

    const result = await releaseWorkflow(repo, host);

    assertEquals(result.url, 'https://github.com/test/releases/v1.1.0');
    assertEquals(createReleaseCalled, false);
  });

  await t.step('creates release after concurrent tag creation', async () => {
    let createReleaseCalled = false;

    const repo = createMockRepo({
      ...atReleaseCommit('1.1.0', '1.0.0'),
      getCommitsSince: () => Promise.resolve([makeCommit('feat', 'new feature')]),
    });

    const host = createMockHost({
      getTag: (name) => {
        if (name === 'v1.0.0') {
          return Promise.resolve({
            name: 'v1.0.0',
            rev: 'prev-rev',
            message: 'Release v1.0.0',
            isPlsRelease: true,
            metadata: { version: '1.0.0', from: '0.0.0', type: 'minor' as const },
          });
        }
        return Promise.resolve(null);
      },
      createTag: () => {
        throw new PlsError('Reference already exists', 'GITHUB_API_ERROR', { status: 422 });
      },
      createRelease: () => {
        createReleaseCalled = true;
        return Promise.resolve('https://github.com/test/releases/v1.1.0');
      },
    });

    const result = await releaseWorkflow(repo, host);

    assertEquals(result.alreadyExists, true);
    assertEquals(result.url, 'https://github.com/test/releases/v1.1.0');
    assertEquals(createReleaseCalled, true);
  });
});
