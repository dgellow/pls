import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { Detector, getSelectedVersion, PRComments, ReleasePullRequest } from './core/mod.ts';
import { PlsError } from './types.ts';
import { getVersion as getVersionFromManifest, hasVersionsManifest } from './versions/mod.ts';

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

    // Parse selected version from PR body
    const selectedVersion = getSelectedVersion(pr.body || '');
    if (!selectedVersion) {
      console.error(`${red('Error:')} Could not find selected version in PR description`);
      console.error(`The PR may not have been created by pls, or the options block is missing`);
      Deno.exit(1);
    }

    console.log(`Selected version: ${green(selectedVersion)}`);

    // Get current version to determine the "from" version
    let currentVersion: string | null = null;
    if (await hasVersionsManifest()) {
      currentVersion = await getVersionFromManifest();
    }
    if (!currentVersion) {
      // Try to extract from PR title
      const titleMatch = pr.title.match(/v?(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/i);
      if (titleMatch) {
        // This is the "to" version, we need to find "from"
        // For now, use a simple approach - get from deno.json on base branch
        currentVersion = '0.0.0'; // Fallback
      }
    }

    // Determine bump type from version
    const bumpType = determineBumpType(currentVersion || '0.0.0', selectedVersion);
    console.log(`Bump type: ${cyan(bumpType)}`);

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
      currentVersion || '0.0.0',
      bumpType,
    );
    console.log(`Branch synced`);

    // Update PR title and description
    const newTitle = `chore: release v${selectedVersion}`;
    const updatedBody = prClient.updatePRBodySelection(pr.body, selectedVersion);

    await prClient.updatePR(prNumber, newTitle, updatedBody);
    console.log(`PR updated`);

    // Post comment about the change
    const prComments = new PRComments({
      owner: repoInfo.owner!,
      repo: repoInfo.repo!,
      token: parsed.token,
    });

    // Extract old version from title
    const oldVersionMatch = pr.title.match(/v?(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/i);
    const oldVersion = oldVersionMatch ? oldVersionMatch[1] : 'unknown';

    if (oldVersion !== selectedVersion) {
      await prComments.commentSelectionChanged(prNumber, oldVersion, selectedVersion);
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

/**
 * Determine bump type from version strings.
 */
function determineBumpType(
  from: string,
  to: string,
): 'major' | 'minor' | 'patch' | 'transition' {
  // If "to" is a prerelease, it's a transition
  if (to.includes('-alpha') || to.includes('-beta') || to.includes('-rc')) {
    return 'transition';
  }

  // Compare version parts
  const fromParts = from.split('-')[0].split('.').map(Number);
  const toParts = to.split('-')[0].split('.').map(Number);

  if (toParts[0] > fromParts[0]) return 'major';
  if (toParts[1] > fromParts[1]) return 'minor';
  return 'patch';
}
