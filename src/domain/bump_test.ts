/**
 * Tests for version bump calculation.
 */

import { assertEquals } from '@std/assert';
import { calculateBump, classifyStep, determineBumpType, nextVersions } from './bump.ts';
import type { Commit } from './types.ts';

const makeCommit = (
  type: string,
  breaking = false,
): Commit => ({
  rev: 'abc123',
  type,
  scope: null,
  description: 'message',
  breaking,
  body: null,
  merge: false,
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

Deno.test('nextVersions', async (t) => {
  await t.step('from stable: each bump type, stable or as a first prerelease', () => {
    assertEquals(nextVersions('1.2.3'), [
      '1.2.4',
      '1.2.4-alpha.0',
      '1.2.4-beta.0',
      '1.2.4-rc.0',
      '1.3.0',
      '1.3.0-alpha.0',
      '1.3.0-beta.0',
      '1.3.0-rc.0',
      '2.0.0',
      '2.0.0-alpha.0',
      '2.0.0-beta.0',
      '2.0.0-rc.0',
    ]);
  });

  await t.step('from a prerelease: next build, later stages, stable', () => {
    assertEquals(nextVersions('1.3.0-alpha.2'), [
      '1.3.0-alpha.3',
      '1.3.0-beta.0',
      '1.3.0-rc.0',
      '1.3.0',
    ]);
    assertEquals(nextVersions('1.3.0-rc.0'), ['1.3.0-rc.1', '1.3.0']);
  });

  await t.step('does not contain arbitrary versions', () => {
    const allowed = nextVersions('1.0.0');
    for (const version of ['9.9.9-evil.1', '1.0.0', '0.9.0', '3.0.0', '1.1.0-beta.1', '1.1.1']) {
      assertEquals(allowed.includes(version), false, version);
    }
  });
});

Deno.test('classifyStep', () => {
  assertEquals(classifyStep('1.2.3', '2.0.0'), 'major');
  assertEquals(classifyStep('1.2.3', '1.3.0'), 'minor');
  assertEquals(classifyStep('1.2.3', '1.2.4'), 'patch');
  assertEquals(classifyStep('1.2.3', '1.3.0-beta.0'), 'transition');
  assertEquals(classifyStep('1.3.0-rc.1', '1.3.0'), 'transition');
});
