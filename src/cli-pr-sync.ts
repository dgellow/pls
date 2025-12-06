import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { Detector, parseOptionsBlock, PRComments, ReleasePullRequest } from './core/mod.ts';
import { PlsError } from './types.ts';

export function printPRSyncHelp(): void {
  console.log(`
${bold('pls pr sync')} - Sync release PR with selected version

${bold('USAGE:')}
  pls pr sync --pr=<number> [OPTIONS]

${bold('OPTIONS:')}
  --pr <number>        PR number to sync (required)
  --execute            Actually sync the PR (default is dry-run)
  --owner <owner>      GitHub repository owner (auto-detected from git remote)
  --repo <repo>        GitHub repository name (auto-detected from git remote)
  --token <token>      GitHub token (or set GITHUB_TOKEN env var)

${bold('DESCRIPTION:')}
  Reads the selected version from the PR description and syncs the branch.
  If the selection has changed, it will:
  1. Reset the release branch to the base branch
  2. Create a fresh commit with the new version
  3. Force-push the branch
  4. Update the PR title and description
  5. Post a comment noting the change

${bold('EXAMPLES:')}
  # Dry run - see what would happen
  pls pr sync --pr=123

  # Sync the PR
  pls pr sync --pr=123 --execute
`);
}

export async function handlePRSync(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'execute'],
    string: ['pr', 'owner', 'repo', 'token'],
  });

  if (parsed.help) {
    printPRSyncHelp();
    return;
  }

  if (!parsed.pr) {
    console.error(`${red('Error:')} --pr is required`);
    console.error(`Run 'pls pr sync --help' for usage`);
    Deno.exit(1);
  }

  const prNumber = parseInt(parsed.pr, 10);
  if (isNaN(prNumber)) {
    console.error(`${red('Error:')} Invalid PR number: ${parsed.pr}`);
    Deno.exit(1);
  }

  try {
    console.log(bold('pls pr sync\n'));

    const detector = new Detector();
    let repoInfo = { owner: parsed.owner, repo: parsed.repo };

    // Auto-detect GitHub repo
    if (!repoInfo.owner || !repoInfo.repo) {
      const detected = await detector.getRepoInfo();
      if (detected) {
        repoInfo = {
          owner: repoInfo.owner || detected.owner,
          repo: repoInfo.repo || detected.repo,
        };
        console.log(`Repository: ${cyan(`${repoInfo.owner}/${repoInfo.repo}`)}`);
      } else {
        console.error(`${red('Error:')} Could not detect repository. Use --owner and --repo`);
        Deno.exit(1);
      }
    }

    console.log(`PR: ${cyan(`#${prNumber}`)}`);

    // Initialize PR client
    const prClient = new ReleasePullRequest({
      owner: repoInfo.owner!,
      repo: repoInfo.repo!,
      token: parsed.token,
    });

    // Get PR details
    const pr = await prClient.getPR(prNumber);
    console.log(`Title: ${cyan(pr.title)}`);
    console.log(`Branch: ${cyan(pr.head.ref)}`);

    // Parse options block to get selected version and type
    const parsedOptions = parseOptionsBlock(pr.body || '');
    if (!parsedOptions || !parsedOptions.selected) {
      console.error(`${red('Error:')} Could not find selected version in PR description`);
      console.error(`The PR may not have been created by pls, or the options block is missing`);
      Deno.exit(1);
    }

    const selectedOption = parsedOptions.selected;
    const selectedVersion = selectedOption.version;
    const bumpType = selectedOption.type;

    console.log(`Selected version: ${green(selectedVersion)} (${bumpType})`);

    // Extract current version from PR title to check if sync is needed
    const titleVersionMatch = pr.title.match(/v(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/i);
    const currentTitleVersion = titleVersionMatch ? titleVersionMatch[1] : null;

    if (currentTitleVersion === selectedVersion) {
      console.log(yellow('\nNo change detected - PR is already synced to selected version'));
      return;
    }

    console.log(`Current PR version: ${cyan(currentTitleVersion || 'unknown')}`);

    // Get the base version from deno.json on base branch
    const fromVersion = await prClient.getBaseVersion(pr.base.ref);
    console.log(`Base version: ${cyan(fromVersion)}`);

    const isDryRun = !parsed.execute;

    if (isDryRun) {
      console.log(yellow('\nDRY RUN (use --execute to sync)\n'));
      console.log(`Would sync PR #${prNumber} to version ${selectedVersion}`);
      console.log(`  - Reset branch ${pr.head.ref} to ${pr.base.ref}`);
      console.log(`  - Create release commit for ${selectedVersion}`);
      console.log(`  - Force-push branch`);
      console.log(`  - Update PR title to: chore: release v${selectedVersion}`);
      return;
    }

    // Sync the branch
    console.log(`\nSyncing branch...`);
    await prClient.syncBranch(
      prNumber,
      selectedVersion,
      fromVersion,
      bumpType,
    );
    console.log(`Branch synced`);

    // Update PR title and description
    const newTitle = `chore: release v${selectedVersion}`;
    const updatedBody = prClient.updatePRBodySelection(pr.body, selectedVersion);

    await prClient.updatePR(prNumber, newTitle, updatedBody);
    console.log(`PR updated`);

    // Post comment about the change
    if (currentTitleVersion && currentTitleVersion !== selectedVersion) {
      const prComments = new PRComments({
        owner: repoInfo.owner!,
        repo: repoInfo.repo!,
        token: parsed.token,
      });

      await prComments.commentSelectionChanged(prNumber, currentTitleVersion, selectedVersion);
      console.log(`Comment posted`);
    }

    console.log(`\n${green('PR sync complete!')}`);
  } catch (error) {
    if (error instanceof PlsError) {
      console.error(`\n${red('Error:')} ${error.message}`);
      if (error.details) {
        console.error(`${red('Details:')}`, error.details);
      }
    } else {
      console.error(`\n${red('Unexpected error:')}`, error);
    }
    Deno.exit(1);
  }
}
