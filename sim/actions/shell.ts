/**
 * Run a bash script with a hard time limit.
 *
 * When the limit is reached, everything the script started is killed, not only
 * the shell: a tool that hangs on a request is a grandchild of this process,
 * and while it lives it keeps the output pipes open, so the caller would wait
 * for it forever.
 *
 * This uses bash job control instead of the `timeout` command. `timeout`
 * implementations differ in whether they signal the whole process group (GNU
 * coreutils does; the one on the ubuntu-26.04 runner image left the hung tool
 * alive), and bash is needed anyway.
 */

const decoder = new TextDecoder();

export interface ShellResult {
  /** Exit code; null when the script was killed at the time limit. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

// $1 is the script, $2 the limit in seconds.
// `set -m` gives each background job its own process group, whose id is the
// job's pid. The script runs as one job and a watchdog as another; whichever
// finishes first, the other's whole group is killed.
const SUPERVISOR = `
set -m
bash --noprofile --norc -eo pipefail -c "$1" &
job=$!
( sleep "$2"; kill -KILL -- "-$job" ) >/dev/null 2>&1 &
watchdog=$!
wait "$job" 2>/dev/null
code=$?
kill -KILL -- "-$watchdog" 2>/dev/null
exit "$code"
`;

export async function runShell(
  script: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<ShellResult> {
  const started = performance.now();
  const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const out = await new Deno.Command('bash', {
    args: ['--noprofile', '--norc', '-c', SUPERVISOR, 'sim-step', script, String(seconds)],
    cwd: opts.cwd,
    env: opts.env,
    clearEnv: true,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const ms = Math.round(performance.now() - started);
  // 137 = killed by SIGKILL. Only the watchdog sends it, at the limit.
  const timedOut = out.code === 137 && ms >= opts.timeoutMs - 500;
  return {
    code: timedOut ? null : out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
    timedOut,
    ms,
  };
}
