/**
 * Tests for PR sync workflow utilities.
 */

import { assertEquals } from '@std/assert';
import { determineBumpType } from './pr-sync.ts';

Deno.test('determineBumpType', async (t) => {
  await t.step('detects major bump', () => {
    assertEquals(determineBumpType('1.2.3', '2.0.0'), 'major');
    assertEquals(determineBumpType('0.9.0', '1.0.0'), 'major');
  });

  await t.step('detects minor bump', () => {
    assertEquals(determineBumpType('1.2.3', '1.3.0'), 'minor');
    assertEquals(determineBumpType('1.0.0', '1.1.0'), 'minor');
  });

  await t.step('detects patch bump', () => {
    assertEquals(determineBumpType('1.2.3', '1.2.4'), 'patch');
    assertEquals(determineBumpType('1.0.0', '1.0.1'), 'patch');
  });

  await t.step('detects transition to prerelease', () => {
    assertEquals(determineBumpType('1.2.3', '1.3.0-alpha.0'), 'transition');
    assertEquals(determineBumpType('1.2.3', '2.0.0-beta.0'), 'transition');
  });

  await t.step('detects transition from prerelease to stable', () => {
    // BUG: This currently returns 'patch' instead of 'transition'
    assertEquals(determineBumpType('1.3.0-alpha.0', '1.3.0'), 'transition');
    assertEquals(determineBumpType('1.3.0-rc.2', '1.3.0'), 'transition');
    assertEquals(determineBumpType('2.0.0-beta.5', '2.0.0'), 'transition');
  });

  await t.step('handles prerelease to prerelease', () => {
    assertEquals(determineBumpType('1.3.0-alpha.0', '1.3.0-beta.0'), 'transition');
    assertEquals(determineBumpType('1.3.0-beta.0', '1.3.0-rc.0'), 'transition');
  });
});
