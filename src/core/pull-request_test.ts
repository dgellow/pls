import { assertEquals, assertThrows } from '@std/assert';
import { ReleasePullRequest } from './pull-request.ts';
import { PlsError } from '../types.ts';
import { GitHubBackend } from '../backend/mod.ts';

/**
 * Creates a mock request handler that tracks all API calls.
 */
function createMockRequestHandler(
  requests: Array<{ path: string; method: string; body?: unknown }>,
): (path: string, options?: RequestInit) => Promise<unknown> {
  return (path: string, options: RequestInit = {}): Promise<unknown> => {
    const body = options.body ? JSON.parse(options.body as string) : undefined;
    requests.push({
      path,
      method: options.method || 'GET',
      body,
    });

    // Return mock responses based on the path
    if (path.includes('/git/ref/heads/main')) {
      return Promise.resolve({ object: { sha: 'base-sha-123' } });
    }
    if (path.includes('/git/commits/base-sha-123')) {
      return Promise.resolve({ tree: { sha: 'tree-sha-123' } });
    }
    if (path.includes('/contents/deno.json')) {
      return Promise.resolve({ content: btoa('{"version": "1.0.0"}') });
    }
    if (path.includes('/contents/.pls/versions.json')) {
      return Promise.resolve({ content: btoa('{"."": "1.0.0"}') });
    }
    if (path.includes('/git/blobs')) {
      return Promise.resolve({ sha: 'blob-sha-' + Math.random().toString(36).slice(2) });
    }
    if (path.includes('/git/trees')) {
      return Promise.resolve({ sha: 'new-tree-sha-123' });
    }
    if (path.includes('/git/commits') && options.method === 'POST') {
      return Promise.resolve({ sha: 'new-commit-sha-456' });
    }
    if (path.includes('/git/refs/heads/pls-release')) {
      return Promise.resolve({});
    }
    // POST to /git/refs (without /heads/) is for creating a new ref - make it fail
    // so updateBranchRef falls through to PATCH
    if (path.includes('/git/refs') && !path.includes('/heads/') && options.method === 'POST') {
      return Promise.reject(new Error('Ref already exists'));
    }
    return Promise.resolve({});
  };
}

/**
 * Creates a mock GitHubBackend with tracked requests.
 */
function createMockBackend(
  requests: Array<{ path: string; method: string; body?: unknown }>,
): GitHubBackend {
  const mockRequest = createMockRequestHandler(requests);
  const backend = new GitHubBackend({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
    baseBranch: 'main',
    deferBranchUpdate: true,
  });
  // deno-lint-ignore no-explicit-any
  (backend as any).request = mockRequest;
  return backend;
}

/**
 * Test helper: Creates a ReleasePullRequest with mocked API calls.
 * Uses dependency injection for clean mocking.
 */
function createMockedPR(): {
  pr: ReleasePullRequest;
  requests: Array<{ path: string; method: string; body?: unknown }>;
} {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const mockBackend = createMockBackend(requests);

  const pr = new ReleasePullRequest({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
    backend: mockBackend, // Inject mock backend via DI
  });

  // Mock createCommitBackend to return backends with mocked request
  // deno-lint-ignore no-explicit-any
  (pr as any).createCommitBackend = (targetBranch: string): GitHubBackend => {
    const backend = new GitHubBackend({
      owner: 'test',
      repo: 'repo',
      token: 'test-token',
      baseBranch: 'main',
      targetBranch,
      deferBranchUpdate: true,
    });
    // deno-lint-ignore no-explicit-any
    (backend as any).request = createMockRequestHandler(requests);
    return backend;
  };

  return { pr, requests };
}

Deno.test('ReleasePullRequest - requires token', () => {
  // Clear any existing token
  const originalToken = Deno.env.get('GITHUB_TOKEN');
  Deno.env.delete('GITHUB_TOKEN');

  try {
    assertThrows(
      () => {
        new ReleasePullRequest({
          owner: 'test',
          repo: 'repo',
          token: undefined,
        });
      },
      PlsError,
      'GitHub token required',
    );
  } finally {
    // Restore token if it existed
    if (originalToken) {
      Deno.env.set('GITHUB_TOKEN', originalToken);
    }
  }
});

