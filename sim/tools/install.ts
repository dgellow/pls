/** Shared helpers for tool adapters: locations and subprocess execution. */

export const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
/** Tool installations and build outputs. Not committed. */
export const cacheDir = `${repoRoot}/sim/.cache`;

export async function run(
  cwd: string,
  argv: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const out = await new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd,
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  if (out.code !== 0) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`${argv.join(' ')} failed (${out.code})\n${stdout}\n${stderr}`);
  }
  return stdout;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
