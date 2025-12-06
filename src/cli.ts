#!/usr/bin/env -S deno run -A

import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { createStorage } from './storage/mod.ts';
import {
  Detector,
  extractVersionFromCommit,
  parseReleaseMetadata,
  ReleaseManager,
  type ReleaseMetadata,
  Version,
} from './core/mod.ts';
import { PlsError } from './types.ts';
import { handleTransition } from './cli-transition.ts';
import { handlePrep } from './cli-prep.ts';
import { PRComments } from './core/mod.ts';
import denoJson from '../deno.json' with { type: 'json' };

const VERSION = denoJson.version;

/**
 * Get release metadata from the current HEAD commit.
 * Returns structured metadata if available, or extracts version from title as fallback.
 */
async function getReleaseCommitInfo(): Promise<
  {
    version: string;
    metadata: ReleaseMetadata | null;
  } | null
> {
  try {
    const command = new Deno.Command('git', {
      args: ['log', '-1', '--pretty=%B'],
    });
    const { code, stdout } = await command.output();

    if (code !== 0) {
      return null;
    }

    const message = new TextDecoder().decode(stdout).trim();

    // First try to get structured metadata
    const metadata = parseReleaseMetadata(message);
    if (metadata) {
      return { version: metadata.version, metadata };
    }

    // Fall back to extracting version from commit title (backwards compatibility)
    const version = extractVersionFromCommit(message);
    if (version) {
      return { version, metadata: null };
    }

    return null;
  } catch {
    return null;
  }
}

async function cloneToTemp(repoUrl: string): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: 'pls-' });

  console.log(`Cloning ${cyan(repoUrl)}...`);

  const command = new Deno.Command('git', {
    args: ['clone', '--depth', '1', repoUrl, tempDir],
  });

  const { code, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new PlsError(
      `Failed to clone repository: ${error}`,
      'CLONE_ERROR',
    );
  }

  return tempDir;
}

function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  // Handle GitHub URLs (https and ssh)
  const patterns = [
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^git@github\.com:([^\/]+)\/([^\/]+?)(\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
      };
    }
  }

  return null;
}

function printHelp(): void {
  console.log(`
${bold('pls')} - Release automation tool

${bold('USAGE:')}
  pls [REPO_URL] [OPTIONS]
  pls prep [OPTIONS]
  pls transition <TARGET> [OPTIONS]

${bold('COMMANDS:')}
  prep                 Prepare a release (create/update PR or sync selection)
  transition           Transition between release stages (alpha, beta, rc, stable)

${bold('ARGUMENTS:')}
  REPO_URL             Git repository URL to analyze (optional, defaults to current directory)

${bold('OPTIONS:')}
  --storage <type>     Storage backend: local (default) or github
  --tag-strategy <s>   Tag creation: github (API, default) or git (CLI)
  --execute            Actually create the release (default is dry-run)
  --force              Skip safety checks and create release
  --pr <number>        Post comment to this PR on success/failure
  --owner <owner>      GitHub repository owner (auto-detected from git remote)
  --repo <repo>        GitHub repository name (auto-detected from git remote)
  --token <token>      GitHub token (or set GITHUB_TOKEN env var)
  --help               Show this help message
  --version            Show version

${bold('EXAMPLES:')}
  # Dry run (default behavior)
  pls

  # Actually create a release
  pls --execute

  # Create release and comment on PR
  pls --storage=github --execute --pr=123

  # Transition to beta
  pls transition beta --execute

  # Analyze remote repository
  pls https://github.com/owner/repo.git
`);
}

