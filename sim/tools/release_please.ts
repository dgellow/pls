/**
 * release-please, run through googleapis/release-please-action (the way its
 * documentation tells users to run it), in manifest mode.
 */

import type { RunContext, Workflow } from '../actions/runner.ts';
import type { PullRequest } from '../github/model.ts';
import type { World } from '../scenario/world.ts';
import { cacheDir, exists, run } from './install.ts';
import { type Change, conventional, type Tool, type WorkflowOptions } from './tool.ts';

const ACTION_TAG = 'v5.0.0';
const actionDir = `${cacheDir}/rp-action`;

export const releasePlease: Tool = {
  name: 'release-please',
  capabilities: [
    'release-pr',
    'prerelease',
    'github-release',
    'changelog-file',
    'conventional-commits',
  ],

  async prepare(): Promise<void> {
    if (await exists(`${actionDir}/dist/index.js`)) return;
    await Deno.mkdir(cacheDir, { recursive: true });
    await run(cacheDir, [
      'git',
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      ACTION_TAG,
      'https://github.com/googleapis/release-please-action',
      actionDir,
    ]);
  },

  async version(): Promise<string> {
    const dist = await Deno.readTextFile(`${actionDir}/dist/index.js`);
    const bundled = /"name":\s*"release-please",\s*"version":\s*"([^"]+)"/.exec(dist)?.[1] ??
      /name:\s*"release-please",\s*version:\s*"([^"]+)"/.exec(dist)?.[1];
    return `action ${ACTION_TAG}${bundled ? `, release-please ${bundled}` : ''}`;
  },

  async adopt(w: World, version: string): Promise<void> {
    await w.commit('chore: initial commit', {
      'package.json': `{\n  "name": "widget",\n  "version": "${version}"\n}\n`,
      'README.md': '# widget\n',
      'CHANGELOG.md': `# Changelog\n\n## ${version}\n\n- Initial release\n`,
      'release-please-config.json': JSON.stringify(
        { packages: { '.': { 'release-type': 'node', 'include-component-in-tag': false } } },
        null,
        2,
      ) + '\n',
      '.release-please-manifest.json': JSON.stringify({ '.': version }, null, 2) + '\n',
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
      name: 'release-please',
      on: [{ event: 'push', branches: ['main'] }],
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
      checkout: false,
      steps: [
        {
          id: 'release',
          name: 'googleapis/release-please-action',
          run: [
            'env',
            '"INPUT_TOKEN=$TOKEN"',
            '"INPUT_REPO-URL=$GITHUB_REPOSITORY"',
            '"INPUT_GITHUB-API-URL=$GITHUB_API_URL"',
            '"INPUT_GITHUB-GRAPHQL-URL=$GITHUB_GRAPHQL_URL"',
            '"INPUT_CHANGELOG-HOST=$GITHUB_SERVER_URL"',
            'INPUT_FORK=false',
            'INPUT_INCLUDE-COMPONENT-IN-TAG=false',
            'INPUT_SKIP-GITHUB-RELEASE=false',
            'INPUT_SKIP-GITHUB-PULL-REQUEST=false',
            'INPUT_SKIP-LABELING=false',
            'INPUT_VERSIONING-STRATEGY=default',
            `node ${actionDir}/dist/index.js`,
          ].join(' '),
          env: { TOKEN: token },
        },
        ...(opts.publish
          ? [{
            name: 'publish',
            if: (ctx: RunContext) => ctx.outputs.release?.release_created === 'true',
            run: opts.publish,
            env: { GITHUB_TOKEN: token },
          }]
          : []),
      ],
    }];
  },

  change(_w: World, change: Change) {
    return conventional(change);
  },

  releasePR(w: World): PullRequest | undefined {
    return w.openPRs().find((pr) => pr.head.ref.startsWith('release-please--'));
  },

  tagName(version: string): string {
    return `v${version}`;
  },

  async versionAt(w: World, ref: string): Promise<string | null> {
    const manifest = await w.file('.release-please-manifest.json', ref);
    const pkg = await w.file('package.json', ref);
    if (!manifest) return null;
    const found = {
      manifest: JSON.parse(manifest)['.'] as string | undefined,
      'package.json': pkg ? JSON.parse(pkg).version as string : undefined,
    };
    if (found.manifest !== found['package.json']) return `MISMATCH ${JSON.stringify(found)}`;
    return found.manifest ?? null;
  },

  // The documented override: an empty commit on main with a Release-As footer.
  async selectVersion(w: World, version: string): Promise<void> {
    await w.pull();
    await w.commit(`chore: release ${version}\n\nRelease-As: ${version}`);
    await w.sh('git push -q origin main');
    await w.settle();
  },

  spoof(version: string): string {
    return `Release-As: ${version}`;
  },
};
