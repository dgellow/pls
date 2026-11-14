/**
 * CLI output formatting.
 *
 * Consistent, scannable output with prefixes.
 */

import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { dirname } from '@std/path';
import { PlsError } from '../lib/error.ts';
import * as runtime from '../lib/runtime.ts';

export { bold, cyan, green, red, yellow };

/**
 * Print section header.
 */
export function header(text: string): void {
  console.log(bold(text));
  console.log();
}

/**
 * Print info line.
 */
export function info(label: string, value: string): void {
  console.log(`${label}: ${cyan(value)}`);
}

/**
 * Print success message.
 */
export function success(message: string): void {
  console.log(green(`✅ ${message}`));
}

/**
 * Print warning message.
 */
export function warn(message: string): void {
  console.log(yellow(`⚠️  ${message}`));
}

/**
 * Print error message.
 */
export function error(message: string, details?: string): void {
  console.error(red(`❌ ${message}`));
  if (details) {
    console.error(red(`   ${details}`));
  }
}

/**
 * Print dry run notice.
 */
export function dryRun(): void {
  console.log();
  console.log(yellow('DRY RUN — use --execute to apply changes'));
  console.log();
}

/**
 * Print version bump.
 */
export function versionBump(from: string, to: string, type: string): void {
  console.log(`Version: ${cyan(from)} → ${green(to)} (${type})`);
}

/**
 * Print file changes.
 */
export function fileChanges(files: Map<string, string>): void {
  console.log();
  console.log('Files to update:');
  for (const [path] of files) {
    console.log(`  ${cyan(path)}`);
  }
}

/**
 * Print commits.
 */
export function commits(count: number): void {
  console.log(`Commits: ${green(String(count))}`);
}

/**
 * Print PR info.
 */
export function pr(url: string): void {
  console.log();
  success(`Release PR: ${url}`);
}

/**
 * Print release info.
 */
export function release(tag: string, url?: string | null): void {
  console.log();
  success(`Released ${tag}`);
  if (url) {
    console.log(`   ${url}`);
  }
}

/**
 * Print help text.
 */
export function help(text: string): void {
  console.log(text);
}

/**
 * Write structured JSON output to a file.
 */
export async function writeJsonOutput(
  path: string,
  data: unknown,
): Promise<void> {
  try {
    // The directory may not exist yet: a CI step often names a fresh one.
    await runtime.ensureDir(dirname(path));
    await runtime.writeTextFile(path, JSON.stringify(data, null, 2) + '\n');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PlsError(
      `Could not write the JSON result to "${path}": ${reason}\n` +
        `The command itself has finished: what it did is done, and only this file is missing. ` +
        `Check that the path can be written.`,
      'JSON_OUTPUT_FAILED',
    );
  }
}
