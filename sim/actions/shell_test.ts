/**
 * Tests of the shell runner that executes workflow steps and the maintainer's
 * commands. The time limit is the part that differs between machines.
 */

import { assert, assertEquals } from '@std/assert';
import { runShell } from './shell.ts';

const env = { PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin' };

/** Processes whose command line contains `marker`. */
async function running(marker: string): Promise<string[]> {
  const out = await new Deno.Command('pgrep', { args: ['-f', marker], stdout: 'piped' }).output();
  return new TextDecoder().decode(out.stdout).split('\n').filter((l) => l.trim());
}

Deno.test('runShell', async (t) => {
  const cwd = await Deno.makeTempDir({ prefix: 'pls-sim-shell-' });

  try {
    await t.step('returns the exit code and both streams', async () => {
      const r = await runShell('echo out; echo err >&2; exit 3', { cwd, env, timeoutMs: 5000 });
      assertEquals(r.code, 3);
      assertEquals(r.stdout, 'out\n');
      assertEquals(r.stderr, 'err\n');
      assertEquals(r.timedOut, false);
    });

    await t.step('stops at the first failing command, including inside a pipe', async () => {
      const r = await runShell('false | cat; echo unreachable', { cwd, env, timeoutMs: 5000 });
      assertEquals(r.code, 1);
      assertEquals(r.stdout, '');
    });

    await t.step('passes the script through unchanged', async () => {
      const r = await runShell(`printf '%s\\n' "it's \\"quoted\\" $HOME \\$x"`, {
        cwd,
        env: { ...env, HOME: '/h' },
        timeoutMs: 5000,
      });
      assertEquals(r.stdout, `it's "quoted" /h $x\n`);
    });

    await t.step('a quick command does not wait for the time limit', async () => {
      const r = await runShell('echo done', { cwd, env, timeoutMs: 30_000 });
      assertEquals(r.code, 0);
      assert(r.ms < 5000, `took ${r.ms} ms`);
    });

    await t.step('kills a hung child of the script at the limit and returns', async () => {
      // The second line keeps bash from replacing itself with the first command,
      // so the hung process is a grandchild: the case a hung tool is in.
      const marker = '297.3141';
      const r = await runShell(`sleep ${marker}\necho unreachable`, { cwd, env, timeoutMs: 1000 });

      assertEquals(r.timedOut, true);
      assertEquals(r.code, null);
      assertEquals(r.stdout, '');
      assert(r.ms < 10_000, `returned after ${r.ms} ms`);
      assertEquals(await running(`sleep ${marker}`), []);
    });

    await t.step('kills a background process the script left behind', async () => {
      const marker = '296.2718';
      const r = await runShell(`sleep ${marker} &\nsleep ${marker}`, { cwd, env, timeoutMs: 1000 });

      assertEquals(r.timedOut, true);
      assert(r.ms < 10_000, `returned after ${r.ms} ms`);
      assertEquals(await running(`sleep ${marker}`), []);
    });

    await t.step('leaves no watchdog behind after a normal exit', async () => {
      const r = await runShell('true', { cwd, env, timeoutMs: 295_000 });
      assertEquals(r.code, 0);
      assertEquals(await running('sleep 295'), []);
    });
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
