/**
 * The CLI as a process: what it does with arguments it does not know.
 */

import { assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { createTestRepo, run } from '../../tests/e2e/test_helpers.ts';

const MAIN = fromFileUrl(new URL('./main.ts', import.meta.url));

async function pls(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', MAIN, ...args],
    cwd,
    env: { NO_COLOR: '1' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const decoder = new TextDecoder();
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
}

/** A repository with pls initialised at 1.2.2 and one feature commit to release. */
async function releasableRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await createTestRepo();
  await Deno.writeTextFile(`${dir}/package.json`, '{ "name": "demo", "version": "1.2.2" }\n');
  await run(dir, ['git', 'add', '-A']);
  await run(dir, ['git', 'commit', '-m', 'chore: init']);

  const init = await pls(dir, ['init', '--execute']);
  assertEquals(init.code, 0, init.stderr);
  await run(dir, ['git', 'add', '-A']);
  await run(dir, ['git', 'commit', '-m', 'chore: initialize pls']);

  await Deno.writeTextFile(`${dir}/a.txt`, 'a\n');
  await run(dir, ['git', 'add', '-A']);
  await run(dir, ['git', 'commit', '-m', 'feat: add a']);
  return { dir, cleanup };
}

async function state(dir: string): Promise<{ head: string; tags: string; dirty: string }> {
  return {
    head: await run(dir, ['git', 'rev-parse', 'HEAD']),
    tags: await run(dir, ['git', 'tag']),
    dirty: await run(dir, ['git', 'status', '--porcelain']),
  };
}

Deno.test('cli: arguments it does not know', async (t) => {
  const { dir, cleanup } = await releasableRepo();
  try {
    const before = await state(dir);

    const refused: [string[], string][] = [
      [['relase', '--execute'], 'Unknown command "relase"'],
      [['--execute', 'relase'], 'Unknown command "relase"'],
      [['--exceute'], 'Unknown option "--exceute" for `pls`'],
      [['--execute', '--psuh'], 'Unknown option "--psuh" for `pls`'],
      [['init', '--execute', '--versoin=2.0.0'], 'Unknown option "--versoin=2.0.0" for `pls init`'],
      [['init', '--execute', '--strategy=bogus'], 'Invalid strategy "bogus"'],
      [['prep', '--execute', 'extra'], 'Unexpected argument "extra" for `pls prep`'],
      [['prep', '--execute', '--base='], 'Option "--base" has no value'],
      [['sync', '--pr=12abc'], 'Invalid PR number "12abc"'],
      [['release', '--tokne=x'], 'Unknown option "--tokne=x" for `pls release`'],
      [
        ['transition', 'beta', '--execute', '--mayor'],
        'Unknown option "--mayor" for `pls transition`',
      ],
      [
        ['transition', 'alpha', 'beta', '--execute'],
        'Unexpected argument "beta" for `pls transition`',
      ],
    ];

    for (const [args, message] of refused) {
      await t.step(`refuses \`pls ${args.join(' ')}\` and changes nothing`, async () => {
        const result = await pls(dir, args);
        assertEquals(result.code, 1, result.stdout + result.stderr);
        assertEquals(result.stderr.includes(`❌ ${message}`), true, result.stderr);
        assertEquals(await state(dir), before);
      });
    }

    await t.step('still makes the release when the arguments are right', async () => {
      const result = await pls(dir, ['--execute']);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.stdout.includes('Released v1.3.0'), true, result.stdout);
      assertEquals((await state(dir)).tags, 'v1.2.2\nv1.3.0');
    });
  } finally {
    await cleanup();
  }
});

Deno.test('cli: where it is started', async (t) => {
  const { dir, cleanup } = await releasableRepo();
  const outside = await Deno.makeTempDir({ prefix: 'pls-test-outside-' });

  try {
    await t.step('a subdirectory of the repository works like its root', async () => {
      await Deno.mkdir(`${dir}/src/deep`, { recursive: true });
      const result = await pls(`${dir}/src/deep`, []);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.stdout.includes('1.2.2 → 1.3.0'), true, result.stdout);
    });

    await t.step('outside a repository, every command says so', async () => {
      for (
        const args of [[], ['init'], ['prep'], ['sync', '--pr=1'], ['release'], [
          'transition',
          'beta',
        ]]
      ) {
        const result = await pls(outside, args);
        assertEquals(result.code, 1, args.join(' '));
        assertEquals(
          result.stderr.includes('❌ Not in a git repository'),
          true,
          `pls ${args.join(' ')}: ${result.stdout}${result.stderr}`,
        );
      }
    });
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test('cli: --execute on the commands that have no dry run', async (t) => {
  const { dir, cleanup } = await createTestRepo();
  try {
    // Past argument parsing, both stop at the first thing they need and do not have.
    await t.step('sync takes it', async () => {
      const result = await pls(dir, ['sync', '--execute']);
      assertEquals(result.code, 1);
      assertEquals(result.stderr.includes('PR number required'), true, result.stderr);
    });

    await t.step('release takes it', async () => {
      const result = await pls(dir, ['release', '--execute', '--help']);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(result.stdout.includes('pls release'), true, result.stdout);
    });
  } finally {
    await cleanup();
  }
});
