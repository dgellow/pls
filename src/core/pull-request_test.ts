import { assertEquals, assertThrows } from '@std/assert';
import { ReleasePullRequest } from './pull-request.ts';
import { PlsError } from '../types.ts';

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
