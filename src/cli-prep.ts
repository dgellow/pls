import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { createStorage } from './storage/mod.ts';
import {
  Detector,
  parseOptionsBlock,
  PRComments,
  ReleaseManager,
  ReleasePullRequest,
  Version,
} from './core/mod.ts';
import { PlsError } from './types.ts';
import {
  getSha as getShaFromManifest,
  getVersion as getVersionFromManifest,
  hasVersionsManifest,
} from './versions/mod.ts';
import type { Release } from './types.ts';

export function printPrepHelp(): void {
  console.log(`
${bold('pls prep')} - Prepare a release (create/update PR)

${bold('USAGE:')}
  pls prep [OPTIONS]

${bold('OPTIONS:')}
  --execute            Actually create/update (default is dry-run)
  --github-pr <num>    Target a specific GitHub PR (for webhook triggers)
  --base <branch>      Base branch (default: main)
  --owner <owner>      GitHub repository owner (auto-detected from git remote)
  --repo <repo>        GitHub repository name (auto-detected from git remote)
  --token <token>      GitHub token (or set GITHUB_TOKEN env var)

${bold('DESCRIPTION:')}
  Creates or updates a release PR. If a PR exists, preserves the user's
  version selection from the PR description.

  With --github-pr=N: Targets a specific PR (used by webhook triggers).
  Will no-op if the PR's selection matches its current version.

${bold('EXAMPLES:')}
  # Dry run - see what would happen
  pls prep

  # Create/update release PR
  pls prep --execute

  # Sync a specific PR (triggered by PR edit webhook)
  pls prep --github-pr=123 --execute
`);
}

export async function handlePrep(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'execute'],
    string: ['base', 'owner', 'repo', 'token', 'github-pr'],
    default: {
      base: 'main',
    },
  });

  if (parsed.help) {
    printPrepHelp();
    return;
  }

  // Parse PR number if provided
  const githubPrNumber = parsed['github-pr'] ? parseInt(parsed['github-pr'], 10) : null;
  if (parsed['github-pr'] && (isNaN(githubPrNumber!) || githubPrNumber! <= 0)) {
    console.error(`${red('Error:')} Invalid PR number: ${parsed['github-pr']}`);
    Deno.exit(1);
  }

  try {
    console.log(bold('pls prep\n'));

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

    await handleCreateOrUpdate(
      detector,
      repoInfo.owner!,
      repoInfo.repo!,
      parsed.base,
      parsed.token,
      !parsed.execute,
      githubPrNumber,
    );
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
 * Handle create/update mode: create a new PR or update an existing one.
 * When targetPrNumber is provided, verify it matches and check for no-op.
 */
async function handleCreateOrUpdate(
  detector: Detector,
  owner: string,
  repo: string,
  baseBranch: string,
  token: string | undefined,
  isDryRun: boolean,
  targetPrNumber?: number | null,
): Promise<void> {
  // Get current version and SHA - priority: .pls/versions.json > GitHub releases > deno.json
  let currentVersion: string | null = null;
  let lastRelease: Release | null = null;

  // Try .pls/versions.json first (includes SHA for accurate commit range)
  if (await hasVersionsManifest()) {
    currentVersion = await getVersionFromManifest();
    const manifestSha = await getShaFromManifest();
    if (currentVersion) {
      console.log(`Current version (from .pls/versions.json): ${cyan(currentVersion)}`);
      if (manifestSha) {
        // Validate SHA exists in repo (may be stale after squash/rebase merge)
        const shaIsValid = await detector.shaExists(manifestSha);
        if (shaIsValid) {
          // Create synthetic release for change detection
          lastRelease = {
            version: currentVersion,
            tag: `v${currentVersion}`,
            sha: manifestSha,
            createdAt: new Date(),
          };
          console.log(`Last release SHA: ${cyan(manifestSha.substring(0, 7))}`);
        } else {
          console.log(
            yellow(
              `SHA ${manifestSha.substring(0, 7)} not found in repo (may be stale after merge)`,
            ),
          );
          console.log(`Will fall back to GitHub releases for commit range`);
        }
      }
    }
  }

  // Fall back to GitHub releases
  const storage = createStorage('github', {
    owner,
    repo,
    token,
  });

  if (!lastRelease) {
    lastRelease = await storage.getLastRelease();
    if (lastRelease) {
      if (!currentVersion) {
        currentVersion = lastRelease.version;
      }
      console.log(`Current version (from GitHub): ${cyan(lastRelease.tag)}`);
    }
  }

  // Fall back to deno.json/package.json
  if (!currentVersion) {
    const version = new Version();
    currentVersion = await version.getCurrentVersion();
    if (currentVersion) {
      console.log(`Current version (from manifest): ${cyan(currentVersion)}`);
    } else {
      currentVersion = '0.0.0';
      console.log(`No version found, starting from ${cyan('0.0.0')}`);
    }
  }

  // Detect changes since last release
  console.log(`\nDetecting changes...`);
  const changes = await detector.detectChanges(lastRelease);

  if (!changes.hasChanges) {
    console.log(yellow('No changes detected since last release'));
    return;
  }

  console.log(`Found ${green(String(changes.commits.length))} commits`);

  // Determine version bump
  const version = new Version();
  const bump = await version.determineVersionBump(currentVersion, changes.commits);

  if (!bump) {
    console.log(yellow('No version bump needed'));
    return;
  }

  console.log(`Version bump: ${cyan(bump.from)} -> ${green(bump.to)} (${bump.type})`);

  // Generate changelog
  const releaseManager = new ReleaseManager(storage);
  const changelog = releaseManager.generateReleaseNotes(bump);

  // Create PR client
  const pr = new ReleasePullRequest({
    owner,
    repo,
    token,
    baseBranch,
  });

  // If targeting a specific PR, verify it exists and check for no-op
  let oldVersion: string | null = null;
  let newVersion: string | null = null;

  if (targetPrNumber) {
    const existingPR = await pr.getPR(targetPrNumber);
    console.log(`Target PR: ${cyan(`#${targetPrNumber}`)} - ${existingPR.title}`);

    // Parse selection from PR body
    const parsed = parseOptionsBlock(existingPR.body || '');
    if (parsed?.selected) {
      newVersion = parsed.selected.version;

      // Check if PR is already synced to selected version
      const titleVersionMatch = existingPR.title.match(/v(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/i);
      oldVersion = titleVersionMatch ? titleVersionMatch[1] : null;

      if (oldVersion === newVersion) {
        console.log(yellow('\nNo change detected - PR is already synced to selected version'));
        return;
      }

      console.log(`Selection changed: ${cyan(oldVersion || 'unknown')} -> ${green(newVersion)}`);
    }
  }

  // Create or update PR
  if (isDryRun) {
    console.log(yellow('\nDRY RUN (use --execute to create PR)\n'));
  }

  const result = await pr.createOrUpdate(bump, changelog, isDryRun);

  if (!isDryRun && result.url) {
    console.log(`\nRelease PR ready: ${green(result.url)}`);

    // Post comment if this was a sync (selection changed)
    if (targetPrNumber && oldVersion && newVersion && oldVersion !== newVersion) {
      const prComments = new PRComments({ owner, repo, token });
      await prComments.commentSelectionChanged(targetPrNumber, oldVersion, newVersion);
      console.log(`Comment posted`);
    }
  }
}
