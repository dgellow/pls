/**
 * pls sync - Sync PR after version selection change.
 */

import { parseArgs } from '@std/cli/parse-args';
import { LocalGit } from '../clients/local-git.ts';
import { GitHub } from '../clients/github.ts';
import { syncWorkflow } from '../workflows/pr-sync.ts';
import { PlsError } from '../lib/error.ts';
import * as output from './output.ts';

const HELP = `
${output.bold('pls sync')} - Sync PR after version selection change

${output.bold('USAGE:')}
  pls sync --pr <number> [OPTIONS]

${output.bold('OPTIONS:')}
  --pr <number>         PR number to sync (required)
  --base <branch>       Base branch (default: main)
  --owner <owner>       GitHub repository owner
  --repo <repo>         GitHub repository name
  --token <token>       GitHub token (or set GITHUB_TOKEN)
  --json-output <path>  Write structured JSON result to file
  --help                Show this help

${output.bold('EXAMPLES:')}
  pls sync --pr=42            # Sync PR #42
`;

export async function sync(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help'],
    string: ['pr', 'base', 'owner', 'repo', 'token', 'json-output'],
    default: {
      base: 'main',
    },
  });

  if (parsed.help) {
    output.help(HELP);
    return;
  }

  if (!parsed.pr) {
    throw new PlsError(
      'PR number required. Use --pr=<number>',
      'NO_PR_NUMBER',
    );
  }

  const prNumber = parseInt(parsed.pr, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    throw new PlsError(
      `Invalid PR number: ${parsed.pr}`,
      'INVALID_PR_NUMBER',
    );
  }

  output.header('📦 pls sync');

  // Get repo info
  const git = new LocalGit();
  let owner = parsed.owner;
  let repo = parsed.repo;

  if (!owner || !repo) {
    const remoteInfo = await git.getRemoteInfo();
    if (remoteInfo) {
      owner = owner || remoteInfo.owner;
      repo = repo || remoteInfo.repo;
    }
  }

  if (!owner || !repo) {
    throw new PlsError(
      'Could not detect repository. Use --owner and --repo',
      'NO_REPO_INFO',
    );
  }

  output.info('Repository', `${owner}/${repo}`);
  output.info('PR', `#${prNumber}`);

  // Create GitHub client
  const token = parsed.token || Deno.env.get('GITHUB_TOKEN') || '';
  const github = new GitHub({ owner, repo, token });

  // Execute workflow
  const result = await syncWorkflow(github, {
    prNumber,
    baseBranch: parsed.base,
  });

  // Write JSON output if requested
  if (parsed['json-output']) {
    await output.writeJsonOutput(parsed['json-output'], result);
  }

  // Output results
  if (!result.synced) {
    if (result.oldVersion === result.newVersion) {
      output.warn('PR already synced to selected version');
    } else {
      output.warn('No version selection found');
    }
    return;
  }

  output.success(`Synced: ${result.oldVersion} → ${result.newVersion}`);
}
