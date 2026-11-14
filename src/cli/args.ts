/**
 * Argument checks shared by the commands.
 *
 * A mistyped command or option must stop the run. Left alone, the parser drops
 * what it does not know, and `pls relase --execute` makes a local release.
 */

import { PlsError } from '../lib/error.ts';

/** The subcommands. Without one, `pls` makes a local release. */
export const COMMANDS = ['init', 'prep', 'sync', 'release', 'transition'] as const;

/**
 * The `unknown` callback for parseArgs. An option the command does not define
 * is an error. Positional arguments are kept, for checkPositionals.
 *
 * @param command the command as the user types it, e.g. "pls prep"
 */
export function rejectUnknownOptions(command: string): (arg: string, key?: string) => boolean {
  return (arg: string, key?: string): boolean => {
    if (key === undefined || key === null) return true;

    throw new PlsError(
      `Unknown option "${arg}" for \`${command}\`. ` +
        `Run \`${command} --help\` to see the options it takes.`,
      'UNKNOWN_OPTION',
    );
  };
}

/**
 * Refuse positional arguments the command does not take.
 *
 * @param command the command as the user types it, e.g. "pls prep"
 * @param positionals what parseArgs collected in `_`
 * @param allowed how many positional arguments the command takes
 */
export function checkPositionals(
  command: string,
  positionals: (string | number)[],
  allowed: number,
): void {
  if (positionals.length <= allowed) return;

  const extra = String(positionals[allowed]);

  // For plain `pls`, the first word is where a command goes.
  if (command === 'pls') {
    throw new PlsError(
      `Unknown command "${extra}". The commands are ${COMMANDS.join(', ')}; ` +
        `without a command, pls makes a local release. Run \`pls --help\` for the details.`,
      'UNKNOWN_COMMAND',
    );
  }

  throw new PlsError(
    `Unexpected argument "${extra}" for \`${command}\`. ` +
      `Run \`${command} --help\` to see what it takes.`,
    'UNEXPECTED_ARGUMENT',
  );
}
