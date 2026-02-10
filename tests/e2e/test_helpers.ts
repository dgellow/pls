/**
 * Shared test helpers for integration/e2e tests.
 *
 * Provides createTestRepo() and run() used across test files.
 */

import { LocalGit } from '../../src/clients/local-git.ts';

/**
 * Helper to create a test git repository with initial setup.
 */
export async function createTestRepo(): Promise<{
  dir: string;
  git: LocalGit;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: 'pls-test-' });

  // Initialize git repo with explicit branch name
  await run(dir, ['git', 'init', '-b', 'main']);

  // Configure git user for commits
  await run(dir, ['git', 'config', 'user.email', 'test@example.com']);
  await run(dir, ['git', 'config', 'user.name', 'Test User']);

  // Disable commit signing (may be enabled globally in some environments)
  await run(dir, ['git', 'config', 'commit.gpgsign', 'false']);
  await run(dir, ['git', 'config', 'tag.gpgsign', 'false']);

  const git = new LocalGit(dir);

  const cleanup = async () => {
    await Deno.remove(dir, { recursive: true });
  };

  return { dir, git, cleanup };
}

/**
 * Run a command in a directory.
 */
export async function run(cwd: string, cmd: string[]): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: 'piped',
    stderr: 'piped',
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Command failed: ${cmd.join(' ')}\n${error}`);
  }

  return new TextDecoder().decode(stdout).trim();
}
