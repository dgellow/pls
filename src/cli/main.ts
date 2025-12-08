#!/usr/bin/env -S deno run -A

/**
 * pls - Release automation CLI
 *
 * Commands:
 *   pls              Local release (dry-run by default)
 *   pls prep         Prepare release PR
 *   pls sync         Sync PR after selection change
 *   pls release      Create tag and GitHub Release
 *   pls transition   Transition between release stages
 */

import { parseArgs } from '@std/cli/parse-args';
import { prep } from './prep.ts';
import { sync } from './sync.ts';
import { release } from './release.ts';
import { LocalGit } from '../clients/local-git.ts';
import { localReleaseWorkflow, transitionWorkflow } from '../workflows/local-release.ts';
import { PlsError } from '../lib/error.ts';
import { VERSION } from '../version_info.ts';
import * as output from './output.ts';

const HELP = `
${output.bold('pls')} - Release automation tool

${output.bold('USAGE:')}
  pls [OPTIONS]              Local release
  pls prep [OPTIONS]         Prepare release PR
  pls sync [OPTIONS]         Sync PR after selection change
  pls release [OPTIONS]      Create tag and GitHub Release
  pls transition <target>    Transition between stages

${output.bold('OPTIONS:')}
  --execute          Actually apply changes (default is dry-run)
  --push             Push after local release
  --help             Show this help
  --version          Show version

${output.bold('TRANSITION TARGETS:')}
  alpha, beta, rc, stable

${output.bold('EXAMPLES:')}
  pls                        # Dry run local release
  pls --execute              # Create local release
  pls prep --execute         # Create release PR
  pls transition beta        # Transition to beta
`;

async function main(): Promise<void> {
  const args = Deno.args;

  // Route to subcommands
  if (args[0] === 'prep') {
    await prep(args.slice(1));
    return;
  }

  if (args[0] === 'sync') {
    await sync(args.slice(1));
    return;
  }

  if (args[0] === 'release') {
    await release(args.slice(1));
    return;
  }

  if (args[0] === 'transition') {
    await handleTransition(args.slice(1));
    return;
  }

  // Default: local release
  await handleLocalRelease(args);
}

async function handleLocalRelease(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'version', 'execute', 'push'],
  });

  if (parsed.help) {
    output.help(HELP);
    return;
  }

  if (parsed.version) {
    console.log(`pls v${VERSION}`);
    return;
  }

  output.header('📦 pls');

  const git = new LocalGit();

  const result = await localReleaseWorkflow(git, {
    dryRun: !parsed.execute,
    push: parsed.push,
  });

  if (!result.bump) {
    output.warn('No changes to release');
    return;
  }

  output.versionBump(result.bump.from, result.bump.to, result.bump.type);
  output.commits(result.bump.commits.length);

  if (result.dryRun) {
    output.dryRun();
  } else {
    output.release(result.tag!);
    if (parsed.push) {
      console.log('   (pushed to remote)');
    }
  }
}

async function handleTransition(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'execute', 'push', 'major', 'minor', 'patch'],
  });

  if (parsed.help || parsed._.length === 0) {
    console.log(`
${output.bold('pls transition')} - Transition between release stages

${output.bold('USAGE:')}
  pls transition <target> [OPTIONS]

${output.bold('TARGETS:')}
  alpha              Start alpha cycle
  beta               Transition to beta
  rc                 Transition to release candidate
  stable             Graduate to stable release

${output.bold('OPTIONS:')}
  --execute          Actually apply changes
  --push             Push after transition
  --major            Major version bump when starting cycle
  --minor            Minor version bump when starting cycle (default)
  --patch            Patch version bump when starting cycle

${output.bold('EXAMPLES:')}
  pls transition alpha --execute       # 1.2.3 → 1.3.0-alpha.0
  pls transition beta --execute        # 1.3.0-alpha.5 → 1.3.0-beta.0
  pls transition stable --execute      # 1.3.0-rc.2 → 1.3.0
`);
    return;
  }

  const target = String(parsed._[0]);
  if (!['alpha', 'beta', 'rc', 'stable'].includes(target)) {
    throw new PlsError(
      `Invalid target: ${target}. Use alpha, beta, rc, or stable`,
      'INVALID_TARGET',
    );
  }

  // Determine bump type
  let bumpType: 'major' | 'minor' | 'patch' = 'minor';
  if (parsed.major) bumpType = 'major';
  if (parsed.patch) bumpType = 'patch';

  output.header('📦 pls transition');

  const git = new LocalGit();

  const result = await transitionWorkflow(
    git,
    target as 'alpha' | 'beta' | 'rc' | 'stable',
    bumpType,
    {
      dryRun: !parsed.execute,
      push: parsed.push,
    },
  );

  output.info('Target', target);
  output.versionBump(result.bump!.from, result.bump!.to, 'transition');

  if (result.dryRun) {
    output.dryRun();
  } else {
    output.release(result.tag!);
    if (parsed.push) {
      console.log('   (pushed to remote)');
    }
  }
}

// Error handling wrapper
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof PlsError) {
      output.error(error.message);
      if (error.details) {
        console.error(output.red('Details:'), error.details);
      }
    } else {
      output.error('Unexpected error', String(error));
    }
    Deno.exit(1);
  }
}
