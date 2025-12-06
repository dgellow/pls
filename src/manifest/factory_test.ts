import { assertEquals } from '@std/assert';
import { createManifest, detectWorkspace, updateAllVersions } from './factory.ts';

Deno.test('createManifest - auto-detects deno.json', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({ version: '1.0.0' }, null, 2),
    );

    const manifest = await createManifest(tempDir);

    assertEquals(manifest?.type, 'deno');
    assertEquals(await manifest?.getVersion(), '1.0.0');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('createManifest - auto-detects package.json when no deno.json', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/package.json`,
      JSON.stringify({ version: '2.0.0' }, null, 2),
    );

    const manifest = await createManifest(tempDir);

    assertEquals(manifest?.type, 'node');
    assertEquals(await manifest?.getVersion(), '2.0.0');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('createManifest - prefers deno.json over package.json', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({ version: '1.0.0' }, null, 2),
    );
    await Deno.writeTextFile(
      `${tempDir}/package.json`,
      JSON.stringify({ version: '2.0.0' }, null, 2),
    );

    const manifest = await createManifest(tempDir);

    assertEquals(manifest?.type, 'deno');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('detectWorkspace - detects deno workspace', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Create root deno.json with workspace
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({
        version: '1.0.0',
        workspace: ['./packages/a'],
      }, null, 2),
    );

    // Create workspace member
    await Deno.mkdir(`${tempDir}/packages/a`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/packages/a/deno.json`,
      JSON.stringify({ version: '1.0.0' }, null, 2),
    );

    const workspace = await detectWorkspace(tempDir);

    assertEquals(workspace.isWorkspace, true);
    assertEquals(workspace.members.length, 1);
    assertEquals(workspace.members[0].path, 'packages/a');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('updateAllVersions - updates root and workspace members', async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Create root deno.json with workspace
    await Deno.writeTextFile(
      `${tempDir}/deno.json`,
      JSON.stringify({
        version: '1.0.0',
        workspace: ['./packages/a'],
      }, null, 2),
    );

    // Create workspace member
    await Deno.mkdir(`${tempDir}/packages/a`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/packages/a/deno.json`,
      JSON.stringify({ version: '1.0.0' }, null, 2),
    );

    const result = await updateAllVersions('2.0.0', tempDir);

    assertEquals(result.updated.length, 2);
    assertEquals(result.errors.length, 0);

    // Verify versions were updated
    const rootContent = JSON.parse(await Deno.readTextFile(`${tempDir}/deno.json`));
    const memberContent = JSON.parse(await Deno.readTextFile(`${tempDir}/packages/a/deno.json`));

    assertEquals(rootContent.version, '2.0.0');
    assertEquals(memberContent.version, '2.0.0');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
