/**
 * Tests for manifest detection and version management.
 */

import { assertEquals } from '@std/assert';
import {
  detectManifest,
  extractVersionFromJson,
  readUpdatableManifests,
  updateJsonVersion,
  updateManifestVersion,
} from './manifest.ts';

/** Helper: create a readFile stub from a map of path -> content. */
function stubReadFile(
  files: Record<string, string>,
): (path: string) => Promise<string | null> {
  return (path: string) => Promise.resolve(files[path] ?? null);
}

Deno.test('detectManifest', async (t) => {
  await t.step('detects deno.json with version', async () => {
    const result = await detectManifest(stubReadFile({
      'deno.json': JSON.stringify({ name: '@test/pkg', version: '1.2.3' }),
    }));

    assertEquals(result?.path, 'deno.json');
    assertEquals(result?.version, '1.2.3');
  });

  await t.step('detects package.json with version', async () => {
    const result = await detectManifest(stubReadFile({
      'package.json': JSON.stringify({ name: 'test', version: '0.5.0' }),
    }));

    assertEquals(result?.path, 'package.json');
    assertEquals(result?.version, '0.5.0');
  });

  await t.step('detects go.mod with no version', async () => {
    const result = await detectManifest(stubReadFile({
      'go.mod': 'module github.com/example/app\n\ngo 1.22\n',
    }));

    assertEquals(result?.path, 'go.mod');
    assertEquals(result?.version, null);
  });

  await t.step('prefers deno.json over package.json', async () => {
    const result = await detectManifest(stubReadFile({
      'deno.json': JSON.stringify({ version: '1.0.0' }),
      'package.json': JSON.stringify({ version: '2.0.0' }),
    }));

    assertEquals(result?.path, 'deno.json');
    assertEquals(result?.version, '1.0.0');
  });

  await t.step('prefers package.json over go.mod', async () => {
    const result = await detectManifest(stubReadFile({
      'package.json': JSON.stringify({ version: '1.0.0' }),
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
    }));

    assertEquals(result?.path, 'package.json');
    assertEquals(result?.version, '1.0.0');
  });

  await t.step('returns null when no manifest found', async () => {
    const result = await detectManifest(stubReadFile({}));
    assertEquals(result, null);
  });

  await t.step('handles deno.json without version field', async () => {
    const result = await detectManifest(stubReadFile({
      'deno.json': JSON.stringify({ name: '@test/pkg' }),
    }));

    assertEquals(result?.path, 'deno.json');
    assertEquals(result?.version, null);
  });
});

Deno.test('readUpdatableManifests', async (t) => {
  await t.step('returns deno.json when present', async () => {
    const result = await readUpdatableManifests(stubReadFile({
      'deno.json': JSON.stringify({ version: '1.0.0' }),
    }));

    assertEquals(result.length, 1);
    assertEquals(result[0].path, 'deno.json');
  });

  await t.step('returns both deno.json and package.json when present', async () => {
    const result = await readUpdatableManifests(stubReadFile({
      'deno.json': JSON.stringify({ version: '1.0.0' }),
      'package.json': JSON.stringify({ version: '1.0.0' }),
    }));

    assertEquals(result.length, 2);
    assertEquals(result[0].path, 'deno.json');
    assertEquals(result[1].path, 'package.json');
  });

  await t.step('does not include go.mod', async () => {
    const result = await readUpdatableManifests(stubReadFile({
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
    }));

    assertEquals(result.length, 0);
  });

  await t.step('returns empty when no manifests found', async () => {
    const result = await readUpdatableManifests(stubReadFile({}));
    assertEquals(result.length, 0);
  });
});

Deno.test('updateManifestVersion', async (t) => {
  await t.step('updates version in JSON manifest', () => {
    const content = JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2);
    const result = updateManifestVersion('deno.json', content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed.version, '2.0.0');
    assertEquals(parsed.name, 'test');
  });

  await t.step('works for package.json', () => {
    const content = JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2);
    const result = updateManifestVersion('package.json', content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed.version, '2.0.0');
  });
});

Deno.test('updateJsonVersion', async (t) => {
  await t.step('updates version in JSON', () => {
    const content = JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2);
    const result = updateJsonVersion(content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed.version, '2.0.0');
    assertEquals(parsed.name, 'test');
  });

  await t.step('changes only the version value, byte for byte', () => {
    const cases: Array<[string, string]> = [
      // no trailing newline
      [
        '{\n  "name": "test",\n  "version": "1.0.0"\n}',
        '{\n  "name": "test",\n  "version": "2.0.0"\n}',
      ],
      // four-space indentation, inline array and object, key order
      [
        '{\n    "name": "widget",\n    "version": "1.0.0",\n    "files": ["dist", "src"],\n' +
        '    "scripts": { "test": "node test.js" }\n}\n',
        '{\n    "name": "widget",\n    "version": "2.0.0",\n    "files": ["dist", "src"],\n' +
        '    "scripts": { "test": "node test.js" }\n}\n',
      ],
      // CRLF line endings
      [
        '{\r\n  "version": "1.0.0",\r\n  "name": "w"\r\n}\r\n',
        '{\r\n  "version": "2.0.0",\r\n  "name": "w"\r\n}\r\n',
      ],
      // tabs, no space after the colon
      ['{\n\t"version":"1.0.0"\n}\n', '{\n\t"version":"2.0.0"\n}\n'],
      // one line
      ['{"name":"w","version":"1.0.0"}', '{"name":"w","version":"2.0.0"}'],
      // comments and a trailing comma, as deno.json allows
      [
        '{\n  // the package\n  "name": "w", /* v */ "version": "1.0.0",\n}\n',
        '{\n  // the package\n  "name": "w", /* v */ "version": "2.0.0",\n}\n',
      ],
      // byte order mark
      ['\uFEFF{"version": "1.0.0"}\n', '\uFEFF{"version": "2.0.0"}\n'],
    ];

    for (const [content, expected] of cases) {
      assertEquals(updateJsonVersion(content, '2.0.0'), expected);
    }
  });

  await t.step('updates the top-level field, not a nested or quoted "version"', () => {
    const content = '{\n  "engines": { "version": "9.9.9" },\n' +
      '  "description": "set \\"version\\": \\"0.0.0\\" here",\n' +
      '  "tools": [{ "version": "8.8.8" }],\n  "version": "1.0.0"\n}\n';

    assertEquals(
      updateJsonVersion(content, '2.0.0'),
      content.replace('"version": "1.0.0"\n}', '"version": "2.0.0"\n}'),
    );
  });

  await t.step('escapes the new value as JSON', () => {
    assertEquals(
      updateJsonVersion('{"version": "1.0.0"}', '2.0.0-"x"'),
      '{"version": "2.0.0-\\"x\\""}',
    );
  });

  await t.step('adds version field when missing', () => {
    const content = JSON.stringify({ name: 'test' }, null, 2);
    const result = updateJsonVersion(content, '1.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed.version, '1.0.0');
  });

  await t.step('returns original on invalid JSON', () => {
    const content = 'not valid json';
    const result = updateJsonVersion(content, '1.0.0');
    assertEquals(result, content);
  });
});

Deno.test('extractVersionFromJson', async (t) => {
  await t.step('extracts version', () => {
    assertEquals(extractVersionFromJson('{"version": "1.2.3"}'), '1.2.3');
  });

  await t.step('returns null for missing version', () => {
    assertEquals(extractVersionFromJson('{"name": "test"}'), null);
  });

  await t.step('returns null for invalid JSON', () => {
    assertEquals(extractVersionFromJson('not json'), null);
  });
});