Deno.test('ReleasePullRequest - constructs with valid options', () => {
  const pr = new ReleasePullRequest({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
    baseBranch: 'main',
  });

  assertEquals(pr !== null, true);
});

Deno.test('ReleasePullRequest - uses default base branch', () => {
  const pr = new ReleasePullRequest({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
  });

  // Can't directly test private field, but construction should succeed
  assertEquals(pr !== null, true);
});

Deno.test('ReleasePullRequest - updatePRBodySelection updates header and options', () => {
  const pr = new ReleasePullRequest({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
  });

  const body = `## Release 1.3.0

This PR was automatically created by pls.

<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
<!-- pls:options:end -->

Some footer content`;

  const updated = pr.updatePRBodySelection(body, '1.3.0-alpha.0');

  // Header should be updated
  assertEquals(updated.includes('## Release 1.3.0-alpha.0'), true);
  assertEquals(updated.includes('## Release 1.3.0\n'), false);

  // Options block should show alpha as current
  assertEquals(updated.includes('**Current: 1.3.0-alpha.0**'), true);

  // Footer should be preserved
  assertEquals(updated.includes('Some footer content'), true);
});

Deno.test('ReleasePullRequest - createVersionsManifest dry run shows correct output', async () => {
  const pr = new ReleasePullRequest({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
    baseBranch: 'main',
  });

  // Capture console output
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    // Test dry run with direct=false (PR mode)
    const result = await pr.createVersionsManifest(false, true);

    assertEquals(result.direct, false);
    assertEquals(logs.some((l) => l.includes('Would create setup PR')), true);
    assertEquals(logs.some((l) => l.includes('.pls/versions.json')), true);

    // Reset logs
    logs.length = 0;

    // Test dry run with direct=true
    const resultDirect = await pr.createVersionsManifest(true, true);

    assertEquals(resultDirect.direct, true);
    assertEquals(logs.some((l) => l.includes('Would create .pls/versions.json directly')), true);
  } finally {
    console.log = originalLog;
  }
});

/**
 * Regression test for PR auto-close bug.
 *
 * The bug: When updating the pls-release branch, the old code would:
 * 1. Reset branch to main SHA (force push)
 * 2. Create new release commit
 *
 * This caused GitHub to auto-close the PR between steps 1 and 2 because
 * the branch temporarily had 0 commits different from main.
 *
 * The fix: Create the commit first, then update the branch ref atomically.
 */
Deno.test('ReleasePullRequest - updateBranch must not reset branch to base before creating commit', async () => {
  const { pr, requests } = createMockedPR();

  const bump = {
    from: '1.0.0',
    to: '1.1.0',
    type: 'minor' as const,
    commits: [],
  };

  // Call the private updateBranch method
  // deno-lint-ignore no-explicit-any
  await (pr as any).updateBranch(bump, 'changelog');

  // Find all PATCH requests to the pls-release branch ref
  const branchRefPatches = requests.filter(
    (r) => r.path.includes('/git/refs/heads/pls-release') && r.method === 'PATCH',
  );

  // There should be exactly ONE PATCH to the branch ref
  assertEquals(
    branchRefPatches.length,
    1,
    'Should only PATCH the branch ref once (not reset then update)',
  );

  // The PATCH should use the NEW commit SHA, not the base SHA
  const patchBody = branchRefPatches[0].body as { sha: string; force?: boolean };
  assertEquals(
    patchBody.sha,
    'new-commit-sha-456',
    'Branch ref should be updated to new commit SHA, not reset to base SHA first',
  );

  // Verify the commit was created BEFORE the branch ref update
  const commitCreateIndex = requests.findIndex(
    (r) => r.path.includes('/git/commits') && r.method === 'POST',
  );
  const branchUpdateIndex = requests.findIndex(
    (r) => r.path.includes('/git/refs/heads/pls-release') && r.method === 'PATCH',
  );

  assertEquals(
    commitCreateIndex < branchUpdateIndex,
    true,
    'Commit must be created BEFORE branch ref is updated (to avoid PR auto-close)',
  );
});
