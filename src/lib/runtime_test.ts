import { assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import * as runtime from './runtime.ts';

Deno.test('runtime', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'pls-runtime-' });

  await t.step('args, env and cwd match the process', () => {
    assertEquals(runtime.args(), Deno.args);
    assertEquals(runtime.cwd(), Deno.cwd());

    Deno.env.set('PLS_RUNTIME_TEST', 'value');
    try {
      assertEquals(runtime.env('PLS_RUNTIME_TEST'), 'value');
    } finally {
      Deno.env.delete('PLS_RUNTIME_TEST');
    }
    assertEquals(runtime.env('PLS_RUNTIME_TEST'), undefined);
  });

  await t.step('writes and reads text files as UTF-8', async () => {
    const path = join(dir, 'file.txt');
    await runtime.writeTextFile(path, 'héllo → 世界\n');
    assertEquals(await runtime.readTextFile(path), 'héllo → 世界\n');
    assertEquals(await Deno.readTextFile(path), 'héllo → 世界\n');
  });

  await t.step('writeTextFile replaces the content', async () => {
    const path = join(dir, 'replace.txt');
    await runtime.writeTextFile(path, 'a long first version\n');
    await runtime.writeTextFile(path, 'short\n');
    assertEquals(await runtime.readTextFile(path), 'short\n');
  });

  await t.step('readTextFile rejects for a missing file', async () => {
    await assertRejects(() => runtime.readTextFile(join(dir, 'missing.txt')));
  });

  await t.step('ensureDir creates parents and accepts an existing directory', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    await runtime.ensureDir(nested);
    await runtime.ensureDir(nested);
    assertEquals((await Deno.stat(nested)).isDirectory, true);
  });

  await t.step('pathExists', async () => {
    assertEquals(await runtime.pathExists(dir), true);
    assertEquals(await runtime.pathExists(join(dir, 'file.txt')), true);
    assertEquals(await runtime.pathExists(join(dir, 'nope')), false);
  });

  await t.step('runCommand returns the output and the exit code', async () => {
    const ok = await runtime.runCommand('git', ['--version']);
    assertEquals(ok.code, 0);
    assertEquals(ok.stdout.startsWith('git version'), true);
    assertEquals(ok.stderr, '');

    const failed = await runtime.runCommand('git', ['no-such-subcommand']);
    assertEquals(failed.code !== 0, true);
    assertEquals(failed.stderr.includes('no-such-subcommand'), true);
  });

  await t.step('runCommand runs in the given directory', async () => {
    await runtime.runCommand('git', ['init', '--quiet'], { cwd: dir });
    const result = await runtime.runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    assertEquals(result.code, 0);
    assertEquals(await Deno.realPath(result.stdout.trim()), await Deno.realPath(dir));
  });

  await t.step('runCommand passes arguments without a shell', async () => {
    const result = await runtime.runCommand('git', ['config', '--file', 'cfg', 'a.b', '$HOME; x'], {
      cwd: dir,
    });
    assertEquals(result.code, 0);
    const read = await runtime.runCommand('git', ['config', '--file', 'cfg', 'a.b'], { cwd: dir });
    assertEquals(read.stdout, '$HOME; x\n');
  });

  await t.step('runCommand collects output larger than a pipe buffer', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    await runtime.writeTextFile(join(dir, 'big.txt'), big);
    const result = await runtime.runCommand(
      'git',
      ['--no-pager', 'grep', '--no-index', '-h', 'x', 'big.txt'],
      { cwd: dir },
    );
    assertEquals(result.code, 0);
    assertEquals(result.stdout.length, big.length + 1);
  });

  await t.step('runCommand rejects when the program does not exist', async () => {
    await assertRejects(() => runtime.runCommand('pls-no-such-program', []));
  });

  await Deno.remove(dir, { recursive: true });
});
