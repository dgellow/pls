/**
 * Tests for version bump calculation.
 */

import { assertEquals } from '@std/assert';
import { calculateBump, determineBumpType } from './bump.ts';
import type { Commit } from './types.ts';

const makeCommit = (
  type: string,
  breaking = false,
): Commit => ({
  sha: 'abc123',
  type,
  scope: null,
  description: 'message',
  breaking,
  body: null,
});

Deno.test('determineBumpType', async (t) => {
  await t.step('returns major for breaking changes', () => {
    const commits = [makeCommit('feat', true)];
    assertEquals(determineBumpType(commits), 'major');
  });

  await t.step('returns major for any breaking change', () => {
    const commits = [
      makeCommit('feat'),
      makeCommit('fix'),
      makeCommit('chore', true), // breaking
    ];
    assertEquals(determineBumpType(commits), 'major');
  });

  await t.step('returns minor for feat commits', () => {
    const commits = [makeCommit('feat')];
    assertEquals(determineBumpType(commits), 'minor');
  });

  await t.step('returns minor for feat even with fix', () => {
    const commits = [
      makeCommit('fix'),
      makeCommit('feat'),
      makeCommit('fix'),
    ];
    assertEquals(determineBumpType(commits), 'minor');
  });

  await t.step('returns patch for fix commits only', () => {
    const commits = [makeCommit('fix')];
    assertEquals(determineBumpType(commits), 'patch');
  });

  await t.step('returns patch for perf commits', () => {
    const commits = [makeCommit('perf')];
    assertEquals(determineBumpType(commits), 'patch');
  });

  await t.step('returns patch for other commits', () => {
    // Per the implementation, any commits trigger patch
    const commits = [
      makeCommit('chore'),
      makeCommit('docs'),
      makeCommit('style'),
    ];
    assertEquals(determineBumpType(commits), 'patch');
  });

  await t.step('returns null for empty commits', () => {
    assertEquals(determineBumpType([]), null);
  });
});

Deno.test('calculateBump', async (t) => {
  await t.step('calculates major bump', () => {
    const commits = [makeCommit('feat', true)];
    const result = calculateBump('1.2.3', commits);

    assertEquals(result?.from, '1.2.3');
    assertEquals(result?.to, '2.0.0');
    assertEquals(result?.type, 'major');
    assertEquals(result?.commits.length, 1);
  });

  await t.step('calculates minor bump', () => {
    const commits = [makeCommit('feat')];
    const result = calculateBump('1.2.3', commits);

    assertEquals(result?.from, '1.2.3');
    assertEquals(result?.to, '1.3.0');
    assertEquals(result?.type, 'minor');
  });

  await t.step('calculates patch bump', () => {
    const commits = [makeCommit('fix')];
    const result = calculateBump('1.2.3', commits);

    assertEquals(result?.from, '1.2.3');
    assertEquals(result?.to, '1.2.4');
    assertEquals(result?.type, 'patch');
  });

  await t.step('returns null for empty commits', () => {
    const result = calculateBump('1.2.3', []);
    assertEquals(result, null);
  });

  await t.step('handles prerelease - increments build', () => {
    const commits = [makeCommit('feat')];
    const result = calculateBump('1.2.3-alpha.0', commits);

    assertEquals(result?.from, '1.2.3-alpha.0');
    assertEquals(result?.to, '1.2.3-alpha.1');
    assertEquals(result?.type, 'minor');
  });
});