async function main(): Promise<void> {
  // Check for subcommands first
  if (Deno.args.length > 0 && Deno.args[0] === 'prep') {
    await handlePrep(Deno.args.slice(1));
    return;
  }

  if (Deno.args.length > 0 && Deno.args[0] === 'transition') {
    await handleTransition(Deno.args.slice(1));
    return;
  }

  const args = parseArgs(Deno.args, {
    boolean: ['help', 'version', 'execute', 'force'],
    string: ['storage', 'owner', 'repo', 'token', 'tag-strategy', 'pr'],
    default: {
      storage: 'local',
      'tag-strategy': 'github',
    },
  });

  // Parse PR number if provided
  const prNumber = args.pr ? parseInt(args.pr, 10) : null;
  if (args.pr && (isNaN(prNumber!) || prNumber! <= 0)) {
    console.error(`${red('Error:')} Invalid PR number: ${args.pr}`);
    Deno.exit(1);
  }

  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    console.log(`pls v${VERSION}`);
    return;
  }

  // Handle repository URL argument
  const repoUrl = args._[0]?.toString();
  let workingDir = Deno.cwd();
  let tempDir: string | null = null;
  let repoInfo = { owner: args.owner, repo: args.repo };

  if (repoUrl) {
    // Clone remote repository to temp directory
    tempDir = await cloneToTemp(repoUrl);
    workingDir = tempDir;

    // Parse owner/repo from URL if not provided
    const parsed = parseRepoUrl(repoUrl);
    if (parsed) {
      repoInfo = {
        owner: repoInfo.owner || parsed.owner,
        repo: repoInfo.repo || parsed.repo,
      };
    }
  }

  try {
    // Change to working directory
    const originalCwd = Deno.cwd();
    if (workingDir !== originalCwd) {
      Deno.chdir(workingDir);
    }

    console.log(bold('pls\n'));

    // Create detector to get repo info
    const detector = new Detector();

    // Auto-detect GitHub repo if not provided
    if (args.storage === 'github' && (!repoInfo.owner || !repoInfo.repo)) {
      const detected = await detector.getRepoInfo();
      if (detected) {
        repoInfo = {
          owner: repoInfo.owner || detected.owner,
          repo: repoInfo.repo || detected.repo,
        };
        console.log(`Detected repository: ${cyan(`${repoInfo.owner}/${repoInfo.repo}`)}`);
      }
    }

    // Create storage
    const storage = createStorage(args.storage as 'local' | 'github', {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      token: args.token,
    });

    console.log(`Storage: ${cyan(args.storage)}`);

    // Check if the current commit is already a release commit
    // This happens when a release PR is merged - we should just create the tag/release
    // without recalculating the version (which could cause a double bump)
    const releaseCommitInfo = await getReleaseCommitInfo();
    const currentSha = await detector.getCurrentSha();

    if (releaseCommitInfo) {
      const { version: releaseCommitVersion, metadata } = releaseCommitInfo;

      if (metadata) {
        console.log(`Current commit is a release commit (structured metadata)`);
        console.log(
          `  Version: ${cyan(metadata.version)} (from ${metadata.from}, ${metadata.type})`,
        );
      } else {
        console.log(`Current commit is a release commit for v${cyan(releaseCommitVersion)}`);
        console.log(yellow(`  (no structured metadata found, using title fallback)`));
      }

      // Check if release already exists for this version
      const lastRelease = await storage.getLastRelease();
      if (lastRelease?.version === releaseCommitVersion) {
        console.log(yellow(`Release v${releaseCommitVersion} already exists`));
        return;
      }

      // Create release for the version in the commit message
      // This avoids recalculating the version which could cause issues
      const releaseManager = new ReleaseManager(storage);
      const isDryRun = !args.execute;

      // Generate release notes from commits since last release
      let releaseNotes: string | undefined;
      if (lastRelease) {
        const changes = await detector.detectChanges(lastRelease);
        if (changes.hasChanges) {
          const bump = {
            from: lastRelease.version,
            to: releaseCommitVersion,
            type: metadata?.type || 'patch' as const,
            commits: changes.commits,
          };
          releaseNotes = releaseManager.generateReleaseNotes(bump);
        }
      }

      if (isDryRun) {
        console.log(yellow('\nDRY RUN (use --execute to create release)\n'));
      }

      console.log(`\nCreating release: ${green(`v${releaseCommitVersion}`)}`);

      const tagStrategy = args['tag-strategy'] as 'github' | 'git';
      const release = await releaseManager.createReleaseFromCommit(
        releaseCommitVersion,
        currentSha,
        isDryRun,
        tagStrategy,
        releaseNotes,
      );

      if (!isDryRun) {
        console.log(`\nRelease ${green(release.tag)} created successfully!`);
        if (release.url) {
          console.log(release.url);
        }

        // Post comment on PR if requested
        if (prNumber && repoInfo.owner && repoInfo.repo) {
          try {
            const prComments = new PRComments({
              owner: repoInfo.owner,
              repo: repoInfo.repo,
              token: args.token,
            });
            await prComments.commentReleaseSuccess(
              prNumber,
              release.version,
              release.tag,
              release.url,
            );
            console.log(`Posted success comment on PR #${prNumber}`);
          } catch (commentError) {
            console.warn(
              yellow(
                `Warning: Failed to post PR comment: ${
                  commentError instanceof Error ? commentError.message : String(commentError)
                }`,
              ),
            );
          }
        }
      }
      return;
    }

    // Normal flow: detect changes and calculate version bump
    // Get last release
    const lastRelease = await storage.getLastRelease();
    if (lastRelease) {
      console.log(`Last release: ${cyan(lastRelease.tag)} (${lastRelease.sha.substring(0, 7)})`);
    } else {
      console.log(`No previous releases found`);
    }

    // Detect changes
    console.log(`\nDetecting changes...`);
    const changes = await detector.detectChanges(lastRelease);

    if (!changes.hasChanges) {
      console.log(yellow('No changes detected since last release'));
      return;
    }

    console.log(`Found ${green(String(changes.commits.length))} commits`);

    // Determine version bump
    const version = new Version();
    const bump = await version.determineVersionBump(
      lastRelease?.version || null,
      changes.commits,
    );

    if (!bump) {
      console.log(yellow('No version bump needed'));
      return;
    }

    console.log(`\nVersion bump: ${cyan(bump.from)} -> ${green(bump.to)} (${bump.type})`);

    // Create release
    const releaseManager = new ReleaseManager(storage);
    const isDryRun = !args.execute;

    if (isDryRun) {
      console.log(yellow('\nDRY RUN (use --execute to create release)\n'));
    }

    const tagStrategy = args['tag-strategy'] as 'github' | 'git';
    const release = await releaseManager.createRelease(
      bump,
      changes.currentSha,
      isDryRun,
      tagStrategy,
    );

    if (!isDryRun) {
      console.log(`\nRelease ${green(release.tag)} created successfully!`);
      if (release.url) {
        console.log(release.url);
      }

      // Post comment on PR if requested
      if (prNumber && repoInfo.owner && repoInfo.repo) {
        try {
          const prComments = new PRComments({
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            token: args.token,
          });
          await prComments.commentReleaseSuccess(
            prNumber,
            release.version,
            release.tag,
            release.url,
          );
          console.log(`Posted success comment on PR #${prNumber}`);
        } catch (commentError) {
          console.warn(
            yellow(
              `Warning: Failed to post PR comment: ${
                commentError instanceof Error ? commentError.message : String(commentError)
              }`,
            ),
          );
        }
      }
    }

    // Cleanup temp directory
    if (tempDir) {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    const errorMessage = error instanceof PlsError
      ? error.message
      : error instanceof Error
      ? error.message
      : String(error);

    if (error instanceof PlsError) {
      console.error(`\n${red('Error:')} ${error.message}`);
      if (error.details) {
        console.error(`${red('Details:')}`, error.details);
      }
    } else {
      console.error(`\n${red('Unexpected error:')}`, error);
    }

    // Post failure comment on PR if requested
    if (prNumber && repoInfo.owner && repoInfo.repo && args.execute) {
      try {
        const prComments = new PRComments({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          token: args.token,
        });
        await prComments.commentReleaseFailure(
          prNumber,
          'unknown', // Version not available in error context
          errorMessage,
        );
        console.log(`Posted failure comment on PR #${prNumber}`);
      } catch {
        // Ignore comment posting errors during failure handling
      }
    }

    // Cleanup temp directory on error
    if (tempDir) {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
