/**
 * Tests for PlsError.
 */

import { assertEquals, assertInstanceOf } from '@std/assert';
import { PlsError } from './error.ts';

Deno.test('PlsError', async (t) => {
  await t.step('creates error with message and code', () => {
    const error = new PlsError('Something went wrong', 'TEST_ERROR');

    assertInstanceOf(error, Error);
    assertInstanceOf(error, PlsError);
    assertEquals(error.message, 'Something went wrong');
    assertEquals(error.code, 'TEST_ERROR');
    assertEquals(error.name, 'PlsError');
    assertEquals(error.details, undefined);
  });

  await t.step('creates error with details', () => {
    const error = new PlsError('Invalid version', 'VERSION_ERROR', {
      input: 'abc',
      expected: 'semver',
    });

    assertEquals(error.message, 'Invalid version');
    assertEquals(error.code, 'VERSION_ERROR');
    assertEquals(error.details, { input: 'abc', expected: 'semver' });
  });

  await t.step('has correct stack trace', () => {
    const error = new PlsError('Test', 'TEST');
    assertEquals(typeof error.stack, 'string');
    assertEquals(error.stack?.includes('PlsError'), true);
  });

  await t.step('can be caught as Error', () => {
    try {
      throw new PlsError('Test error', 'TEST');
    } catch (e) {
      assertInstanceOf(e, Error);
      if (e instanceof PlsError) {
        assertEquals(e.code, 'TEST');
      }
    }
  });
});
