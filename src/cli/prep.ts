/**
 * pls prep - Prepare a release PR.
 */

import { parseArgs } from '@std/cli/parse-args';
import { LocalGit } from '../clients/local-git.ts';
import { GitHub } from '../clients/github.ts';
import { prepWorkflow } from '../workflows/pr-create.ts';
import { PlsError } from '../lib/error.ts';
import * as output from './output.ts';

const HELP = `
${output.bold('pls prep')} - Prepare a release PR

${output.bold('USAGE:')}
  pls prep [OPTIONS]

${output.bold('OPTIONS:')}
  --execute             Actually create/update (default is dry-run)
  --base <branch>       Base branch (default: main)
  --owner <owner>       GitHub repository owner
  --repo <repo>         GitHub repository name
  --token <token>       GitHub token (or set GITHUB_TOKEN)
  --json-output <path>  Write structured JSON result to file
  --help                Show this help

${output.bold('EXAMPLES:')}
  pls prep                    # Dry run
  pls prep --execute          # Create/update PR
`;

export async function prep(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'execute'],
    string: ['base', 'owner', 'repo', 'token', 'json-output'],
    default: {
      base: 'main',
    },
  });

  if (parsed.help) {
    output.help(HELP);
    return;
  }

  output.header('📦 pls prep');

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
  output.info('Base branch', parsed.base);

  // Create GitHub client
  const token = parsed.token || Deno.env.get('GITHUB_TOKEN') || '';
  const github = new GitHub({ owner, repo, token });

  // Execute workflow
  const result = await prepWorkflow(git, github, {
    baseBranch: parsed.base,
    releaseBranch: 'pls-release',
    dryRun: !parsed.execute,
  });

  // Write JSON output if requested
  if (parsed['json-output']) {
    await output.writeJsonOutput(parsed['json-output'], result);
  }

  // Output results
  if (result.bootstrap) {
    // Bootstrap output
    console.log();
    console.log(output.yellow('No .pls/versions.json found.'));
    console.log();
    console.log('Detecting project version...');
    output.info('Found', `${result.bootstrapVersion}`);
    console.log();

    if (result.dryRun) {
      output.dryRun();
      console.log('Would create bootstrap PR:');
      console.log(`  - Add .pls/versions.json (version: ${result.bootstrapVersion})`);
    } else if (result.pr) {
      console.log('Creating bootstrap PR...');
      console.log(`  - Add .pls/versions.json (version: ${result.bootstrapVersion})`);
      console.log();
      output.success(`Bootstrap PR: ${result.pr.url}`);
      console.log();
      console.log('Merge this PR to initialize pls, then releases will work automatically.');
    }
    return;
  }

  // Regular prep output
  if (!result.bump) {
    output.warn('No changes to release');
    return;
  }

  output.versionBump(result.bump.from, result.bump.to, result.bump.type);
  output.commits(result.bump.commits.length);

  if (result.dryRun) {
    output.dryRun();
    console.log(`Would create PR: ${output.cyan(`chore: release v${result.bump.to}`)}`);
  } else if (result.pr) {
    output.pr(result.pr.url);
  }
}
