/**
 * Tests for release file building.
 */

import { assertEquals } from '@std/assert';
import {
  buildReleaseFiles,
  createInitialVersionsManifest,
  extractVersionFromManifest,
  prependChangelog,
  updateJsonVersion,
  updateVersionFile,
  updateVersionsManifest,
} from './files.ts';

Deno.test('extractVersionFromManifest', async (t) => {
  await t.step('extracts version from deno.json', () => {
    const content = JSON.stringify({ name: '@test/pkg', version: '1.2.3' });
    assertEquals(extractVersionFromManifest(content), '1.2.3');
  });

  await t.step('extracts version from package.json', () => {
    const content = JSON.stringify({ name: 'test', version: '0.1.0' });
    assertEquals(extractVersionFromManifest(content), '0.1.0');
  });

  await t.step('returns null for missing version', () => {
    const content = JSON.stringify({ name: 'test' });
    assertEquals(extractVersionFromManifest(content), null);
  });

  await t.step('returns null for invalid JSON', () => {
    assertEquals(extractVersionFromManifest('not json'), null);
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

  await t.step('preserves formatting with trailing newline', () => {
    const content = '{\n  "name": "test",\n  "version": "1.0.0"\n}';
    const result = updateJsonVersion(content, '2.0.0');

    assertEquals(result.includes('"version": "2.0.0"'), true);
    assertEquals(result.endsWith('\n'), true);
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

Deno.test('updateVersionsManifest', async (t) => {
  await t.step('updates root version', () => {
    const content = JSON.stringify(
      {
        '.': { version: '1.0.0' },
      },
      null,
      2,
    );
    const result = updateVersionsManifest(content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].version, '2.0.0');
  });

  await t.step('preserves other entries', () => {
    const content = JSON.stringify(
      {
        '.': { version: '1.0.0' },
        'packages/core': { version: '1.0.0' },
      },
      null,
      2,
    );
    const result = updateVersionsManifest(content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].version, '2.0.0');
    assertEquals(parsed['packages/core'].version, '1.0.0');
  });

  await t.step('preserves versionFile', () => {
    const content = JSON.stringify(
      {
        '.': { version: '1.0.0', versionFile: 'src/version.ts' },
      },
      null,
      2,
    );
    const result = updateVersionsManifest(content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].versionFile, 'src/version.ts');
  });

  await t.step('creates manifest from null', () => {
    const result = updateVersionsManifest(null, '1.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].version, '1.0.0');
  });

  await t.step('converts legacy string format', () => {
    const content = JSON.stringify(
      {
        '.': '1.0.0',
      },
      null,
      2,
    );
    const result = updateVersionsManifest(content, '2.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].version, '2.0.0');
  });
});

Deno.test('updateVersionFile', async (t) => {
  await t.step('updates version in TypeScript file with marker', () => {
    const content = `// @pls-version
export const VERSION = '1.0.0';
`;
    const result = updateVersionFile(content, '2.0.0');

    assertEquals(
      result,
      `// @pls-version
export const VERSION = '2.0.0';
`,
    );
  });

  await t.step('normalizes to single quotes', () => {
    const content = `// @pls-version
export const VERSION = "1.0.0";
`;
    const result = updateVersionFile(content, '2.0.0');

    // Implementation always outputs single quotes
    assertEquals(result?.includes("'2.0.0'"), true);
  });

  await t.step('preserves other code', () => {
    const content = `// @pls-version
export const VERSION = '1.0.0';

export function getVersion() {
  return VERSION;
}
`;
    const result = updateVersionFile(content, '2.0.0');

    assertEquals(result?.includes("export const VERSION = '2.0.0';"), true);
    assertEquals(result?.includes('export function getVersion()'), true);
  });

  await t.step('returns null if no marker', () => {
    const content = `export const VERSION = '1.0.0';`;
    const result = updateVersionFile(content, '2.0.0');

    assertEquals(result, null);
  });

  await t.step('returns unchanged if marker but wrong pattern', () => {
    const content = `// @pls-version
const VERSION = '1.0.0';`;
    const result = updateVersionFile(content, '2.0.0');

    // Pattern requires 'export const', replace does nothing
    assertEquals(result, content);
  });
});

Deno.test('prependChangelog', async (t) => {
  await t.step('prepends new entry to existing changelog', () => {
    const existing = `# Changelog

## [1.0.0] - 2024-01-01
- Initial release
`;
    const newEntry = `## [2.0.0] - 2024-02-01
- New feature`;
    const result = prependChangelog(existing, newEntry);

    assertEquals(result.startsWith('# Changelog\n\n## [2.0.0]'), true);
    assertEquals(result.includes('## [1.0.0]'), true);
  });

  await t.step('creates new changelog if none exists', () => {
    const result = prependChangelog(null, '## [1.0.0]\n- First');

    assertEquals(result.startsWith('# Changelog'), true);
    assertEquals(result.includes('## [1.0.0]'), true);
  });

  await t.step('handles empty existing changelog', () => {
    const result = prependChangelog('', '## [1.0.0]\n- First');

    assertEquals(result.startsWith('# Changelog'), true);
  });
});

Deno.test('createInitialVersionsManifest', async (t) => {
  await t.step('creates manifest without versionFile', () => {
    const result = createInitialVersionsManifest('1.0.0');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].version, '1.0.0');
    assertEquals(parsed['.'].versionFile, undefined);
  });

  await t.step('creates manifest with versionFile', () => {
    const result = createInitialVersionsManifest('1.0.0', 'src/version.ts');
    const parsed = JSON.parse(result);

    assertEquals(parsed['.'].version, '1.0.0');
    assertEquals(parsed['.'].versionFile, 'src/version.ts');
  });
});

Deno.test('buildReleaseFiles', async (t) => {
  await t.step('builds minimal release files', () => {
    const { files, commitMessage } = buildReleaseFiles({
      version: '1.1.0',
      from: '1.0.0',
      type: 'minor',
      denoJson: null,
      packageJson: null,
      versionsJson: JSON.stringify({ '.': { version: '1.0.0' } }),
      versionFile: null,
      changelog: '- New feature',
      existingChangelog: null,
    });

    assertEquals(files.has('.pls/versions.json'), true);
    const versions = JSON.parse(files.get('.pls/versions.json')!);
    assertEquals(versions['.'].version, '1.1.0');

    assertEquals(commitMessage.includes('v1.1.0'), true);
    assertEquals(commitMessage.includes('---pls-release---'), true);
  });

  await t.step('includes deno.json when present', () => {
    const { files } = buildReleaseFiles({
      version: '1.1.0',
      from: '1.0.0',
      type: 'minor',
      denoJson: JSON.stringify({ version: '1.0.0' }),
      packageJson: null,
      versionsJson: JSON.stringify({ '.': { version: '1.0.0' } }),
      versionFile: null,
      changelog: '- Change',
      existingChangelog: null,
    });

    assertEquals(files.has('deno.json'), true);
    const deno = JSON.parse(files.get('deno.json')!);
    assertEquals(deno.version, '1.1.0');
  });

  await t.step('includes package.json when present', () => {
    const { files } = buildReleaseFiles({
      version: '1.1.0',
      from: '1.0.0',
      type: 'minor',
      denoJson: null,
      packageJson: JSON.stringify({ version: '1.0.0' }),
      versionsJson: JSON.stringify({ '.': { version: '1.0.0' } }),
      versionFile: null,
      changelog: '- Change',
      existingChangelog: null,
    });

    assertEquals(files.has('package.json'), true);
    const pkg = JSON.parse(files.get('package.json')!);
    assertEquals(pkg.version, '1.1.0');
  });

  await t.step('includes version file when provided', () => {
    const { files } = buildReleaseFiles({
      version: '1.1.0',
      from: '1.0.0',
      type: 'minor',
      denoJson: null,
      packageJson: null,
      versionsJson: JSON.stringify({ '.': { version: '1.0.0' } }),
      versionFile: {
        path: 'src/version.ts',
        content: `// @pls-version\nexport const VERSION = '1.0.0';`,
      },
      changelog: '- Change',
      existingChangelog: null,
    });

    assertEquals(files.has('src/version.ts'), true);
    assertEquals(files.get('src/version.ts')?.includes("'1.1.0'"), true);
  });

  await t.step('includes changelog with existing content', () => {
    const { files } = buildReleaseFiles({
      version: '1.1.0',
      from: '1.0.0',
      type: 'minor',
      denoJson: null,
      packageJson: null,
      versionsJson: JSON.stringify({ '.': { version: '1.0.0' } }),
      versionFile: null,
      changelog: '## 1.1.0\n- New feature',
      existingChangelog: '# Changelog\n\n## 1.0.0\n- Old',
    });

    assertEquals(files.has('CHANGELOG.md'), true);
    const changelog = files.get('CHANGELOG.md')!;
    assertEquals(changelog.includes('## 1.1.0'), true);
    assertEquals(changelog.includes('## 1.0.0'), true);
  });

  await t.step('includes both deno.json and package.json when present', () => {
    const { files } = buildReleaseFiles({
      version: '2.0.0',
      from: '1.0.0',
      type: 'major',
      denoJson: JSON.stringify({ name: 'test', version: '1.0.0' }),
      packageJson: JSON.stringify({ name: 'test', version: '1.0.0' }),
      versionsJson: JSON.stringify({ '.': { version: '1.0.0' } }),
      versionFile: null,
      changelog: '- Breaking change',
      existingChangelog: null,
    });

    assertEquals(files.has('deno.json'), true);
    assertEquals(files.has('package.json'), true);
    assertEquals(JSON.parse(files.get('deno.json')!).version, '2.0.0');
    assertEquals(JSON.parse(files.get('package.json')!).version, '2.0.0');
  });
});
