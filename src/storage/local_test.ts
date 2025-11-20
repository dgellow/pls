import { assertEquals, assertExists } from '@std/assert';
import { LocalStorage } from './local.ts';
import type { Release } from '../types.ts';

Deno.test('LocalStorage - saveRelease and getLastRelease', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const storage = new LocalStorage();
    const release: Release = {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'abc123',
      createdAt: new Date('2025-01-01'),
      notes: 'Test release',
    };

    await storage.saveRelease(release);
    const retrieved = await storage.getLastRelease();

    assertExists(retrieved);
    assertEquals(retrieved.version, '1.0.0');
    assertEquals(retrieved.tag, 'v1.0.0');
    assertEquals(retrieved.sha, 'abc123');
    assertEquals(retrieved.notes, 'Test release');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('LocalStorage - listReleases', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const storage = new LocalStorage();

    const release1: Release = {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'abc123',
      createdAt: new Date('2025-01-01'),
    };

    const release2: Release = {
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: 'def456',
      createdAt: new Date('2025-01-02'),
    };

    await storage.saveRelease(release1);
    await storage.saveRelease(release2);

    const releases = await storage.listReleases();

    assertEquals(releases.length, 2);
    assertEquals(releases[0].version, '1.1.0'); // Newest first
    assertEquals(releases[1].version, '1.0.0');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('LocalStorage - getLastRelease returns null when no releases', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const storage = new LocalStorage();
    const release = await storage.getLastRelease();

    assertEquals(release, null);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('LocalStorage - updates existing release on duplicate version', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const storage = new LocalStorage();

    const release1: Release = {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'abc123',
      createdAt: new Date('2025-01-01'),
      notes: 'First notes',
    };

    const release2: Release = {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'abc123',
      createdAt: new Date('2025-01-01'),
      notes: 'Updated notes',
    };

    await storage.saveRelease(release1);
    await storage.saveRelease(release2);

    const releases = await storage.listReleases();
    assertEquals(releases.length, 1); // Should not duplicate
    assertEquals(releases[0].notes, 'Updated notes'); // Should be updated
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
