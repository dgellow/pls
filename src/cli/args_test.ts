import { assertEquals, assertThrows } from '@std/assert';
import { parseArgs } from '@std/cli/parse-args';
import { PlsError } from '../lib/error.ts';
import { checkPositionals, rejectUnknownOptions } from './args.ts';

function parse(args: string[]): { _: (string | number)[]; execute: boolean; base?: string } {
  return parseArgs(args, {
    boolean: ['execute'],
    string: ['base'],
    unknown: rejectUnknownOptions('pls prep'),
  });
}

Deno.test('rejectUnknownOptions', async (t) => {
  await t.step('lets the options of the command through', () => {
    const parsed = parse(['--execute', '--base=next']);
    assertEquals(parsed.execute, true);
    assertEquals(parsed.base, 'next');
  });

  await t.step('refuses an option the command does not define', () => {
    for (const arg of ['--exceute', '--base-branch=next', '-x', '--no-execute']) {
      const error = assertThrows(() => parse([arg]), PlsError);
      assertEquals(error.code, 'UNKNOWN_OPTION', arg);
      assertEquals(error.message.includes(`"${arg}"`), true, error.message);
      assertEquals(error.message.includes('`pls prep --help`'), true, error.message);
    }
  });

  await t.step('keeps positional arguments for checkPositionals', () => {
    assertEquals(parse(['extra', '--execute'])._, ['extra']);
  });
});

Deno.test('checkPositionals', async (t) => {
  await t.step('accepts as many arguments as the command takes', () => {
    checkPositionals('pls prep', [], 0);
    checkPositionals('pls transition', ['beta'], 1);
  });

  await t.step('names the first argument that is too many', () => {
    const error = assertThrows(
      () => checkPositionals('pls transition', ['beta', 'rc'], 1),
      PlsError,
    );
    assertEquals(error.code, 'UNEXPECTED_ARGUMENT');
    assertEquals(error.message.includes('"rc"'), true, error.message);
    assertEquals(error.message.includes('`pls transition --help`'), true, error.message);
  });

  await t.step('calls a stray word after plain `pls` an unknown command', () => {
    const error = assertThrows(() => checkPositionals('pls', ['relase'], 0), PlsError);
    assertEquals(error.code, 'UNKNOWN_COMMAND');
    assertEquals(error.message.includes('"relase"'), true, error.message);
    assertEquals(
      error.message.includes('init, prep, sync, release, transition'),
      true,
      error.message,
    );
  });

  await t.step('covers arguments after --, which never reach the unknown callback', () => {
    const parsed = parse(['--', '--execute']);
    assertThrows(() => checkPositionals('pls prep', parsed._, 0), PlsError);
  });
});
