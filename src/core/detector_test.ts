import { assertEquals, assertExists } from '@std/assert';
import { Detector } from './detector.ts';

async function setupTestRepo(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-detector-test-' });

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

Deno.test('Detector - getCurrentSha', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const detector = new Detector();
    const sha = await detector.getCurrentSha();

    assertExists(sha);
    assertEquals(sha.length, 40); // Git SHA is 40 characters
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Detector - getCommitsSince with no previous release', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const detector = new Detector();
    const commits = await detector.getCommitsSince(null);

    assertEquals(commits.length, 1);
    assertEquals(commits[0].message, 'feat: initial commit');
    assertEquals(commits[0].author, 'Test User');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Detector - getCommitsSince with previous release', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    // Get SHA of first commit
    const firstSha = (await new Deno.Command('git', {
      args: ['rev-parse', 'HEAD'],
      cwd: tempDir,
    }).output()).stdout;
    const firstCommitSha = new TextDecoder().decode(firstSha).trim();

    // Create second commit
    await Deno.writeTextFile(`${tempDir}/file.txt`, 'Second commit');
    await new Deno.Command('git', {
      args: ['add', '.'],
      cwd: tempDir,
    }).output();

    await new Deno.Command('git', {
      args: ['commit', '-m', 'fix: bug fix'],
      cwd: tempDir,
    }).output();

    const detector = new Detector();
    const commits = await detector.getCommitsSince(firstCommitSha);

    assertEquals(commits.length, 1);
    assertEquals(commits[0].message, 'fix: bug fix');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Detector - detectChanges with no previous release', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const detector = new Detector();
    const changes = await detector.detectChanges(null);

    assertEquals(changes.hasChanges, true);
    assertEquals(changes.commits.length, 1);
    assertExists(changes.currentSha);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test('Detector - detectChanges with no new commits', async () => {
  const tempDir = await setupTestRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const detector = new Detector();
    const currentSha = await detector.getCurrentSha();

    const changes = await detector.detectChanges({
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: currentSha,
      createdAt: new Date(),
    });

    assertEquals(changes.hasChanges, false);
    assertEquals(changes.commits.length, 0);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
