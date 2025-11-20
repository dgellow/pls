import { assertEquals, assertThrows } from '@std/assert';
import { VersionTransition } from './transition.ts';
import { PlsError } from '../types.ts';

Deno.test('VersionTransition - transition from stable to alpha', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.0.0', 'alpha');
  assertEquals(next, '1.1.0-alpha.0');
});

Deno.test('VersionTransition - transition from stable to beta', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.0.0', 'beta');
  assertEquals(next, '1.1.0-beta.0');
});

Deno.test('VersionTransition - transition from stable to rc', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.0.0', 'rc');
  assertEquals(next, '1.1.0-rc.0');
});

Deno.test('VersionTransition - transition from stable to alpha with major bump', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.0.0', 'alpha', 'major');
  assertEquals(next, '2.0.0-alpha.0');
});

Deno.test('VersionTransition - transition from stable to alpha with patch bump', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.0.0', 'alpha', 'patch');
  assertEquals(next, '1.0.1-alpha.0');
});

Deno.test('VersionTransition - transition from alpha to beta', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.1.0-alpha.0', 'beta');
  assertEquals(next, '1.1.0-beta.0');
});

Deno.test('VersionTransition - transition from beta to rc', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.1.0-beta.5', 'rc');
  assertEquals(next, '1.1.0-rc.0');
});

Deno.test('VersionTransition - transition from rc to stable', () => {
  const transition = new VersionTransition();
  const next = transition.transition('1.1.0-rc.2', 'stable');
  assertEquals(next, '1.1.0');
});

Deno.test('VersionTransition - transition from alpha to stable', () => {
  const transition = new VersionTransition();
  const next = transition.transition('2.0.0-alpha.10', 'stable');
  assertEquals(next, '2.0.0');
});

Deno.test('VersionTransition - transition from stable to stable throws error', () => {
  const transition = new VersionTransition();
  assertThrows(
    () => transition.transition('1.0.0', 'stable'),
    PlsError,
    'Already on stable version',
  );
});

Deno.test('VersionTransition - getNextVersion increments prerelease build number', () => {
  const transition = new VersionTransition();
  const next = transition.getNextVersion('1.0.0-alpha.0', null);
  assertEquals(next, '1.0.0-alpha.1');
});

Deno.test('VersionTransition - getNextVersion increments beta build number', () => {
  const transition = new VersionTransition();
  const next = transition.getNextVersion('1.0.0-beta.5', null);
  assertEquals(next, '1.0.0-beta.6');
});

Deno.test('VersionTransition - getNextVersion bumps stable version with major', () => {
  const transition = new VersionTransition();
  const next = transition.getNextVersion('1.0.0', 'major');
  assertEquals(next, '2.0.0');
});

Deno.test('VersionTransition - getNextVersion bumps stable version with minor', () => {
  const transition = new VersionTransition();
  const next = transition.getNextVersion('1.0.0', 'minor');
  assertEquals(next, '1.1.0');
});

Deno.test('VersionTransition - getNextVersion bumps stable version with patch', () => {
  const transition = new VersionTransition();
  const next = transition.getNextVersion('1.0.0', 'patch');
  assertEquals(next, '1.0.1');
});

Deno.test('VersionTransition - getNextVersion returns null for stable with no bump type', () => {
  const transition = new VersionTransition();
  const next = transition.getNextVersion('1.0.0', null);
  assertEquals(next, null);
});
