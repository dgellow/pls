/**
 * Runtime access: process, environment, files and subprocesses.
 *
 * This is the only module in src/ (tests aside) that touches the runtime. It
 * is written against node: APIs, which Deno, Node and Bun all provide, so the
 * rest of pls does not depend on the runtime it runs on.
 *
 * One call is runtime-specific: on Deno, programs are started with
 * Deno.Command (see runCommand).
 */

import process from 'node:process';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

/** Command-line arguments, without the executable and the script. */
export function args(): string[] {
  return process.argv.slice(2);
}

/** Value of an environment variable, or undefined when it is not set. */
export function env(name: string): string | undefined {
  return process.env[name];
}

/** Current working directory. */
export function cwd(): string {
  return process.cwd();
}

/** End the process with the given exit code. */
export function exit(code: number): never {
  process.exit(code);
}

/** Read a file as UTF-8 text. Rejects when the file cannot be read. */
export function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/** Write UTF-8 text to a file, replacing its content. The directory must exist. */
export function writeTextFile(path: string, content: string): Promise<void> {
  return writeFile(path, content, 'utf8');
}

/** Create a directory and its parents. Does nothing when it already exists. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Whether a file or directory exists at the path. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface CommandResult {
  /** Exit code. 1 when the process was ended by a signal. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
}

/**
 * Run a program and collect its output. No shell is involved: the arguments
 * are passed as given. Rejects when the program cannot be started (for
 * example when it is not installed, or pls may not run it); a non-zero exit
 * code is not an error.
 *
 * On Deno this uses Deno.Command. Deno's version of node:child_process needs
 * unrestricted --allow-env, so with it a run that grants only the variables
 * pls reads (--allow-env=GITHUB_TOKEN --allow-run=git) could not start git.
 */
export function runCommand(
  program: string,
  commandArgs: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const deno = (globalThis as { Deno?: typeof Deno }).Deno;
  return deno
    ? runCommandWithDeno(deno, program, commandArgs, options)
    : runCommandWithNode(program, commandArgs, options);
}

async function runCommandWithDeno(
  deno: typeof Deno,
  program: string,
  commandArgs: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const { code, stdout, stderr } = await new deno.Command(program, {
    args: commandArgs,
    cwd: options.cwd,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/**
 * runCommand for runtimes other than Deno. Exported so the tests can run it
 * on Deno as well.
 */
export function runCommandWithNode(
  program: string,
  commandArgs: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));

    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolve({
        code: code ?? 1,
        stdout: decode(stdout),
        stderr: decode(stderr),
      });
    });
  });
}

function decode(chunks: Uint8Array[]): string {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
