import { parseArgs } from '@std/cli/parse-args';
import { bold, cyan, green, red, yellow } from '@std/fmt/colors';
import { createStorage } from './storage/mod.ts';
import { Detector, ReleaseManager, VersionTransition } from './core/mod.ts';
import type { TransitionTarget } from './core/mod.ts';
import { PlsError } from './types.ts';

export function printTransitionHelp(): void {
  console.log(`
${bold('pls transition')} - Transition between release stages

${bold('USAGE:')}
  pls transition <TARGET> [OPTIONS]

${bold('TARGETS:')}
  alpha                Start or move to alpha prerelease
  beta                 Start or move to beta prerelease  
  rc                   Start or move to release candidate
  stable               Graduate to stable release

${bold('OPTIONS:')}
  --major              Bump major version (when transitioning from stable)
  --minor              Bump minor version (default when transitioning from stable)
  --patch              Bump patch version (when transitioning from stable)
  --execute            Actually create the release (default is dry-run)
  --storage <type>     Storage backend: local (default) or github
  --owner <owner>      GitHub repository owner (auto-detected from git remote)
  --repo <repo>        GitHub repository name (auto-detected from git remote)
  --token <token>      GitHub token (or set GITHUB_TOKEN env var)

${bold('EXAMPLES:')}
  # Start alpha cycle (dry run)
  pls transition alpha

  # Move from alpha to beta
  pls transition beta --execute

  # Graduate RC to stable
  pls transition stable --execute

  # Start major version prerelease
  pls transition alpha --major --execute
`);
}

export async function handleTransition(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ['help', 'major', 'minor', 'patch', 'execute'],
    string: ['storage', 'owner', 'repo', 'token'],
    default: {
      storage: 'local',
    },
  });

  if (parsed.help || parsed._.length === 0) {
    printTransitionHelp();
    return;
  }

  const target = parsed._[0]?.toString().toLowerCase();
  if (!['alpha', 'beta', 'rc', 'stable'].includes(target)) {
    console.error(`${red('❌ Error:')} Invalid transition target: ${target}`);
    console.error(`Valid targets: alpha, beta, rc, stable`);
    Deno.exit(1);
  }

  // Determine version bump type
  let bumpType: 'major' | 'minor' | 'patch' | undefined;
  if (parsed.major) bumpType = 'major';
  else if (parsed.patch) bumpType = 'patch';
  else if (parsed.minor) bumpType = 'minor';
  // Default is minor, but let transition logic handle it

  try {
    console.log(bold('pls transition\n'));

    // Create detector and storage
    const detector = new Detector();
    let repoInfo = { owner: parsed.owner, repo: parsed.repo };

    // Auto-detect GitHub repo if not provided
    if (parsed.storage === 'github' && (!repoInfo.owner || !repoInfo.repo)) {
      const detected = await detector.getRepoInfo();
      if (detected) {
        repoInfo = {
          owner: repoInfo.owner || detected.owner,
          repo: repoInfo.repo || detected.repo,
        };
        console.log(`📦 Detected repository: ${cyan(`${repoInfo.owner}/${repoInfo.repo}`)}`);
      }
    }

    const storage = createStorage(parsed.storage as 'local' | 'github', {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      token: parsed.token,
    });

    console.log(`💾 Using storage: ${cyan(parsed.storage)}`);

    // Get last release
    const lastRelease = await storage.getLastRelease();
    if (!lastRelease) {
      console.error(
        `${red('❌ Error:')} No previous releases found. Create an initial release first.`,
      );
      Deno.exit(1);
    }

    const currentVersion = lastRelease.version;
    console.log(`📌 Current version: ${cyan(currentVersion)}`);

    // Perform transition
    const transition = new VersionTransition();
    const newVersion = transition.transition(
      currentVersion,
      target as TransitionTarget,
      bumpType,
    );

    console.log(`📊 Transition: ${cyan(currentVersion)} → ${green(newVersion)}`);

    // Get current SHA
    const currentSha = await detector.getCurrentSha();

    // Create release
    const releaseManager = new ReleaseManager(storage);
    const isDryRun = !parsed.execute;

    if (isDryRun) {
      console.log(yellow('\n🔍 DRY RUN MODE (use --execute to create release)\n'));
    }

    // Create minimal version bump for release
    const bump = {
      from: currentVersion,
      to: newVersion,
      type: 'transition' as const,
      commits: [], // No commits needed for transition
    };

    const release = await releaseManager.createRelease(
      bump,
      currentSha,
      isDryRun,
    );

    if (!isDryRun) {
      console.log(`\n✅ Transition to ${green(release.tag)} created successfully!`);
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
