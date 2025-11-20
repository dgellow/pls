import { assertEquals } from '@std/assert';
import { Version } from './version.ts';
import type { Commit } from '../types.ts';

Deno.test('Version - determineBumpType for major (breaking change)', () => {
  const version = new Version();
  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'feat!: breaking change',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bumpType = version.determineBumpType(commits);
  assertEquals(bumpType, 'major');
});

Deno.test('Version - determineBumpType for major (BREAKING CHANGE in body)', () => {
  const version = new Version();
  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'feat: new feature\n\nBREAKING CHANGE: this breaks things',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bumpType = version.determineBumpType(commits);
  assertEquals(bumpType, 'major');
});

Deno.test('Version - determineBumpType for minor (feature)', () => {
  const version = new Version();
  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'feat: add new feature',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bumpType = version.determineBumpType(commits);
  assertEquals(bumpType, 'minor');
});

Deno.test('Version - determineBumpType for patch (fix)', () => {
  const version = new Version();
  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'fix: fix bug',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bumpType = version.determineBumpType(commits);
  assertEquals(bumpType, 'patch');
});

Deno.test('Version - determineBumpType for patch (chore)', () => {
  const version = new Version();
  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'chore: update dependencies',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bumpType = version.determineBumpType(commits);
  assertEquals(bumpType, 'patch'); // Default to patch
});

Deno.test('Version - determineBumpType returns null for no commits', () => {
  const version = new Version();
  const bumpType = version.determineBumpType([]);
  assertEquals(bumpType, null);
});

Deno.test('Version - calculateNextVersion for major', () => {
  const version = new Version();
  const next = version.calculateNextVersion('1.2.3', 'major');
  assertEquals(next, '2.0.0');
});

Deno.test('Version - calculateNextVersion for minor', () => {
  const version = new Version();
  const next = version.calculateNextVersion('1.2.3', 'minor');
  assertEquals(next, '1.3.0');
});

Deno.test('Version - calculateNextVersion for patch', () => {
  const version = new Version();
  const next = version.calculateNextVersion('1.2.3', 'patch');
  assertEquals(next, '1.2.4');
});

Deno.test('Version - determineVersionBump with commits', async () => {
  const version = new Version();
  const commits: Commit[] = [
    {
      sha: 'abc123',
      message: 'feat: new feature',
      author: 'Test User',
      date: new Date(),
    },
  ];

  const bump = await version.determineVersionBump('1.0.0', commits);

  assertEquals(bump?.from, '1.0.0');
  assertEquals(bump?.to, '1.1.0');
  assertEquals(bump?.type, 'minor');
  assertEquals(bump?.commits.length, 1);
});

Deno.test('Version - determineVersionBump with no previous version defaults to 0.0.0', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-version-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const version = new Version();
    const commits: Commit[] = [
      {
        sha: 'abc123',
        message: 'feat: initial feature',
        author: 'Test User',
        date: new Date(),
      },
    ];

    const bump = await version.determineVersionBump(null, commits);

    assertEquals(bump?.from, '0.0.0');
    assertEquals(bump?.to, '0.1.0');
    assertEquals(bump?.type, 'minor');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Version - determineVersionBump returns null for no commits', async () => {
  const version = new Version();
  const bump = await version.determineVersionBump('1.0.0', []);
  assertEquals(bump, null);
});

Deno.test('Version - getCurrentVersion reads from package.json', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-version-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    await Deno.writeTextFile('package.json', JSON.stringify({ version: '2.5.3' }));

    const version = new Version();
    const currentVersion = await version.getCurrentVersion();

    assertEquals(currentVersion, '2.5.3');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Version - getCurrentVersion reads from deno.json', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-version-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    await Deno.writeTextFile('deno.json', JSON.stringify({ version: '1.2.3' }));

    const version = new Version();
    const currentVersion = await version.getCurrentVersion();

    assertEquals(currentVersion, '1.2.3');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Version - getCurrentVersion returns null when no version files exist', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-version-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const version = new Version();
    const currentVersion = await version.getCurrentVersion();

    assertEquals(currentVersion, null);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Version - getCurrentVersion prefers package.json over deno.json', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-version-test-' });
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    await Deno.writeTextFile('package.json', JSON.stringify({ version: '3.0.0' }));
    await Deno.writeTextFile('deno.json', JSON.stringify({ version: '2.0.0' }));

    const version = new Version();
    const currentVersion = await version.getCurrentVersion();

    assertEquals(currentVersion, '3.0.0');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
