/**
 * pls init - Bootstrap pls for a new repository.
 */

import { parseArgs } from '@std/cli/parse-args';
import { LocalGit } from '../clients/local-git.ts';
import { detectProject, initWorkflow } from '../workflows/init.ts';
import { PlsError } from '../lib/error.ts';
import * as output from './output.ts';

const HELP = `
${output.bold('pls init')} - Bootstrap pls for a new repository

${output.bold('USAGE:')}
  pls init [OPTIONS]

${output.bold('OPTIONS:')}
  --execute              Actually create files (default is dry-run)
  --version <version>    Override detected version
  --version-file <path>  TypeScript file with VERSION export
  --base <branch>        Base branch (default: main)
  --target <branch>      Target branch for releases (default: main)
  --strategy <type>      Branch strategy: simple or next
  --help                 Show this help

${output.bold('DESCRIPTION:')}
  Initializes pls for a repository by:
  1. Detecting version from deno.json or package.json
  2. Creating .pls/versions.json
  3. Creating initial tag v{version}

${output.bold('EXAMPLES:')}
  pls init                           # Dry run, detect version
  pls init --execute                 # Initialize with detected version
  pls init --version=1.0.0 --execute # Initialize with specific version
  pls init --version-file=src/version.ts --execute
`;

export async function init(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'execute'],
    string: ['version', 'version-file', 'base', 'target', 'strategy'],
  });

  if (parsed.help) {
    output.help(HELP);
    return;
  }

  output.header('📦 pls init');

  const git = new LocalGit();

  // Show detection info
  const project = await detectProject(git);

  if (project.manifest) {
    output.info('Detected', project.manifest);
    if (project.version) {
      output.info('Version', project.version);
    }
    if (project.workspaces.length > 0) {
      output.info('Workspaces', project.workspaces.join(', '));
    }
  } else {
    output.warn('No deno.json or package.json found');
    if (!parsed.version) {
      throw new PlsError(
        'No manifest found. Use --version to specify initial version',
        'NO_MANIFEST',
      );
    }
  }

  console.log();

  // Build config options if any non-default settings
  const config: Record<string, string> = {};
  if (parsed.base && parsed.base !== 'main') {
    config.baseBranch = parsed.base;
  }
  if (parsed.target && parsed.target !== 'main') {
    config.targetBranch = parsed.target;
  }
  if (parsed.strategy && (parsed.strategy === 'simple' || parsed.strategy === 'next')) {
    config.strategy = parsed.strategy;
  }

  // Execute workflow
  const result = await initWorkflow(git, {
    version: parsed.version,
    versionFile: parsed['version-file'],
    config: Object.keys(config).length > 0 ? config : undefined,
    dryRun: !parsed.execute,
  });

  // Output results
  output.info('Version', result.version);
  output.info('Tag', result.tag);

  console.log();
  console.log('Files:');
  for (const file of result.filesCreated) {
    console.log(`  ${output.green('+')} ${file}`);
  }

  if (result.dryRun) {
    output.dryRun();
    console.log('To initialize, run:');
    console.log(`  ${output.cyan('pls init --execute')}`);
  } else {
    console.log();
    output.success('Initialized pls');
    console.log();
    console.log('Next steps:');
    console.log(`  1. ${output.cyan('git add .pls && git commit -m "chore: initialize pls"')}`);
    console.log(`  2. ${output.cyan(`git push && git push origin ${result.tag}`)}`);
    console.log(`  3. ${output.cyan('pls prep --execute')} to create your first release PR`);
  }
}
