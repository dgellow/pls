/**
 * Changesets: @changesets/cli v3 driven by changesets/action v2, set up for a
 * project that is not published to npm (the root package is private, and
 * `privatePackages` makes the CLI version and tag it), so the outcome is a
 * tag and a GitHub Release like the other tools.
 *
 * Intent is expressed with changeset files, not commit messages.
 */

import type { RunContext, Workflow } from '../actions/runner.ts';
import type { PullRequest } from '../github/model.ts';
import { Expectation, type World } from '../scenario/world.ts';
import { cacheDir, exists, run } from './install.ts';
import type { Change, MappedChange, Tool, WorkflowOptions } from './tool.ts';

const ACTION_TAG = 'v2.1.2';
const CLI = '@changesets/cli@3.0.3';
const actionDir = `${cacheDir}/changesets-action`;
const cliDir = `${cacheDir}/changesets`;
const cli = `node ${cliDir}/node_modules/@changesets/cli/bin.js`;

function changeset(bump: 'major' | 'minor' | 'patch', summary: string): string {
  return `---\n"widget": ${bump}\n---\n\n${summary}\n`;
}

export const changesets: Tool = {
  name: 'changesets',
  capabilities: ['release-pr', 'prerelease', 'github-release', 'changelog-file'],

  async prepare(): Promise<void> {
    await Deno.mkdir(cacheDir, { recursive: true });
    if (!(await exists(`${actionDir}/dist/index.js`))) {
      await run(cacheDir, [
        'git',
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        ACTION_TAG,
        'https://github.com/changesets/action',
        actionDir,
      ]);
    }
    if (!(await exists(`${cliDir}/node_modules/@changesets/cli/bin.js`))) {
      await Deno.mkdir(cliDir, { recursive: true });
      await Deno.writeTextFile(
        `${cliDir}/package.json`,
        '{"name":"sim-changesets","private":true}\n',
      );
      await run(cliDir, ['npm', 'install', '--silent', '--no-audit', '--no-fund', CLI]);
    }
  },

  version(): Promise<string> {
    return Promise.resolve(`cli ${CLI.split('@').pop()}, action ${ACTION_TAG}`);
  },

  async adopt(w: World, version: string): Promise<void> {
    await w.commit('chore: initial commit', {
      'package.json': `{\n  "name": "widget",\n  "version": "${version}",\n  "private": true\n}\n`,
      'README.md': '# widget\n',
      'CHANGELOG.md': `# widget\n\n## ${version}\n\n- Initial release\n`,
      '.gitignore': 'node_modules\n',
      '.changeset/config.json': JSON.stringify(
        {
          changelog: '@changesets/cli/changelog',
          baseBranch: 'main',
          commit: false,
          access: 'restricted',
          privatePackages: { version: true, tag: true },
        },
        null,
        2,
      ) + '\n',
      '.changeset/README.md': '# Changesets\n',
    });
    await w.sh(`git tag v${version} && git push -q origin main v${version}`);
    await w.model.createRelease(
      w.repo,
      { tag_name: `v${version}`, name: `v${version}`, body: 'Initial release' },
      w.web,
    );
  },

  workflows(_w: World, opts: WorkflowOptions): Workflow[] {
    const token = opts.token === 'PAT' ? { secret: 'PAT' } : { githubToken: true as const };
    return [{
      name: 'Release',
      on: [{ event: 'push', branches: ['main'] }],
      permissions: { contents: 'write', pull_requests: 'write' },
      checkout: { fetchDepth: opts.fetchDepth ?? 0 },
      steps: [
        {
          // Stands in for `npm ci` with a warm cache.
          name: 'install dependencies',
          run: `ln -s ${cliDir}/node_modules node_modules`,
        },
        {
          id: 'changesets',
          name: 'changesets/action',
          run: [
            'env',
            '"INPUT_GITHUB-TOKEN=$TOKEN"',
            `"INPUT_PUBLISH-SCRIPT=${cli} publish"`,
            '"INPUT_COMMIT-MESSAGE=Version Packages"',
            '"INPUT_PR-TITLE=Version Packages"',
            'INPUT_CREATE-GITHUB-RELEASES=true',
            'INPUT_PUSH-GIT-TAGS=true',
            'INPUT_PUSH-WITH-GIT-CLI=false',
            `node ${actionDir}/dist/index.js`,
          ].join(' '),
          env: { TOKEN: token },
        },
        ...(opts.publish
          ? [{
            name: 'publish',
            if: (ctx: RunContext) => ctx.outputs.changesets?.published === 'true',
            run: opts.publish,
            env: { GITHUB_TOKEN: token },
          }]
          : []),
      ],
    }];
  },

  change(_w: World, change: Change): MappedChange {
    const bump = { feature: 'minor', fix: 'patch', breaking: 'major' } as const;
    const slug = change.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const files = change.kind in bump
      ? {
        [`.changeset/${slug}.md`]: changeset(
          bump[change.kind as keyof typeof bump],
          change.summary,
        ),
      }
      : {};
    return { message: change.summary, files, labels: [] };
  },

  releasePR(w: World): PullRequest | undefined {
    return w.openPRs().find((pr) => pr.head.ref.startsWith('changeset-release/'));
  },

  tagName(version: string): string {
    return `v${version}`;
  },

  async versionAt(w: World, ref: string): Promise<string | null> {
    const pkg = await w.file('package.json', ref);
    return pkg ? JSON.parse(pkg).version as string : null;
  },

  /**
   * How a maintainer steers the version with Changesets: prerelease mode for a
   * prerelease, leaving it for a stable release, an extra changeset for a
   * bigger bump.
   */
  async selectVersion(w: World, version: string): Promise<void> {
    await w.pull();
    const pre = /-([a-z]+)\.\d+$/.exec(version);
    const inPre = await exists(`${w.dev}/.changeset/pre.json`);
    if (pre) {
      await w.sh(`${cli} pre enter ${pre[1]}`);
      await w.commit(`Enter ${pre[1]} prerelease mode`);
    } else if (inPre) {
      await w.sh(`${cli} pre exit`);
      await w.commit('Exit prerelease mode');
    } else if (/^\d+\.0\.0$/.test(version)) {
      await w.commit(`Release ${version}`, {
        '.changeset/force-major.md': changeset('major', `Release ${version}`),
      });
    } else {
      throw new Expectation(`changesets adapter: no way to select ${version}`);
    }
    await w.sh('git push -q origin main');
    await w.settle();
  },

  spoof(version: string): string {
    return `Release-As: ${version}\n\nBREAKING CHANGE: release ${version}`;
  },
};
