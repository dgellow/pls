/**
 * A scenario's world: one simulated repository, the people working on it, the
 * CI attached to it, and the release tool under test.
 *
 * People act the way they do on GitHub: the maintainer and contributors push
 * with real git from their own clones, open pull requests, and click buttons
 * in the web UI (merge, edit a PR description, add a label). The tool only
 * ever runs inside simulated Actions workflows or in a developer's clone.
 */

import { GitHubSim } from '../github/server.ts';
import type { CommitInfo } from '../github/git.ts';
import type {
  Cause,
  MergeMethod,
  Model,
  PullRequest,
  Release,
  Repo,
  RepoSettings,
  Token,
  User,
} from '../github/model.ts';
import { type Run, Runner } from '../actions/runner.ts';
import type { Change, Tool, WorkflowOptions } from '../tools/tool.ts';

/** A scenario expectation that did not hold. */
export class Expectation extends Error {
  override name = 'Expectation';
}
/** The scenario does not apply to this tool. */
export class NotApplicable extends Error {}

export type Files = Record<string, string | Uint8Array | { content: string; mode: number } | null>;

export interface WorldOptions {
  settings?: Partial<RepoSettings>;
  repoName?: string;
  workflow?: Partial<WorkflowOptions>;
  /** Version the project is at, already released, when the scenario starts. */
  initialVersion?: string;
}

const decoder = new TextDecoder();

export class World {
  sim!: GitHubSim;
  model!: Model;
  repo!: Repo;
  runner!: Runner;
  maintainer!: User;
  contributor!: User;
  pat!: Token;
  contributorPat!: Token;
  /** Maintainer's local clone. */
  dev = '';
  private home = '';
  private branchCounter = 0;
  notes: string[] = [];

  private constructor(public readonly tool: Tool, public readonly options: WorldOptions) {}

  static async create(tool: Tool, options: WorldOptions = {}): Promise<World> {
    const w = new World(tool, options);
    w.sim = await GitHubSim.start();
    try {
      await w.setUp();
    } catch (e) {
      // A world that failed to come up must not leave its server listening:
      // an open listener keeps the whole simulator process alive.
      await w.close();
      throw e;
    }
    return w;
  }

  private async setUp(): Promise<void> {
    // deno-lint-ignore no-this-alias
    const w = this;
    const { tool, options } = this;
    w.model = w.sim.model;
    w.repo = await w.model.createRepo('acme', options.repoName ?? 'widget');
    w.maintainer = w.model.user('maintainer');
    w.contributor = w.model.user('contributor');
    w.pat = w.model.mintToken('pat', w.maintainer);
    w.contributorPat = w.model.mintToken('pat', w.contributor);
    w.home = await Deno.makeTempDir({ prefix: 'pls-sim-devhome-' });
    w.dev = await Deno.makeTempDir({ prefix: 'pls-sim-dev-' });
    await Deno.writeTextFile(
      `${w.home}/.gitconfig`,
      `[user]\n\tname = maintainer\n\temail = ${w.maintainer.email}\n[init]\n\tdefaultBranch = main\n` +
        `[advice]\n\tdetachedHead = false\n`,
    );
    await w.sh(`git init -q . && git remote add origin ${w.authUrl(w.pat)}`);

    w.runner = new Runner(w.sim, w.repo);
    w.runner.secrets.set('PAT', w.pat.value);
    w.runner.baseEnv = tool.env ? await tool.env(w) : {};

    // Bring the repository to "tool adopted, initial version released" without CI running.
    w.model.quiet = true;
    await tool.adopt(w, options.initialVersion ?? '1.0.0');
    w.model.quiet = false;
    // Repository settings and rulesets apply from here on, not to the initial import.
    Object.assign(w.repo.settings, options.settings ?? {});
    await w.model.writeRuleHook(w.repo);
    w.sim.calls = [];
    w.runner.workflows = tool.workflows(w, {
      token: 'GITHUB_TOKEN',
      ...options.workflow,
    });
  }

