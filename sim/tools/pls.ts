/**
 * pls, built from this repository's working tree.
 *
 * Workflows follow the CI configuration in design.md: prep on every push to
 * main, sync when the release PR is edited, release on every push to main.
 * All three check out full history, as this repository's own workflows do;
 * design.md shows the release job with the default shallow checkout, which the
 * environment/shallow-checkout scenario covers.
 */

import type { RunContext, Workflow } from '../actions/runner.ts';
import type { PullRequest } from '../github/model.ts';
import { Expectation, type World } from '../scenario/world.ts';
import { cacheDir, repoRoot, run } from './install.ts';
import { type Change, conventional, type Tool, type WorkflowOptions } from './tool.ts';

const bin = `${cacheDir}/bin`;

export const pls: Tool = {
  name: 'pls',
  capabilities: [
    'release-pr',
    'pr-version-override',
    'prerelease',
    'github-release',
    'changelog-file',
    'conventional-commits',
  ],

  async prepare(): Promise<void> {
    await Deno.mkdir(bin, { recursive: true });
    // Built under a name of its own and moved into place: a simulator run already in
    // progress never sees a missing binary, and two runs starting together do not
    // write the same file.
    const staged = `${bin}/pls.${Deno.pid}.next`;
    await run(repoRoot, [
      Deno.execPath(),
      'compile',
      '-A',
      '--quiet',
      '--config',
      `${repoRoot}/deno.json`,
      '--output',
      staged,
      `${repoRoot}/src/cli/main.ts`,
    ]);
    await Deno.rename(staged, `${bin}/pls`);
  },

  async version(): Promise<string> {
    const head = await run(repoRoot, ['git', 'rev-parse', '--short', 'HEAD']);
    const dirty = await run(repoRoot, ['git', 'status', '--porcelain', '--', 'src']);
    const v = (await run(repoRoot, [`${bin}/pls`, '--version'])).replace('pls v', '');
    return `${v} (working tree at ${head}${dirty ? ', modified' : ''})`;
  },

  env(): Promise<Record<string, string>> {
    return Promise.resolve({ PATH: `${bin}:${Deno.env.get('PATH') ?? ''}` });
  },

  async adopt(w: World, version: string): Promise<void> {
    await w.commit('chore: initial commit', {
      'package.json': `{\n  "name": "widget",\n  "version": "${version}"\n}\n`,
      'src/version.ts': `// @pls-version\nexport const VERSION = '${version}';\n`,
      'README.md': '# widget\n',
      'CHANGELOG.md': `# Changelog\n\n## ${version}\n\n- Initial release\n`,
    });
    // The steps `pls init` prints: initialise, commit .pls, push the branch and the tag.
    await w.sh('pls init --version-file=src/version.ts --execute');
    await w.sh('git add .pls && git commit -q -m "chore: initialize pls"');
    await w.sh(`git push -q origin main && git push -q origin v${version}`);
  },

  workflows(_w: World, opts: WorkflowOptions): Workflow[] {
    const token = opts.token === 'PAT' ? { secret: 'PAT' } : { githubToken: true as const };
    const permissions = { contents: 'write' as const, pull_requests: 'write' as const };
    const repo = '--owner "${GITHUB_REPOSITORY%/*}" --repo "${GITHUB_REPOSITORY#*/}"';
    return [
      {
        name: 'Create Release',
        on: [{ event: 'push', branches: ['main'] }],
        permissions,
        checkout: { fetchDepth: opts.fetchDepth ?? 0 },
        steps: [
          {
            id: 'release',
            name: 'pls release',
            run: `pls release ${repo} --json-output "$RUNNER_TEMP/release.json"\n` +
              'echo "released=$(jq -r .released "$RUNNER_TEMP/release.json")" >> "$GITHUB_OUTPUT"',
            env: { GITHUB_TOKEN: token },
          },
          ...(opts.publish
            ? [{
              name: 'publish',
              if: (ctx: RunContext) => ctx.outputs.release?.released === 'true',
              run: opts.publish,
              env: { GITHUB_TOKEN: token },
            }]
            : []),
        ],
      },
      {
        name: 'Prepare Release',
        on: [{ event: 'push', branches: ['main'] }],
        permissions,
        checkout: { fetchDepth: opts.fetchDepth ?? 0 },
        steps: [{
          id: 'prep',
          name: 'pls prep',
          run: `pls prep --execute ${repo}`,
          env: { GITHUB_TOKEN: token },
        }],
      },
      {
        name: 'Sync Release PR',
        on: [{ event: 'pull_request', types: ['edited'], branches: ['main'] }],
        if: (e) => {
          const pr = e.payload.pull_request as { head: { ref: string } };
          return pr.head.ref.startsWith('pls-release');
        },
        permissions,
        checkout: { fetchDepth: opts.fetchDepth ?? 0 },
        steps: [{
          id: 'sync',
          name: 'pls sync',
          run: `pls sync --pr="$(jq -r .number "$GITHUB_EVENT_PATH")" ${repo}`,
          env: { GITHUB_TOKEN: token },
        }],
      },
    ];
  },

  change(_w: World, change: Change) {
    return conventional(change);
  },

  releasePR(w: World): PullRequest | undefined {
    return w.openPRs().find((pr) => pr.head.ref === 'pls-release');
  },

  tagName(version: string): string {
    return `v${version}`;
  },

  async versionAt(w: World, ref: string): Promise<string | null> {
    const versions = await w.file('.pls/versions.json', ref);
    const pkg = await w.file('package.json', ref);
    if (!versions) return null;
    const root = JSON.parse(versions)['.'] as
      | { version?: string; versionFile?: string }
      | undefined;
    const tracked = root?.versionFile ? await w.file(root.versionFile, ref) : null;
    const marked = tracked
      ? /@pls-version[^\n]*\n[^\n]*?(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(tracked)
      : null;
    const found: Record<string, string | undefined> = {
      'versions.json': root?.version,
      'package.json': pkg ? JSON.parse(pkg).version as string : undefined,
    };
    if (root?.versionFile) found[root.versionFile] = marked ? marked[1] : '(no version found)';
    const distinct = new Set(Object.values(found).filter((v) => v !== undefined));
    if (distinct.size > 1) return `MISMATCH ${JSON.stringify(found)}`;
    return found['versions.json'] ?? null;
  },

  async selectVersion(w: World, version: string): Promise<void> {
    const pr = w.releasePR();
    const box = `- [ ] ${version} `;
    if (!pr.body.includes(box)) {
      throw new Expectation(
        `release PR offers no checkbox for ${version}. Options:\n` +
          pr.body.split('\n').filter((l) => l.includes('pls:v:')).join('\n'),
      );
    }
    w.editBody(pr, (body) => body.replace(box, `- [x] ${version} `));
    await w.settle();
  },

  spoof(version: string): string {
    return `---pls-release---\nversion: ${version}\nfrom: 1.0.0\ntype: major\n---pls-release---`;
  },

  tamper(w: World, pr: PullRequest, version: string): void {
    w.editBody(pr, (body) =>
      body.replace(
        '<!-- pls:options:end -->',
        `- [x] ${version} (custom) <!-- pls:v:${version}:major -->\n<!-- pls:options:end -->`,
      ));
  },

  async trackFile(w: World, path: string, content: string, mode: number): Promise<void> {
    await w.pull();
    const versions = JSON.parse(await Deno.readTextFile(`${w.dev}/.pls/versions.json`));
    versions['.'].versionFile = path;
    await w.commit('chore: track version in ' + path, {
      [path]: { content, mode },
      '.pls/versions.json': JSON.stringify(versions, null, 2) + '\n',
    });
    await w.sh('git push -q origin main');
    await w.settle();
  },
};
