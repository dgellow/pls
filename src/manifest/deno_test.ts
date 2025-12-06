import { assertEquals } from '@std/assert';
import { DenoManifest } from './deno.ts';

Deno.test('DenoManifest - getVersion reads version from deno.json', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({ name: '@test/pkg', version: '1.2.3' }, null, 2),
    );

    const manifest = new DenoManifest(tempDir);
    const version = await manifest.getVersion();

    assertEquals(version, '1.2.3');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('DenoManifest - getVersion returns null when no version', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({ name: '@test/pkg' }, null, 2),
    );

    const manifest = new DenoManifest(tempDir);
    const version = await manifest.getVersion();

    assertEquals(version, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('DenoManifest - setVersion updates existing version', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({ name: '@test/pkg', version: '1.0.0' }, null, 2),
    );

    const manifest = new DenoManifest(tempDir);
    await manifest.setVersion('2.0.0');

    const content = await Deno.readTextFile(`${tempDir}/deno.json`);
    const parsed = JSON.parse(content);

    assertEquals(parsed.version, '2.0.0');
    assertEquals(parsed.name, '@test/pkg');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('DenoManifest - setVersion adds version when missing', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({ name: '@test/pkg' }, null, 2),
    );

    const manifest = new DenoManifest(tempDir);
    await manifest.setVersion('1.0.0');

    const content = await Deno.readTextFile(`${tempDir}/deno.json`);
    const parsed = JSON.parse(content);

    assertEquals(parsed.version, '1.0.0');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('DenoManifest - exists returns false for missing file', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const manifest = new DenoManifest(tempDir);
    const exists = await manifest.exists();

    assertEquals(exists, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('DenoManifest - getWorkspaceMembers returns workspace array', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify(
        {
          workspace: ['./packages/a', './packages/b'],
        },
        null,
        2,
      ),
    );

    const manifest = new DenoManifest(tempDir);
    const members = await manifest.getWorkspaceMembers();

    assertEquals(members, ['./packages/a', './packages/b']);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
