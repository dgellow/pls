/**
 * Simulated GitHub Actions.
 *
 * Listens to the events the simulated GitHub emits, applies GitHub's trigger
 * rules, and executes matching workflows as real subprocesses in a fresh
 * workspace that is checked out the way actions/checkout does it.
 *
 * Rules modelled:
 * - Events caused by GITHUB_TOKEN start no workflow runs, except that pull
 *   requests it opens or updates get runs that wait for approval.
 * - Each run gets its own GITHUB_TOKEN with the workflow's permissions, and
 *   the token stops working when the run ends.
 * - The default checkout is shallow (depth 1, no tags).
 * - The runner has no git identity configured.
 * - `[skip ci]` in the head commit message suppresses push runs.
 */

import type { CallRecord, GitHubSim } from '../github/server.ts';
import type { Permission, Repo, SimEvent, Token } from '../github/model.ts';
import { runShell, type ShellResult } from './shell.ts';

export type Trigger =
  | { event: 'push'; branches?: string[]; tags?: string[] }
  | { event: 'pull_request'; types?: string[]; branches?: string[] }
  | { event: 'release'; types?: string[] }
  | { event: 'workflow_dispatch' }
  | { event: 'repository_dispatch'; types?: string[] };

export type EnvValue = string | { secret: string } | { githubToken: true };

export interface Step {
  id?: string;
  name: string;
  run: string;
  env?: Record<string, EnvValue>;
  if?: (ctx: RunContext) => boolean;
  continueOnError?: boolean;
  timeoutMs?: number;
}

export interface Workflow {
  name: string;
  on: Trigger[];
  if?: (event: SimEvent) => boolean;
  permissions?: Record<string, Permission>;
  /** false skips checkout. token names a secret to check out with instead of GITHUB_TOKEN. */
  checkout?: { fetchDepth?: number; fetchTags?: boolean; token?: string } | false;
  steps: Step[];
}

export interface StepResult {
  name: string;
  skipped: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface Run {
  id: string;
  workflow: string;
  event: string;
  action?: string;
  ref: string;
  sha: string;
  status: 'queued' | 'in_progress' | 'completed' | 'action_required';
  conclusion: 'success' | 'failure' | 'timed_out' | null;
  steps: StepResult[];
  outputs: Record<string, Record<string, string>>;
  /** Simulator event that triggered the run. */
  trigger: SimEvent;
}

export interface RunContext {
  run: Run;
  outputs: Record<string, Record<string, string>>;
  workspace: string;
}

export interface Suppressed {
  workflow: string;
  event: string;
  action?: string;
  reason: string;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') +
      '$',
  );
  return re.test(value);
}

export class Runner {
  workflows: Workflow[] = [];
  runs: Run[] = [];
  suppressed: Suppressed[] = [];
  private queue: Array<{ run: Run; workflow: Workflow }> = [];
  private counter = 0;
  /** Secrets available to workflows by name. */
  secrets = new Map<string, string>();
  /** Extra environment for every step (tool locations, caches). */
  baseEnv: Record<string, string> = {};
  defaultStepTimeoutMs = 120_000;

  constructor(private sim: GitHubSim, private repo: Repo) {
    sim.model.on((e) => {
      if (e.repo === repo.full) this.onEvent(e);
    });
  }

  // --- triggering ---

