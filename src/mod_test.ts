import { assertEquals } from '@std/assert';
import { createRelease } from './mod.ts';

async function setupTestRepo(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-mod-test-' });

  // Initialize git repo
  await new Deno.Command('git', {
    args: ['init'],
    cwd: tempDir,
  }).output();

  // Configure git
  await new Deno.Command('git', {
    args: ['config', 'user.email', 'test@example.com'],
    cwd: tempDir,
  }).output();

  await new Deno.Command('git', {
    args: ['config', 'user.name', 'Test User'],
    cwd: tempDir,
  }).output();

  await new Deno.Command('git', {
    args: ['config', 'commit.gpgsign', 'false'],
    cwd: tempDir,
  }).output();

  // Create initial commit
  await Deno.writeTextFile(`${tempDir}/README.md`, 'Initial commit');
  await new Deno.Command('git', {
    args: ['add', '.'],
    cwd: tempDir,
  }).output();

  await new Deno.Command('git', {
    args: ['commit', '-m', 'feat: initial commit'],
    cwd: tempDir,
  }).output();

  return tempDir;
}

Deno.test('createRelease - creates release with local storage', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const release = await createRelease({
      storage: 'local',
      dryRun: true,
    });

    assertEquals(release?.version, '0.1.0');
    assertEquals(release?.tag, 'v0.1.0');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('createRelease - returns null when no changes', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    // Create initial release
    const firstRelease = await createRelease({
      storage: 'local',
      dryRun: false,
    });

    assertEquals(firstRelease?.version, '0.1.0');

    // Try to create another release with no new commits
    const secondRelease = await createRelease({
      storage: 'local',
      dryRun: false,
    });

    assertEquals(secondRelease, null);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('createRelease - increments version with new commits', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    // Create initial release
    await createRelease({
      storage: 'local',
      dryRun: false,
    });

    // Add new feature commit
    await Deno.writeTextFile(`${tempDir}/feature.txt`, 'New feature');
    await new Deno.Command('git', {
      args: ['add', '.'],
      cwd: tempDir,
    }).output();

    await new Deno.Command('git', {
      args: ['commit', '-m', 'feat: add new feature'],
      cwd: tempDir,
    }).output();

    // Create second release
    const release = await createRelease({
      storage: 'local',
      dryRun: true,
    });

    assertEquals(release?.version, '0.2.0');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('createRelease - uses default storage (local)', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const release = await createRelease({
      dryRun: true,
    });

    // Should work with default storage
    assertEquals(release?.version, '0.1.0');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('createRelease - respects dryRun option', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    await createRelease({
      storage: 'local',
      dryRun: true,
    });

    // In dry run mode, storage should not have any releases
    const { LocalStorage } = await import('./storage/local.ts');
    const storage = new LocalStorage();
    const lastRelease = await storage.getLastRelease();

    assertEquals(lastRelease, null);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
