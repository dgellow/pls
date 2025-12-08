/**
 * Tests for configuration management.
 */

import { assertEquals, assertThrows } from '@std/assert';
import {
  DEFAULT_CONFIG,
  detectStrategy,
  generateConfigFile,
  loadConfig,
  mergeConfig,
  parseConfig,
} from './config.ts';
import { PlsError } from '../lib/error.ts';

Deno.test('parseConfig', async (t) => {
  await t.step('parses valid config', () => {
    const content = JSON.stringify({
      baseBranch: 'develop',
      targetBranch: 'main',
      releaseBranch: 'release',
      versionFile: 'src/version.ts',
      strategy: 'next',
    });
    const result = parseConfig(content);

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.targetBranch, 'main');
    assertEquals(result.releaseBranch, 'release');
    assertEquals(result.versionFile, 'src/version.ts');
    assertEquals(result.strategy, 'next');
  });

  await t.step('parses partial config', () => {
    const content = JSON.stringify({
      baseBranch: 'develop',
    });
    const result = parseConfig(content);

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.targetBranch, undefined);
    assertEquals(result.strategy, undefined);
  });

  await t.step('parses empty config', () => {
    const result = parseConfig('{}');
    assertEquals(result, {});
  });

  await t.step('throws for invalid JSON', () => {
    assertThrows(
      () => parseConfig('not json'),
      PlsError,
      'not valid JSON',
    );
  });

  await t.step('throws for invalid baseBranch type', () => {
    assertThrows(
      () => parseConfig(JSON.stringify({ baseBranch: 123 })),
      PlsError,
      'baseBranch must be a string',
    );
  });

  await t.step('throws for invalid strategy', () => {
    assertThrows(
      () => parseConfig(JSON.stringify({ strategy: 'invalid' })),
      PlsError,
      'strategy must be "simple" or "next"',
    );
  });
});

Deno.test('mergeConfig', async (t) => {
  await t.step('returns defaults for empty partial', () => {
    const result = mergeConfig({});
    assertEquals(result, DEFAULT_CONFIG);
  });

  await t.step('overrides defaults with partial values', () => {
    const result = mergeConfig({
      baseBranch: 'develop',
      strategy: 'next',
    });

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.strategy, 'next');
    assertEquals(result.targetBranch, 'main'); // default
    assertEquals(result.releaseBranch, 'pls-release'); // default
  });

  await t.step('sets baseBranch to next for next strategy', () => {
    const result = mergeConfig({
      strategy: 'next',
    });

    assertEquals(result.baseBranch, 'next');
    assertEquals(result.targetBranch, 'main');
    assertEquals(result.strategy, 'next');
  });

  await t.step('respects explicit baseBranch for next strategy', () => {
    const result = mergeConfig({
      strategy: 'next',
      baseBranch: 'develop',
    });

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.strategy, 'next');
  });
});

Deno.test('loadConfig', async (t) => {
  await t.step('returns defaults for null content', () => {
    const result = loadConfig(null);
    assertEquals(result, DEFAULT_CONFIG);
  });

  await t.step('parses and merges config', () => {
    const content = JSON.stringify({
      baseBranch: 'develop',
    });
    const result = loadConfig(content);

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.targetBranch, DEFAULT_CONFIG.targetBranch);
  });
});

Deno.test('generateConfigFile', async (t) => {
  await t.step('generates empty object for no options', () => {
    const result = generateConfigFile();
    assertEquals(result, '{}\n');
  });

  await t.step('generates empty object for default values', () => {
    const result = generateConfigFile({
      baseBranch: 'main',
      targetBranch: 'main',
      releaseBranch: 'pls-release',
      strategy: 'simple',
    });
    assertEquals(result, '{}\n');
  });

  await t.step('includes only non-default values', () => {
    const result = generateConfigFile({
      baseBranch: 'develop',
      targetBranch: 'main', // default
      strategy: 'next',
    });
    const parsed = JSON.parse(result);

    assertEquals(parsed.baseBranch, 'develop');
    assertEquals(parsed.strategy, 'next');
    assertEquals(parsed.targetBranch, undefined);
  });

  await t.step('includes versionFile when provided', () => {
    const result = generateConfigFile({
      versionFile: 'src/version.ts',
    });
    const parsed = JSON.parse(result);

    assertEquals(parsed.versionFile, 'src/version.ts');
  });
});

Deno.test('detectStrategy', async (t) => {
  await t.step('returns simple when branches match', () => {
    const result = detectStrategy({
      baseBranch: 'main',
      targetBranch: 'main',
      releaseBranch: 'pls-release',
      strategy: 'simple',
    });
    assertEquals(result, 'simple');
  });

  await t.step('returns next when branches differ', () => {
    const result = detectStrategy({
      baseBranch: 'next',
      targetBranch: 'main',
      releaseBranch: 'pls-release',
      strategy: 'simple', // This should be overridden
    });
    assertEquals(result, 'next');
  });
});