  private matches(w: Workflow, e: SimEvent): boolean {
    for (const t of w.on) {
      if (t.event !== e.name) continue;
      if (t.event === 'push') {
        const ref = String(e.payload.ref);
        if (e.payload.deleted) continue;
        if (ref.startsWith('refs/heads/')) {
          if (t.tags && !t.branches) continue;
          const branch = ref.slice('refs/heads/'.length);
          if (!t.branches || t.branches.some((p) => globMatch(p, branch))) return true;
        } else if (ref.startsWith('refs/tags/')) {
          if (t.branches && !t.tags) continue;
          const tag = ref.slice('refs/tags/'.length);
          if (!t.tags || t.tags.some((p) => globMatch(p, tag))) return true;
        }
      } else if (t.event === 'pull_request') {
        const types = t.types ?? ['opened', 'synchronize', 'reopened'];
        if (!types.includes(e.action ?? '')) continue;
        const pr = e.payload.pull_request as { base: { ref: string } };
        if (!t.branches || t.branches.some((p) => globMatch(p, pr.base.ref))) return true;
      } else if (t.event === 'release') {
        if ((t.types ?? ['published']).includes(e.action ?? '')) return true;
      } else if (t.event === 'repository_dispatch') {
        if (!t.types || t.types.includes(e.action ?? '')) return true;
      } else {
        return true;
      }
    }
    return false;
  }

  private onEvent(e: SimEvent): void {
    for (const w of this.workflows) {
      if (!this.matches(w, e)) continue;
      const note = (reason: string) =>
        this.suppressed.push({ workflow: w.name, event: e.name, action: e.action, reason });

      const byActionsToken = e.cause.token?.kind === 'actions';
      const dispatch = e.name === 'workflow_dispatch' || e.name === 'repository_dispatch';
      let approval = false;
      if (byActionsToken && !dispatch) {
        const prUpdate = e.name === 'pull_request' &&
          ['opened', 'synchronize', 'reopened'].includes(e.action ?? '');
        if (!prUpdate) {
          note('event was created with GITHUB_TOKEN');
          continue;
        }
        approval = true;
      }
      if (e.name === 'push') {
        const head = e.payload.head_commit as { message?: string } | null;
        if (
          head?.message &&
          /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/.test(head.message)
        ) {
          note('head commit message asks to skip CI');
          continue;
        }
      }
      if (w.if && !w.if(e)) {
        note('job condition was false');
        continue;
      }

      const pr = e.payload.pull_request as { number: number; head: { sha: string } } | undefined;
      const release = e.payload.release as { tag_name: string } | undefined;
      const run: Run = {
        id: `run-${++this.counter}`,
        workflow: w.name,
        event: e.name,
        action: e.action,
        ref: pr
          ? `refs/pull/${pr.number}/merge`
          : release
          ? `refs/tags/${release.tag_name}`
          : String(
            e.payload.ref ?? `refs/heads/${this.repo.settings.default_branch}`,
          ),
        sha: pr ? pr.head.sha : String(e.payload.after ?? ''),
        status: approval ? 'action_required' : 'queued',
        conclusion: null,
        steps: [],
        outputs: {},
        trigger: e,
      };
      this.runs.push(run);
      if (approval) {
        note('pull request was created with GITHUB_TOKEN: run waits for approval');
      } else {
        this.queue.push({ run, workflow: w });
      }
    }
  }

  /** A maintainer clicks "Approve workflows to run". */
  approve(runId: string): void {
    const run = this.runs.find((r) => r.id === runId);
    const workflow = this.workflows.find((w) => w.name === run?.workflow);
    if (run && workflow && run.status === 'action_required') {
      run.status = 'queued';
      this.queue.push({ run, workflow });
    }
  }

  /** A maintainer clicks "Re-run all jobs" on a finished run: same event and commit, new token. */
  rerun(runId: string): Run | null {
    const old = this.runs.find((r) => r.id === runId);
    const workflow = this.workflows.find((w) => w.name === old?.workflow);
    if (!old || !workflow) return null;
    const run: Run = {
      ...old,
      id: `run-${++this.counter}`,
      status: 'queued',
      conclusion: null,
      steps: [],
      outputs: {},
    };
    this.runs.push(run);
    this.queue.push({ run, workflow });
    return run;
  }

  get pending(): Run[] {
    return this.queue.map((q) => q.run);
  }

