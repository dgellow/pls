import { assertEquals, assertStringIncludes } from '@std/assert';
import { ReleaseManager } from './release.ts';
import type { Commit, Release, Storage, VersionBump } from '../types.ts';

// Mock storage implementation for testing
class MockStorage implements Storage {
  public releases: Release[] = [];

  async getLastRelease(): Promise<Release | null> {
    return await Promise.resolve(this.releases.length > 0 ? this.releases[0] : null);
  }

  async saveRelease(release: Release): Promise<void> {
    this.releases.unshift(release);
    return await Promise.resolve();
  }

  async listReleases(): Promise<Release[]> {
    return await Promise.resolve(this.releases);
  }
}

Deno.test('ReleaseManager - generateReleaseNotes with features', () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.1.0',
    type: 'minor',
    commits: [
      {
        sha: 'abc123',
        message: 'feat: add new feature',
        author: 'Test User',
        date: new Date(),
      },
    ],
  };

  const notes = manager.generateReleaseNotes(bump);

  assertStringIncludes(notes, '## 1.1.0');
  assertStringIncludes(notes, '### Features');
  assertStringIncludes(notes, 'add new feature');
  assertStringIncludes(notes, 'abc123'.substring(0, 7));
});

Deno.test('ReleaseManager - generateReleaseNotes with bug fixes', () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.0.1',
    type: 'patch',
    commits: [
      {
        sha: 'def456',
        message: 'fix: resolve critical bug',
        author: 'Test User',
        date: new Date(),
      },
    ],
  };

  const notes = manager.generateReleaseNotes(bump);

  assertStringIncludes(notes, '## 1.0.1');
  assertStringIncludes(notes, '### Bug Fixes');
  assertStringIncludes(notes, 'resolve critical bug');
});

Deno.test('ReleaseManager - generateReleaseNotes with multiple commit types', () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'feat: add feature A',
      author: 'Test User',
      date: new Date(),
    },
    {
      sha: 'def456',
      message: 'fix: fix bug B',
      author: 'Test User',
      date: new Date(),
    },
    {
      sha: 'ghi789',
      message: 'docs: update documentation',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.1.0',
    type: 'minor',
    commits,
  };

  const notes = manager.generateReleaseNotes(bump);

  assertStringIncludes(notes, '### Features');
  assertStringIncludes(notes, '### Bug Fixes');
  assertStringIncludes(notes, '### Documentation');
});

Deno.test('ReleaseManager - generateReleaseNotes with scoped commits', () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.1.0',
    type: 'minor',
    commits: [
      {
        sha: 'abc123',
        message: 'feat(api): add new endpoint',
        author: 'Test User',
        date: new Date(),
      },
    ],
  };

  const notes = manager.generateReleaseNotes(bump);

  assertStringIncludes(notes, 'add new endpoint');
});

Deno.test('ReleaseManager - generateReleaseNotes with non-conventional commits', () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.0.1',
    type: 'patch',
    commits: [
      {
        sha: 'abc123',
        message: 'Update README',
        author: 'Test User',
        date: new Date(),
      },
    ],
  };

  const notes = manager.generateReleaseNotes(bump);

  assertStringIncludes(notes, '### Other Changes');
  assertStringIncludes(notes, 'Update README');
});

Deno.test('ReleaseManager - generateReleaseNotes for transition', () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.1.0-alpha.0',
    type: 'transition',
    commits: [],
  };

  const notes = manager.generateReleaseNotes(bump);

  assertStringIncludes(notes, '## 1.1.0-alpha.0');
  assertStringIncludes(notes, 'Version transition from 1.0.0 to 1.1.0-alpha.0');
});

Deno.test('ReleaseManager - createRelease saves to storage', async () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.1.0',
    type: 'minor',
    commits: [
      {
        sha: 'abc123',
        message: 'feat: new feature',
        author: 'Test User',
        date: new Date(),
      },
    ],
  };

  const release = await manager.createRelease(bump, 'abc123', true); // dry run

  assertEquals(release.version, '1.1.0');
  assertEquals(release.tag, 'v1.1.0');
  assertEquals(release.sha, 'abc123');
  assertStringIncludes(release.notes || '', 'new feature');
});

Deno.test('ReleaseManager - createRelease in dry run mode', async () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const bump: VersionBump = {
    from: '1.0.0',
    to: '1.1.0',
    type: 'minor',
    commits: [
      {
        sha: 'abc123',
        message: 'feat: new feature',
        author: 'Test User',
        date: new Date(),
      },
    ],
  };

  const release = await manager.createRelease(bump, 'abc123', true);

  // Dry run should not save to storage
  const lastRelease = await storage.getLastRelease();
  assertEquals(lastRelease, null);

  // But should return release object
  assertEquals(release.version, '1.1.0');
});

Deno.test('ReleaseManager - createReleaseFromCommit uses provided notes', async () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const notes = `## 1.2.0

### Features

- add awesome feature (abc1234)
- add another feature (def5678)`;

  const release = await manager.createReleaseFromCommit(
    '1.2.0',
    'abc123',
    true, // dry run
    'github',
    notes,
  );

  assertEquals(release.version, '1.2.0');
  assertEquals(release.tag, 'v1.2.0');
  assertEquals(release.notes, notes);
});

Deno.test('ReleaseManager - createReleaseFromCommit uses default notes when not provided', async () => {
  const storage = new MockStorage();
  const manager = new ReleaseManager(storage);

  const release = await manager.createReleaseFromCommit(
    '1.2.0',
    'abc123',
    true, // dry run
    'github',
    // no notes provided
  );

  assertEquals(release.version, '1.2.0');
  assertEquals(release.notes, 'Release 1.2.0');
});
