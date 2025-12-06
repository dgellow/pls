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
import type { VersionBump } from './types.ts';
import { handleTransition } from './cli-transition.ts';
import { handlePR } from './cli-pr.ts';
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

  console.log(`📥 Cloning ${cyan(repoUrl)}...`);

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
  pls pr [OPTIONS]
  pls transition <TARGET> [OPTIONS]

${bold('COMMANDS:')}
  pr                   Create or update a release pull request
  transition           Transition between release stages (alpha, beta, rc, stable)

${bold('ARGUMENTS:')}
  REPO_URL             Git repository URL to analyze (optional, defaults to current directory)

${bold('OPTIONS:')}
  --storage <type>     Storage backend: local (default) or github
  --tag-strategy <s>   Tag creation: github (API, default) or git (CLI)
  --execute            Actually create the release (default is dry-run)
  --force              Skip safety checks and create release
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

  # Transition to beta
  pls transition beta --execute

  # Analyze remote repository
  pls https://github.com/owner/repo.git
`);
}

async function main(): Promise<void> {
  // Check for subcommands first
  if (Deno.args.length > 0 && Deno.args[0] === 'pr') {
    await handlePR(Deno.args.slice(1));
    return;
  }

  if (Deno.args.length > 0 && Deno.args[0] === 'transition') {
    await handleTransition(Deno.args.slice(1));
    return;
  }

  const args = parseArgs(Deno.args, {
    boolean: ['help', 'version', 'execute', 'force'],
    string: ['storage', 'owner', 'repo', 'token', 'tag-strategy'],
    default: {
      storage: 'local',
      'tag-strategy': 'github',
    },
  });

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
        console.log(`📦 Detected repository: ${cyan(`${repoInfo.owner}/${repoInfo.repo}`)}`);
      }
    }

    // Create storage
    const storage = createStorage(args.storage as 'local' | 'github', {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      token: args.token,
    });

    console.log(`💾 Using storage: ${cyan(args.storage)}`);

    // Check if the current commit is already a release commit
    // This happens when a release PR is merged - we should just create the tag/release
    // without recalculating the version (which could cause a double bump)
    const releaseCommitInfo = await getReleaseCommitInfo();
    const currentSha = await detector.getCurrentSha();

    if (releaseCommitInfo) {
      const { version: releaseCommitVersion, metadata } = releaseCommitInfo;

      if (metadata) {
        console.log(`📌 Current commit is a release commit (structured metadata)`);
        console.log(
          `   Version: ${cyan(metadata.version)} (from ${metadata.from}, ${metadata.type})`,
        );
      } else {
        console.log(`📌 Current commit is a release commit for v${cyan(releaseCommitVersion)}`);
        console.log(yellow(`   (no structured metadata found, using title fallback)`));
      }

      // Check if release already exists for this version
      const lastRelease = await storage.getLastRelease();
      if (lastRelease?.version === releaseCommitVersion) {
        console.log(yellow(`ℹ️  Release v${releaseCommitVersion} already exists`));
        return;
      }

      // Create release for the version in the commit message
      // This avoids recalculating the version which could cause issues
      const releaseManager = new ReleaseManager(storage);
      const isDryRun = !args.execute;

      if (isDryRun) {
        console.log(yellow('\n🔍 DRY RUN MODE (use --execute to create release)\n'));
      }

      console.log(`\n📊 Creating release: ${green(`v${releaseCommitVersion}`)}`);

      const tagStrategy = args['tag-strategy'] as 'github' | 'git';
      const release = await releaseManager.createReleaseFromCommit(
        releaseCommitVersion,
        currentSha,
        isDryRun,
        tagStrategy,
      );

      if (!isDryRun) {
        console.log(`\n✅ Release ${green(release.tag)} created successfully!`);
        if (release.url) {
          console.log(`🔗 ${release.url}`);
        }
      }
      return;
    }

    // Normal flow: detect changes and calculate version bump
    // Get last release
    const lastRelease = await storage.getLastRelease();
    if (lastRelease) {
      console.log(`📌 Last release: ${cyan(lastRelease.tag)} (${lastRelease.sha.substring(0, 7)})`);
    } else {
      console.log(`📌 No previous releases found`);
    }

    // Detect changes
    console.log(`\n🔍 Detecting changes...`);
    const changes = await detector.detectChanges(lastRelease);

    if (!changes.hasChanges) {
      console.log(yellow('ℹ️  No changes detected since last release'));
      return;
    }

    console.log(`📝 Found ${green(String(changes.commits.length))} commits`);

    // Determine version bump
    const version = new Version();
    const bump = await version.determineVersionBump(
      lastRelease?.version || null,
      changes.commits,
    );

    if (!bump) {
      console.log(yellow('ℹ️  No version bump needed'));
      return;
    }

    console.log(`\n📊 Version bump: ${cyan(bump.from)} → ${green(bump.to)} (${bump.type})`);

    // Create release
    const releaseManager = new ReleaseManager(storage);
    const isDryRun = !args.execute;

    if (isDryRun) {
      console.log(yellow('\n🔍 DRY RUN MODE (use --execute to create release)\n'));
    }

    const tagStrategy = args['tag-strategy'] as 'github' | 'git';
    const release = await releaseManager.createRelease(
      bump,
      changes.currentSha,
      isDryRun,
      tagStrategy,
    );

    if (!isDryRun) {
      console.log(`\n✅ Release ${green(release.tag)} created successfully!`);
      if (release.url) {
        console.log(`🔗 ${release.url}`);
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
    if (error instanceof PlsError) {
      console.error(`\n${red('❌ Error:')} ${error.message}`);
      if (error.details) {
        console.error(`${red('Details:')}`, error.details);
      }
    } else {
      console.error(`\n${red('❌ Unexpected error:')}`, error);
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
