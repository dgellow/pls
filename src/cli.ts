#!/usr/bin/env -S deno run -A

import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { createStorage } from './storage/mod.ts';
import { Detector, ReleaseManager, Version } from './core/mod.ts';
import { PlsError } from './types.ts';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`
${bold('pls')} - A minimal, fast release automation tool

${bold('USAGE:')}
  pls [OPTIONS]

${bold('OPTIONS:')}
  --storage <type>     Storage backend: local (default) or github
  --dry-run            Show what would be done without making changes
  --owner <owner>      GitHub repository owner (auto-detected from git remote)
  --repo <repo>        GitHub repository name (auto-detected from git remote)
  --token <token>      GitHub token (or set GITHUB_TOKEN env var)
  --help, -h           Show this help message
  --version, -v        Show version

${bold('EXAMPLES:')}
  # Create a release using local storage
  pls

  # Dry run with GitHub storage
  pls --storage=github --dry-run

  # Use specific GitHub repo
  pls --storage=github --owner=myorg --repo=myrepo
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ['help', 'version', 'dry-run'],
    string: ['storage', 'owner', 'repo', 'token'],
    alias: {
      h: 'help',
      v: 'version',
    },
    default: {
      storage: 'local',
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

  try {
    console.log(bold('🚀 PLS - Release Automation\n'));

    // Create detector to get repo info
    const detector = new Detector();
    let repoInfo = { owner: args.owner, repo: args.repo };

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

    if (args['dry-run']) {
      console.log(yellow('\n⚠️  DRY RUN MODE - No changes will be made\n'));
    }

    const release = await releaseManager.createRelease(
      bump,
      changes.currentSha,
      args['dry-run'],
    );

    if (!args['dry-run']) {
      console.log(`\n✅ Release ${green(release.tag)} created successfully!`);
      if (release.url) {
        console.log(`🔗 ${release.url}`);
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
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
