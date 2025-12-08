/**
 * Tests for configuration management.
 */

import { assertEquals, assertThrows } from '@std/assert';
import { DEFAULT_CONFIG, generateConfigFile, loadConfig } from './config.ts';
import { PlsError } from '../lib/error.ts';

Deno.test('loadConfig', async (t) => {
  await t.step('returns defaults for null content', () => {
    const result = loadConfig(null);
    assertEquals(result, DEFAULT_CONFIG);
  });

  await t.step('returns defaults for empty config', () => {
    const result = loadConfig('{}');
    assertEquals(result, DEFAULT_CONFIG);
  });

  await t.step('parses valid config', () => {
    const content = JSON.stringify({
      baseBranch: 'develop',
      targetBranch: 'main',
      releaseBranch: 'release',
      versionFile: 'src/version.ts',
      strategy: 'next',
    });
    const result = loadConfig(content);

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.targetBranch, 'main');
    assertEquals(result.releaseBranch, 'release');
    assertEquals(result.versionFile, 'src/version.ts');
    assertEquals(result.strategy, 'next');
  });

  await t.step('merges partial config with defaults', () => {
    const content = JSON.stringify({
      baseBranch: 'develop',
    });
    const result = loadConfig(content);

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.targetBranch, DEFAULT_CONFIG.targetBranch);
    assertEquals(result.releaseBranch, DEFAULT_CONFIG.releaseBranch);
    assertEquals(result.strategy, DEFAULT_CONFIG.strategy);
  });

  await t.step('sets baseBranch to next for next strategy', () => {
    const content = JSON.stringify({
      strategy: 'next',
    });
    const result = loadConfig(content);

    assertEquals(result.baseBranch, 'next');
    assertEquals(result.targetBranch, 'main');
    assertEquals(result.strategy, 'next');
  });

  await t.step('respects explicit baseBranch for next strategy', () => {
    const content = JSON.stringify({
      strategy: 'next',
      baseBranch: 'develop',
    });
    const result = loadConfig(content);

    assertEquals(result.baseBranch, 'develop');
    assertEquals(result.strategy, 'next');
  });

  await t.step('throws for invalid JSON', () => {
    assertThrows(() => loadConfig('not json'), PlsError, 'not valid JSON');
  });

  await t.step('throws for invalid baseBranch type', () => {
    assertThrows(
      () => loadConfig(JSON.stringify({ baseBranch: 123 })),
      PlsError,
      'baseBranch must be a string',
    );
  });

  await t.step('throws for invalid strategy', () => {
    assertThrows(
      () => loadConfig(JSON.stringify({ strategy: 'invalid' })),
      PlsError,
      'strategy must be "simple" or "next"',
    );
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
