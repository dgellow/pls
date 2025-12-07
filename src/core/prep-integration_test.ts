/**
 * RED-GREEN test: Demonstrate the bug before fixing it.
 *
 * This test replicates the dgellow/steady scenario where:
 * 1. .pls/versions.json exists with OLD string format (no SHA)
 * 2. No GitHub releases exist
 * 3. The code should still detect commits and calculate a bump
 *
 * Debugging: https://github.com/dgellow/steady/actions/runs/19997714771
 */

import { assertEquals, assertExists } from '@std/assert';
import { Detector } from './detector.ts';
import { Version } from './version.ts';
import {
  getSha as getShaFromManifest,
  getVersion as getVersionFromManifest,
  hasVersionsManifest,
} from '../versions/mod.ts';
import type { Release } from '../types.ts';

async function runGit(cwd: string, args: string[]): Promise<string> {
  const command = new Deno.Command('git', { args, cwd });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(`Git command failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

async function setupSteadyLikeRepo(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-steady-test-' });

  await runGit(tempDir, ['init']);
  await runGit(tempDir, ['config', 'user.email', 'test@example.com']);
  await runGit(tempDir, ['config', 'user.name', 'Test User']);
  await runGit(tempDir, ['config', 'commit.gpgsign', 'false']);

  // Create commits similar to steady's history
  await Deno.writeTextFile(`${tempDir}/deno.json`, JSON.stringify({ version: '0.1.0' }, null, 2));
  await runGit(tempDir, ['add', '.']);
  await runGit(tempDir, ['commit', '-m', 'feat: initial project setup']);

  await Deno.writeTextFile(`${tempDir}/lib.ts`, 'export const a = 1;');
  await runGit(tempDir, ['add', '.']);
  await runGit(tempDir, ['commit', '-m', 'feat: Add release workflows']);

  await Deno.writeTextFile(`${tempDir}/lib.ts`, 'export const a = 2;');
  await runGit(tempDir, ['add', '.']);
  await runGit(tempDir, ['commit', '-m', 'fix: Handle edge case']);

  // Create .pls/versions.json with OLD string format (no SHA)
  await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
  await Deno.writeTextFile(
    `${tempDir}/.pls/versions.json`,
    JSON.stringify({ '.': '0.1.0' }, null, 2),
  );
  await runGit(tempDir, ['add', '.']);
  await runGit(tempDir, ['commit', '-m', 'chore: Add pls versions manifest']);

  return tempDir;
}

/**
 * BUG HYPOTHESIS: When versions.json has no SHA and there are no GitHub releases,
 * the code should detect ALL commits and calculate a bump. But something might be wrong.
 *
 * This test replicates cli-prep.ts handleCreateOrUpdate() logic exactly.
 */
Deno.test('BUG: versions.json without SHA + no GitHub releases should still create PR', async () => {
  const tempDir = await setupSteadyLikeRepo();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(tempDir);

    const detector = new Detector();

    // === REPLICATE cli-prep.ts EXACTLY ===

    let currentVersion: string | null = null;
    let lastRelease: Release | null = null;

    // Step 1: Try .pls/versions.json
    if (await hasVersionsManifest()) {
      currentVersion = await getVersionFromManifest();
      const manifestSha = await getShaFromManifest();

      if (currentVersion) {
        console.log(`Current version (from .pls/versions.json): ${currentVersion}`);

        if (manifestSha) {
          // Validate SHA exists in repo
          const shaIsValid = await detector.shaExists(manifestSha);
          if (shaIsValid) {
            lastRelease = {
              version: currentVersion,
              tag: `v${currentVersion}`,
              sha: manifestSha,
              createdAt: new Date(),
            };
            console.log(`Last release SHA: ${manifestSha.substring(0, 7)}`);
          } else {
            console.log(`SHA ${manifestSha.substring(0, 7)} not found`);
          }
        }
        // NOTE: If manifestSha is null/undefined, lastRelease stays null!
      }
    }

    // Step 2: Fall back to GitHub releases (simulated as returning null)
    // In real scenario: storage.getLastRelease() returns null for repo with no releases
    // lastRelease stays null - simulating no GitHub releases

    // At this point: currentVersion = "0.1.0", lastRelease = null
    console.log(`\nState after version detection:`);
    console.log(`  currentVersion: ${currentVersion}`);
    console.log(`  lastRelease: ${lastRelease}`);

    // Step 3: Detect changes
    console.log(`\nDetecting changes...`);
    const changes = await detector.detectChanges(lastRelease);

    console.log(`  hasChanges: ${changes.hasChanges}`);
    console.log(`  commits.length: ${changes.commits.length}`);
    if (changes.commits.length > 0) {
      console.log(`  commits:`);
      changes.commits.forEach((c) => console.log(`    - ${c.message}`));
    }

    // THIS IS THE KEY ASSERTION - should have changes
    assertEquals(changes.hasChanges, true, 'Should have changes detected');
    assertEquals(changes.commits.length, 4, 'Should detect all 4 commits');

    // Step 4: Determine version bump
    const version = new Version();
    const bump = await version.determineVersionBump(currentVersion!, changes.commits);

    console.log(`\nVersion bump result:`);
    console.log(`  bump: ${JSON.stringify(bump)}`);

    // THIS IS THE KEY ASSERTION - should have a bump
    assertExists(bump, 'Should calculate a version bump');
    assertEquals(bump.from, '0.1.0');
    assertEquals(bump.to, '0.2.0', 'feat commits should bump minor');
    assertEquals(bump.type, 'minor');

    // If all assertions pass, the bug is NOT in the core logic.
    // The bug must be in:
    // 1. GitHub API interaction (token, permissions)
    // 2. The JSR-published version of pls (outdated/different)
    // 3. Something specific to the GitHub Actions environment
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});

/**
 * Test the exact commit message parsing from steady's history
 */
Deno.test('Commit parsing matches steady repo format', async () => {
  const version = new Version();

  // These are the EXACT commit messages from steady
  const commits = [
    { sha: 'abc1', message: 'chore: Add pls versions manifest', author: 'A', date: new Date() },
    { sha: 'abc2', message: 'chore: Use PAT for pls release workflow', author: 'A', date: new Date() },
    { sha: 'abc3', message: 'refactor: Add caching and simplify CI/publish workflows', author: 'A', date: new Date() },
    { sha: 'abc4', message: 'fix: Handle dynamic object properties in query param validation', author: 'A', date: new Date() },
    { sha: 'abc5', message: 'test: Add tests for validator and path-matcher fixes', author: 'A', date: new Date() },
    { sha: 'abc6', message: 'fix: Improve type safety and error handling across validator modules', author: 'A', date: new Date() },
    { sha: 'abc7', message: 'refactor: Consolidate release workflows into publish.yml', author: 'A', date: new Date() },
    { sha: 'abc8', message: 'refactor: Improve version-bump workflow for workspace packages', author: 'A', date: new Date() },
    { sha: 'abc9', message: 'feat: Add release workflows for publishing and version bumping', author: 'A', date: new Date() },
  ];

  const bumpType = version.determineBumpType(commits);

  console.log(`Bump type for steady commits: ${bumpType}`);

  // Should be 'minor' because there's a feat: commit
  assertEquals(bumpType, 'minor', 'Should detect feat commit and return minor bump');
});

/**
 * RED TEST: Steady has multiple packages in versions.json but pls only looks at "."
 * What if the root package doesn't exist in versions.json but sub-packages do?
 */
Deno.test('BUG: versions.json with only sub-packages, no root "."', async () => {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-monorepo-test-' });
  const originalCwd = Deno.cwd();

  try {
    // Create versions.json with sub-packages but NO root "."
    await Deno.mkdir(`${tempDir}/.pls`, { recursive: true });
    await Deno.writeTextFile(
      `${tempDir}/.pls/versions.json`,
      JSON.stringify({
        'packages/json-pointer': '0.1.0',
        'packages/json-schema': '0.1.0',
        'packages/openapi': '0.1.0',
        // NOTE: No "." entry!
      }, null, 2),
    );

    Deno.chdir(tempDir);

    // This should return null since there's no "." entry
    const version = await getVersionFromManifest();
    console.log(`Version from manifest (no root): ${version}`);

    // BUG: If version is null, the code falls back to other sources
    // But what if there's no deno.json or package.json either?
    assertEquals(version, null, 'Should return null when no "." entry');
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tempDir, { recursive: true });
  }
});