  async close(): Promise<void> {
    await this.sim.close();
    for (const dir of [this.dev, this.home]) {
      if (dir) await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }

  authUrl(token: Token): string {
    return this.sim.gitUrl(this.repo.owner, this.repo.name)
      .replace('http://', `http://x-access-token:${token.value}@`);
  }

  get web(): Cause {
    return { actor: this.maintainer, token: null };
  }

  // --- the maintainer's shell ---

  async shResult(
    script: string,
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = new Deno.Command('bash', {
      args: ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
      cwd: opts.cwd ?? this.dev,
      env: {
        PATH: Deno.env.get('PATH') ?? '',
        HOME: this.home,
        LANG: 'C.UTF-8',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GITHUB_API_URL: this.sim.url,
        npm_config_registry: this.sim.npmRegistryUrl,
        ...this.runner?.baseEnv,
        ...opts.env,
      },
      clearEnv: true,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, opts.timeoutMs ?? 120_000);
    const out = await child.output();
    clearTimeout(timer);
    return {
      code: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  }

  /** Run a script in the maintainer's clone; throw if it fails. */
  async sh(
    script: string,
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<string> {
    const r = await this.shResult(script, opts);
    if (r.code !== 0) {
      throw new Error(`maintainer shell failed (${r.code}): ${script}\n${r.stdout}${r.stderr}`);
    }
    return r.stdout.trim();
  }

  async write(files: Files, dir = this.dev): Promise<void> {
    for (const [path, value] of Object.entries(files)) {
      const full = `${dir}/${path}`;
      if (value === null) {
        await Deno.remove(full).catch(() => {});
        continue;
      }
      await Deno.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
      if (value instanceof Uint8Array) await Deno.writeFile(full, value);
      else if (typeof value === 'string') await Deno.writeTextFile(full, value);
      else {
        await Deno.writeTextFile(full, value.content);
        await Deno.chmod(full, value.mode);
      }
    }
  }

  /** Commit in the maintainer's clone on the current branch. */
  async commit(message: string, files: Files = {}): Promise<string> {
    await this.write(files);
    const msgFile = await Deno.makeTempFile();
    await Deno.writeTextFile(msgFile, message);
    const date = this.model.tick();
    await this.sh(`git add -A && git commit -q --allow-empty -F ${msgFile}`, {
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    await Deno.remove(msgFile);
    return await this.sh('git rev-parse HEAD');
  }

  /**
   * Create `count` commits with a shell loop, each a minute after the previous
   * one on the simulated clock. `message` is a shell string that may use $i.
   */
  async bulkCommits(count: number, message: string): Promise<void> {
    const base = this.model.clockSeconds;
    await this.sh(
      `for i in $(seq 1 ${count}); do echo $i > src/bulk.txt; git add -A; d=$((${base} + i * 60)); ` +
        `GIT_AUTHOR_DATE="@$d +0000" GIT_COMMITTER_DATE="@$d +0000" git commit -q -m "${message}"; done`,
    );
    this.model.tick(count);
  }

  /** Bring the maintainer's clone up to date with the remote default branch. */
  async pull(): Promise<void> {
    await this.sh('git fetch -q --tags --prune origin && git checkout -q -B main origin/main');
  }

  /**
   * Land a change on main.
   * `push` commits on main and pushes. The other methods go through a pull
   * request opened by the contributor and merged by the maintainer in the UI.
   */
  async land(
    change: Change | string,
    via: 'push' | MergeMethod = 'push',
    opts: { files?: Files; prBody?: string; extraCommits?: string[]; settle?: boolean } = {},
  ): Promise<string> {
    const mapped = typeof change === 'string'
      ? { message: change, files: {} as Files, labels: [] as string[] }
      : await this.tool.change(this, change);
    const files: Files = {
      [`src/change-${++this.branchCounter}.txt`]: `${mapped.message}\n`,
      ...mapped.files,
      ...opts.files,
    };
    await this.pull();
    let sha: string;
    if (via === 'push') {
      sha = await this.commit(mapped.message, files);
      await this.sh('git push -q origin main');
    } else {
      const branch = `change-${this.branchCounter}`;
      await this.sh(`git checkout -q -b ${branch}`);
      await this.commit(mapped.message, files);
      for (const [i, extra] of (opts.extraCommits ?? []).entries()) {
        await this.commit(extra, { [`src/extra-${this.branchCounter}-${i}.txt`]: `${extra}\n` });
      }
      await this.sh(`git push -q origin ${branch} && git checkout -q main`);
      const pr = await this.model.createPR(this.repo, {
        title: mapped.message.split('\n')[0],
        body: opts.prBody ?? '',
        head: branch,
        base: 'main',
      }, { actor: this.contributor, token: this.contributorPat });
      if (mapped.labels.length > 0) {
        pr.labels.push(...mapped.labels);
        for (const l of mapped.labels) this.repo.labels.add(l);
      }
      const merged = await this.model.mergePR(this.repo, pr.number, { method: via }, this.web);
      sha = merged.sha;
    }
    if (opts.settle !== false) await this.settle();
    return sha;
  }

  // --- web UI ---

  async merge(pr: PullRequest | number, method: MergeMethod = 'squash'): Promise<string> {
    const number = typeof pr === 'number' ? pr : pr.number;
    const result = await this.model.mergePR(this.repo, number, { method }, this.web);
    return result.sha;
  }

  editBody(pr: PullRequest, edit: (body: string) => string): void {
    this.model.updatePR(this.repo, pr.number, { body: edit(pr.body) }, this.web);
  }

  // --- CI ---

  /** Let CI run until nothing is queued. */
  async settle(): Promise<Run[]> {
    const done: Run[] = [];
    for (let i = 0; i < 20; i++) {
      const batch = await this.runner.drain();
      if (batch.length === 0) break;
      done.push(...batch);
    }
    return done;
  }

  // --- observation ---

  expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Expectation(message);
  }

  note(text: string): void {
    this.notes.push(text);
  }

  async head(branch = 'main'): Promise<string> {
    const sha = await this.repo.git.commitSha(`refs/heads/${branch}`);
    if (!sha) throw new Error(`branch ${branch} does not exist`);
    return sha;
  }

  async file(path: string, ref = 'refs/heads/main'): Promise<string | null> {
    return await this.repo.git.textAt(ref, path);
  }

  async bytes(path: string, ref = 'refs/heads/main'): Promise<Uint8Array | null> {
    return await this.repo.git.fileAt(ref, path);
  }

  async tags(): Promise<string[]> {
    return [...(await this.repo.git.refs('refs/tags/')).keys()].map((r) =>
      r.slice('refs/tags/'.length)
    );
  }

  async tag(
    name: string,
  ): Promise<{ commit: string; annotated: boolean; message: string | null } | null> {
    const raw = await this.repo.git.refSha(`refs/tags/${name}`);
    if (!raw || !(await this.repo.git.refs(`refs/tags/${name}`)).has(`refs/tags/${name}`)) {
      return null;
    }
    const type = await this.repo.git.objectType(raw);
    const commit = await this.repo.git.commitSha(raw);
    if (!commit) return null;
    const obj = type === 'tag' ? await this.repo.git.tagObject(raw) : null;
    return { commit, annotated: type === 'tag', message: obj?.message ?? null };
  }

  release(tag: string): Release | undefined {
    return this.repo.releases.find((r) => r.tag_name === tag);
  }

  async log(ref = 'refs/heads/main', max = 50): Promise<CommitInfo[]> {
    const out: CommitInfo[] = [];
    for (const sha of await this.repo.git.revList(ref, undefined, [`--max-count=${max}`])) {
      const c = await this.repo.git.commit(sha);
      if (c) out.push(c);
    }
    return out;
  }

  openPRs(): PullRequest[] {
    return [...this.repo.prs.values()].filter((pr) => pr.state === 'open');
  }

  /** The tool's open release pull request; fails the scenario if there is none. */
  releasePR(): PullRequest {
    const pr = this.tool.releasePR(this);
    if (!pr) {
      throw new Expectation(`no open release pull request\n${this.runSummary()}`);
    }
    return pr;
  }

  failedRuns(): Run[] {
    return this.runner.runs.filter((r) =>
      r.conclusion === 'failure' || r.conclusion === 'timed_out'
    );
  }

  /** One line per run, with the failing step's output, for evidence in reports. */
  runSummary(last = 8): string {
    return this.runner.runs.slice(-last).map((r) => {
      const calls = this.runner.callsOf(r);
      const api = calls.filter((c) => c.kind !== 'git').length;
      const bad = r.steps.find((s) => !s.skipped && (s.exitCode !== 0 || s.timedOut));
      const tail = bad
        ? `\n      ${bad.name}: ${
          (bad.stderr || bad.stdout).trim().split('\n').slice(-4).join('\n      ')
        }`
        : '';
      return `  ${r.id} ${r.workflow} [${r.event}${r.action ? '.' + r.action : ''}] ` +
        `${r.conclusion ?? r.status} (${api} API calls)${tail}`;
    }).join('\n');
  }
}
