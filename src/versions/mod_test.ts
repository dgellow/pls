import { assertEquals } from '@std/assert';
import {
  getVersion,
  hasVersionsManifest,
  readVersions,
  setAllVersions,
  setVersion,
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