  /** Execute queued runs one after another until none are left. */
  async drain(): Promise<Run[]> {
    const done: Run[] = [];
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      done.push(await this.execute(next.run, next.workflow));
    }
    return done;
  }

  /** Take the next queued run without executing it, to run it concurrently with others. */
  take(): { run: Run; start: () => Promise<Run> } | null {
    const next = this.queue.shift();
    if (!next) return null;
    return { run: next.run, start: () => this.execute(next.run, next.workflow) };
  }

  /** Take every queued run, for scenarios that interleave runs. */
  takeAll(): Array<{ run: Run; start: () => Promise<Run> }> {
    const all = [];
    for (let next = this.take(); next; next = this.take()) all.push(next);
    return all;
  }

  callsOf(run: Run): CallRecord[] {
    return this.sim.callsFor(run.id);
  }

  // --- execution ---

  private async sh(
    cwd: string,
    script: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<ShellResult> {
    return await runShell(script, { cwd, env, timeoutMs });
  }

  private async ensureMergeRef(prNumber: number): Promise<string | null> {
    const pr = this.repo.prs.get(prNumber);
    if (!pr) return null;
    const base = await this.repo.git.commitSha(`refs/heads/${pr.base.ref}`);
    if (!base) return null;
    const tree = await this.repo.git.mergeTrees(base, pr.head.sha);
    if (!tree) return null;
    const sha = await this.repo.git.writeCommit(
      tree,
      [base, pr.head.sha],
      `Merge ${pr.head.sha} into ${base}`,
      { name: 'GitHub', email: 'noreply@github.com' },
    );
    await this.repo.git.updateRef(`refs/pull/${prNumber}/merge`, sha);
    return sha;
  }

  private async execute(run: Run, workflow: Workflow): Promise<Run> {
    run.status = 'in_progress';
    const model = this.sim.model;
    const bot = model.user('github-actions[bot]', 'Bot');
    const token: Token = model.mintToken(
      'actions',
      bot,
      { metadata: 'read', contents: 'read', ...(workflow.permissions ?? {}) },
      run.id,
    );
    const workspace = await Deno.makeTempDir({ prefix: 'pls-sim-workspace-' });
    const home = await Deno.makeTempDir({ prefix: 'pls-sim-home-' });
    const temp = await Deno.makeTempDir({ prefix: 'pls-sim-runner-temp-' });
    const outputFile = `${temp}/github_output`;
    const eventFile = `${temp}/event.json`;
    await Deno.writeTextFile(eventFile, JSON.stringify(run.trigger.payload));

    const e = run.trigger;
    const pr = e.payload.pull_request as
      | { number: number; head: { ref: string }; base: { ref: string } }
      | undefined;
    let sha = run.sha;
    if (pr) sha = await this.ensureMergeRef(pr.number) ?? run.sha;
    if (run.ref.startsWith('refs/tags/')) {
      sha = await this.repo.git.commitSha(run.ref) ?? sha;
    }
    run.sha = sha;

    const env: Record<string, string> = {
      PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: this.repo.full,
      GITHUB_REPOSITORY_OWNER: this.repo.owner,
      GITHUB_EVENT_NAME: run.event,
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_REF: run.ref,
      GITHUB_REF_NAME: run.ref.replace(/^refs\/(heads|tags|pull)\//, ''),
      GITHUB_SHA: sha,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: `${temp}/step_summary`,
      GITHUB_API_URL: this.sim.url,
      GITHUB_SERVER_URL: this.sim.url,
      GITHUB_GRAPHQL_URL: `${this.sim.url}/graphql`,
      GITHUB_RUN_ID: run.id,
      GITHUB_ACTOR: e.cause.actor.login,
      RUNNER_TEMP: temp,
      npm_config_registry: this.sim.npmRegistryUrl,
      ...(pr ? { GITHUB_HEAD_REF: pr.head.ref, GITHUB_BASE_REF: pr.base.ref } : {}),
      ...this.baseEnv,
    };
    await Deno.writeTextFile(outputFile, '');

    const resolve = (v: EnvValue): string => {
      if (typeof v === 'string') return v;
      if ('githubToken' in v) return token.value;
      return this.secrets.get(v.secret) ?? '';
    };

    const steps: Step[] = [];
    if (workflow.checkout !== false) {
      const opts = workflow.checkout ?? {};
      const depth = opts.fetchDepth ?? 1;
      const checkoutToken = opts.token ? (this.secrets.get(opts.token) ?? '') : token.value;
      const url = this.sim.gitUrl(this.repo.owner, this.repo.name);
      const auth = btoa(`x-access-token:${checkoutToken}`);
      const lines = [
        'git init -q .',
        `git remote add origin ${url}`,
        `git config --local http.${this.sim.url}/.extraheader "AUTHORIZATION: basic ${auth}"`,
      ];
      const tags = opts.fetchTags || depth === 0 ? `'+refs/tags/*:refs/tags/*'` : '';
      if (run.ref.startsWith('refs/heads/')) {
        const branch = run.ref.slice('refs/heads/'.length);
        if (depth === 0) {
          lines.push(`git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*' ${tags}`);
          // The branch may have moved since the event: actions/checkout then fetches the
          // event commit explicitly so the workspace is at the commit that triggered the run.
          lines.push(`git fetch -q origin +${sha}:refs/remotes/origin/${branch}`);
        } else {
          lines.push(
            `git fetch -q --no-tags --prune --depth=${depth} origin +${sha}:refs/remotes/origin/${branch} ${tags}`,
          );
        }
        lines.push(`git checkout -q --force -B ${branch} refs/remotes/origin/${branch}`);
      } else {
        const local = run.ref.startsWith('refs/pull/')
          ? run.ref.replace('refs/', 'refs/remotes/')
          : run.ref;
        if (depth === 0) {
          lines.push(`git fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*' ${tags}`);
          lines.push(`git fetch -q origin +${sha}:${local}`);
        } else {
          lines.push(`git fetch -q --no-tags --depth=${depth} origin +${sha}:${local} ${tags}`);
        }
        lines.push(`git checkout -q --force ${local}`);
      }
      steps.push({ name: 'actions/checkout', run: lines.join('\n') });
    }
    steps.push(...workflow.steps);

    const ctx: RunContext = { run, outputs: run.outputs, workspace };
    let failed = false;
    let timedOut = false;
    for (const step of steps) {
      const skip = failed ? true : (step.if ? !step.if(ctx) : false);
      if (skip) {
        run.steps.push({
          name: step.name,
          skipped: true,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          ms: 0,
        });
        continue;
      }
      const stepEnv = { ...env };
      for (const [k, v] of Object.entries(step.env ?? {})) stepEnv[k] = resolve(v);
      const before = await Deno.readTextFile(outputFile);
      const r = await this.sh(
        workspace,
        step.run,
        stepEnv,
        step.timeoutMs ?? this.defaultStepTimeoutMs,
      );
      const after = await Deno.readTextFile(outputFile);
      if (step.id) run.outputs[step.id] = parseOutputs(after.slice(before.length));
      run.steps.push({
        name: step.name,
        skipped: false,
        exitCode: r.code,
        timedOut: r.timedOut,
        stdout: r.stdout,
        stderr: r.stderr,
        ms: r.ms,
      });
      if (r.timedOut) timedOut = true;
      if ((r.code !== 0) && !step.continueOnError) failed = true;
    }

    token.revoked = true;
    run.status = 'completed';
    run.conclusion = timedOut ? 'timed_out' : failed ? 'failure' : 'success';
    for (const dir of [workspace, home, temp]) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
    return run;
  }
}

/** Parse the GITHUB_OUTPUT file format: `name=value` and `name<<DELIM` blocks. */
export function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== heredoc[2]) body.push(lines[i++]);
      out[heredoc[1]] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}
