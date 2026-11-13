/**
 * semantic-release with the changelog and git plugins: the documented recipe
 * for projects that keep the version and changelog in the repository.
 * It releases straight from CI on every push to main; there is no release PR.
 */

import type { Workflow } from '../actions/runner.ts';
import type { PullRequest } from '../github/model.ts';
import type { World } from '../scenario/world.ts';
import { cacheDir, exists, run } from './install.ts';
import { type Change, conventional, type Tool, type WorkflowOptions } from './tool.ts';

const dir = `${cacheDir}/semantic-release`;
const packages = [
  'semantic-release@25.0.9',
  '@semantic-release/changelog@6.0.3',
  '@semantic-release/git@11.0.1',
  '@semantic-release/exec@7.1.0',
];

export const semanticRelease: Tool = {
  name: 'semantic-release',
  capabilities: ['github-release', 'changelog-file', 'conventional-commits'],

  async prepare(): Promise<void> {
    if (await exists(`${dir}/node_modules/.bin/semantic-release`)) return;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/package.json`,
      '{"name":"sim-semantic-release","private":true}\n',
    );
    await run(dir, ['npm', 'install', '--silent', '--no-audit', '--no-fund', ...packages]);
  },

  async version(): Promise<string> {
    const pkg = JSON.parse(
      await Deno.readTextFile(`${dir}/node_modules/semantic-release/package.json`),
    );
    return `${pkg.version} with changelog, git and github plugins`;
  },

  async adopt(w: World, version: string): Promise<void> {
    const publish = w.options.workflow?.publish;
    const plugins: unknown[] = [
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/changelog',
      ['@semantic-release/npm', { npmPublish: false }],
      ['@semantic-release/git', {
        assets: ['package.json', 'CHANGELOG.md'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      }],
      ['@semantic-release/github', {
        successComment: false,
        failComment: false,
        releasedLabels: false,
      }],
    ];
    if (publish) plugins.push(['@semantic-release/exec', { publishCmd: publish }]);
    await w.commit('chore: initial commit', {
      'package.json': `{\n  "name": "widget",\n  "version": "${version}",\n  "private": true\n}\n`,
      'README.md': '# widget\n',
      'CHANGELOG.md': `# Changelog\n\n## ${version}\n\n- Initial release\n`,
      '.releaserc.json': JSON.stringify({ branches: ['main'], plugins }, null, 2) + '\n',
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
      permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
      checkout: { fetchDepth: opts.fetchDepth ?? 0 },
      steps: [{
        id: 'release',
        name: 'semantic-release',
        run: `node ${dir}/node_modules/.bin/semantic-release`,
        env: { GITHUB_TOKEN: token },
      }],
    }];
  },

  change(_w: World, change: Change) {
    return conventional(change);
  },

  releasePR(): PullRequest | undefined {
    return undefined;
  },

  tagName(version: string): string {
    return `v${version}`;
  },

  async versionAt(w: World, ref: string): Promise<string | null> {
    const pkg = await w.file('package.json', ref);
    return pkg ? JSON.parse(pkg).version as string : null;
  },

  spoof(version: string): string {
    return `Release-As: ${version}\n\nBREAKING CHANGE: release ${version}`;
  },
};
