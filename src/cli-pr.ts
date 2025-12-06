import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { createStorage } from './storage/mod.ts';
import { Detector, ReleaseManager, ReleasePullRequest, Version } from './core/mod.ts';
import { PlsError } from './types.ts';

export function printPRHelp(): void {
  console.log(`
${bold('pls pr')} - Create or update a release pull request

${bold('USAGE:')}
  pls pr [OPTIONS]

${bold('OPTIONS:')}
  --execute            Actually create/update the PR (default is dry-run)
  --base <branch>      Base branch (default: main)
  --owner <owner>      GitHub repository owner (auto-detected from git remote)
  --repo <repo>        GitHub repository name (auto-detected from git remote)
  --token <token>      GitHub token (or set GITHUB_TOKEN env var)

${bold('EXAMPLES:')}
  # Dry run
  pls pr

  # Create/update release PR
  pls pr --execute
`);
}

export async function handlePR(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'execute'],
    string: ['base', 'owner', 'repo', 'token'],
    default: {
      base: 'main',
    },
  });

  if (parsed.help) {
    printPRHelp();
    return;
  }

  try {
    console.log(bold('pls pr\n'));

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
        console.log(`📦 Repository: ${cyan(`${repoInfo.owner}/${repoInfo.repo}`)}`);
      } else {
        console.error(`${red('❌ Error:')} Could not detect repository. Use --owner and --repo`);
        Deno.exit(1);
      }
    }

    // Get last release from GitHub
    const storage = createStorage('github', {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      token: parsed.token,
    });

    const lastRelease = await storage.getLastRelease();
    if (lastRelease) {
      console.log(`📌 Last release: ${cyan(lastRelease.tag)}`);
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

    console.log(`📊 Version bump: ${cyan(bump.from)} → ${green(bump.to)} (${bump.type})`);

    // Generate changelog
    const releaseManager = new ReleaseManager(storage);
    const changelog = releaseManager.generateReleaseNotes(bump);

    // Create or update PR
    const isDryRun = !parsed.execute;

    if (isDryRun) {
      console.log(yellow('\n🔍 DRY RUN MODE (use --execute to create PR)\n'));
    }

    const pr = new ReleasePullRequest({
      owner: repoInfo.owner!,
      repo: repoInfo.repo!,
      token: parsed.token,
      baseBranch: parsed.base,
    });

    const result = await pr.createOrUpdate(bump, changelog, isDryRun);

    if (!isDryRun && result.url) {
      console.log(`\n✅ Release PR ready: ${green(result.url)}`);
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
