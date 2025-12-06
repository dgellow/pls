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
