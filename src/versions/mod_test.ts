import { assertEquals } from '@std/assert';
import {
  getSha,
  getVersion,
  getVersionFile,
  hasVersionsManifest,
  readVersions,
  setAllVersions,
  setVersion,
  setVersionFile,
  writeVersions,
} from './mod.ts';

Deno.test('readVersions - returns empty object for missing file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const versions = await readVersions(tempDir);
    assertEquals(versions, {});
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('writeVersions - creates .pls directory and file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeVersions({ '.': '1.0.0' }, tempDir);

    const content = await Deno.readTextFile(`${tempDir}/.pls/versions.json`);
    const parsed = JSON.parse(content);

    assertEquals(parsed, { '.': '1.0.0' });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('getVersion - returns version for path', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({ '.': '1.0.0', 'packages/a': '2.0.0' }),
    );

    assertEquals(await getVersion('.', tempDir), '1.0.0');
    assertEquals(await getVersion('packages/a', tempDir), '2.0.0');
    assertEquals(await getVersion('packages/b', tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('setVersion - updates single path', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await setVersion('1.0.0', '.', tempDir);
    await setVersion('2.0.0', 'packages/a', tempDir);

    const versions = await readVersions(tempDir);
    assertEquals(versions, { '.': '1.0.0', 'packages/a': '2.0.0' });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('setAllVersions - updates multiple paths', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await setAllVersions('3.0.0', ['.', 'packages/a', 'packages/b'], tempDir);

    const versions = await readVersions(tempDir);
    assertEquals(versions, {
      '.': '3.0.0',
      'packages/a': '3.0.0',
      'packages/b': '3.0.0',
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('hasVersionsManifest - returns false for missing', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await hasVersionsManifest(tempDir), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('hasVersionsManifest - returns true when exists', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeVersions({ '.': '1.0.0' }, tempDir);
    assertEquals(await hasVersionsManifest(tempDir), true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// getSha tests - critical for understanding the steady repo issue
Deno.test('getSha - returns null for old string format (no SHA)', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    // Old format: just version strings, no SHA
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        '.': '0.1.0',
        'packages/json-pointer': '0.1.0',
        'packages/json-schema': '0.1.0',
      }),
    );

    // getSha should return null for old string format
    assertEquals(await getSha('.', tempDir), null);
    assertEquals(await getSha('packages/json-pointer', tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('getSha - returns SHA for new object format', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    // New format: objects with version and sha
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        '.': { version: '0.1.0', sha: 'abc123def456' },
        'packages/a': { version: '0.2.0', sha: 'def789ghi012' },
      }),
    );

    assertEquals(await getSha('.', tempDir), 'abc123def456');
    assertEquals(await getSha('packages/a', tempDir), 'def789ghi012');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('getSha - returns null for missing path', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({ '.': { version: '1.0.0', sha: 'abc123' } }),
    );

    assertEquals(await getSha('nonexistent', tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('getVersion - works with both old and new formats', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    // Mixed format
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        '.': '1.0.0', // old string format
        'packages/a': { version: '2.0.0', sha: 'abc123' }, // new object format
      }),
    );

    // getVersion should work with both formats
    assertEquals(await getVersion('.', tempDir), '1.0.0');
    assertEquals(await getVersion('packages/a', tempDir), '2.0.0');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// versionFile tests
Deno.test('getVersionFile - returns null for old string format', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({ '.': '1.0.0' }),
    );

    assertEquals(await getVersionFile('.', tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('getVersionFile - returns path from object format', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        '.': { version: '1.0.0', versionFile: 'src/version_info.ts' },
      }),
    );

    assertEquals(await getVersionFile('.', tempDir), 'src/version_info.ts');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('setVersionFile - adds versionFile to existing entry', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({ '.': { version: '1.0.0', sha: 'abc123' } }),
    );

    await setVersionFile('src/version.ts', '.', tempDir);

    const versions = await readVersions(tempDir);
    assertEquals(versions['.'], {
      version: '1.0.0',
      sha: 'abc123',
      versionFile: 'src/version.ts',
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('setVersionFile - creates entry if none exists', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await setVersionFile('src/version.ts', '.', tempDir);

    const versions = await readVersions(tempDir);
    assertEquals(versions['.'], {
      version: '0.0.0',
      versionFile: 'src/version.ts',
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('setVersion - preserves versionFile field', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        '.': { version: '1.0.0', versionFile: 'src/version.ts' },
      }),
    );

    await setVersion('2.0.0', '.', tempDir);

    const versions = await readVersions(tempDir);
    assertEquals(versions['.'], {
      version: '2.0.0',
      versionFile: 'src/version.ts',
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('setVersion - preserves both sha and versionFile', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        '.': { version: '1.0.0', sha: 'abc123', versionFile: 'src/version.ts' },
      }),
    );

    await setVersion('2.0.0', '.', tempDir, 'def456');

    const versions = await readVersions(tempDir);
    assertEquals(versions['.'], {
      version: '2.0.0',
      sha: 'def456',
      versionFile: 'src/version.ts',
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
