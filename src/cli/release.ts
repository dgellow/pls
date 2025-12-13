/**
 * pls release - Create tag and GitHub Release.
 */

import { parseArgs } from '@std/cli/parse-args';
import { LocalGit } from '../clients/local-git.ts';
import { GitHub } from '../clients/github.ts';
import { releaseWorkflow } from '../workflows/pr-release.ts';
import { loadConfig } from '../domain/config.ts';
import { PlsError } from '../lib/error.ts';
import * as output from './output.ts';

const HELP = `
${output.bold('pls release')} - Create tag and GitHub Release

${output.bold('USAGE:')}
  pls release [OPTIONS]

${output.bold('OPTIONS:')}
  --owner <owner>       GitHub repository owner
  --repo <repo>         GitHub repository name
  --token <token>       GitHub token (or set GITHUB_TOKEN)
  --json-output <path>  Write structured JSON result to file
  --help                Show this help

${output.bold('DESCRIPTION:')}
  Creates annotated tag and GitHub Release for the current version.

  Runs on every push to main for self-healing:
  - If tag exists: no-op (success)
  - If tag missing: creates it (self-heals from previous failure)

  For Strategy B (next branch pattern), also syncs the base branch
  onto the target branch after release.

${output.bold('EXAMPLES:')}
  pls release                 # Create release for current version
`;

export async function release(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help'],
    string: ['owner', 'repo', 'token', 'json-output'],
  });

  if (parsed.help) {
    output.help(HELP);
    return;
  }

  output.header('📦 pls release');

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

  // Load config
  const configContent = await git.readFile('.pls/config.json');
  const config = loadConfig(configContent);

  if (config.strategy === 'next') {
    output.info('Strategy', `${config.baseBranch} → ${config.targetBranch}`);
  }

  // Create GitHub client
  const token = parsed.token || Deno.env.get('GITHUB_TOKEN') || '';
  const github = new GitHub({ owner, repo, token });

  // Execute workflow
  const result = await releaseWorkflow(git, github, { config });

  // Write JSON output if requested
  if (parsed['json-output']) {
    await output.writeJsonOutput(parsed['json-output'], result);
  }

  // Output results
  if (!result.version) {
    output.warn('No version found to release');
    return;
  }

  output.info('Version', result.version);

  if (result.alreadyExists) {
    output.info('Tag', `${result.tag} ✓ (exists)`);
    console.log();
    console.log('Already released. Nothing to do.');

    // Still show branch sync result
    if (config.strategy === 'next') {
      showBranchSyncResult(result.branchSynced, result.branchSyncError, config);
    }
    return;
  }

  if (result.released) {
    if (result.recovered) {
      output.release(result.tag!, result.url);
      console.log(output.yellow('   (recovered from previous failure)'));
    } else {
      output.release(result.tag!, result.url);
    }

    // Show branch sync result for Strategy B
    if (config.strategy === 'next') {
      showBranchSyncResult(result.branchSynced, result.branchSyncError, config);
    }
  }
}

/**
 * Display branch sync result.
 */
function showBranchSyncResult(
  synced: boolean,
  error: string | null,
  config: { baseBranch: string; targetBranch: string },
): void {
  console.log();
  if (synced) {
    console.log(
      output.green(`✓ Synced ${config.baseBranch} onto ${config.targetBranch}`),
    );
  } else if (error) {
    console.log(output.yellow(`⚠️  Branch sync: ${error}`));
  }
}
