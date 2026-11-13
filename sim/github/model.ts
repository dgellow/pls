/**
 * GitHub behaviour model.
 *
 * State and rules that are GitHub's, independent of transport: pull request
 * lifecycle, the three merge methods, release and tag rules, token kinds and
 * permissions, and the events each change emits. The HTTP layer (rest.ts,
 * graphql.ts, smart_http.ts) and the simulated web UI both call into here.
 */

import { BareRepo, type Identity } from './git.ts';

// --- actors and tokens ---

export interface User {
  login: string;
  id: number;
  type: 'User' | 'Bot';
  name: string;
  email: string;
}

export type TokenKind = 'pat' | 'actions' | 'app';
export type Permission = 'none' | 'read' | 'write';

export interface Token {
  value: string;
  kind: TokenKind;
  actor: User;
  permissions: Record<string, Permission>;
  /** Workflow run this token was minted for (actions tokens). */
  runId?: string;
  revoked?: boolean;
}

/** Who caused a change. token null means a person using the web UI. */
export interface Cause {
  actor: User;
  token: Token | null;
}

// --- repository state ---

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  merged_by: User | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: User;
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  target_commitish: string;
  author: User;
  created_at: string;
  published_at: string | null;
  immutable: boolean;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface RepoSettings {
  default_branch: string;
  allow_merge_commit: boolean;
  allow_squash_merge: boolean;
  allow_rebase_merge: boolean;
  delete_branch_on_merge: boolean;
  squash_merge_commit_title: 'PR_TITLE' | 'COMMIT_OR_PR_TITLE';
  squash_merge_commit_message: 'PR_BODY' | 'COMMIT_MESSAGES' | 'BLANK';
  /** "Allow GitHub Actions to create and approve pull requests". */
  actions_can_create_prs: boolean;
  /** Immutable releases: published releases lock their tag. */
  immutable_releases: boolean;
  /** Tag ruleset: creating tags matching the pattern is restricted to bypass token kinds. */
  restrict_tag_creation: { pattern: RegExp; bypass: Array<TokenKind | 'web'> } | null;
  /** Branch ruleset: direct updates to matching branches are restricted to bypass kinds. */
  protected_branches: Array<{ pattern: RegExp; bypass: Array<TokenKind | 'web' | 'merge'> }>;
  /** Delay before a merge commit shows up in the commit→PR association index. */
  commit_pr_index_lag_ms: number;
}

export interface SimEvent {
  seq: number;
  repo: string;
  name: string;
  action?: string;
  payload: Record<string, unknown>;
  cause: Cause;
  at: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: unknown[],
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const GITHUB_WEB_FLOW: Identity = { name: 'GitHub', email: 'noreply@github.com' };

export class Repo {
  prs = new Map<number, PullRequest>();
  releases: Release[] = [];
  labels = new Set<string>();
  comments = new Map<number, Comment[]>();
  /** commit sha → { pr numbers, visible from (ms epoch) } */
  commitPrIndex = new Map<string, { prs: number[]; visibleAt: number }>();
  /** Tag names locked by immutable releases, including deleted ones. */
  lockedTags = new Set<string>();
  /** Commits GitHub would show as Verified. */
  verified = new Set<string>();
  nextNumber = 1;
  nextId = 1000;

  constructor(
    public readonly owner: string,
    public readonly name: string,
    public readonly git: BareRepo,
    public settings: RepoSettings,
  ) {}

  get full(): string {
    return `${this.owner}/${this.name}`;
  }
}

export function identityOf(user: User, date?: string): Identity {
  return { name: user.name, email: user.email, date };
}

export function defaultSettings(): RepoSettings {
  return {
    default_branch: 'main',
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
    squash_merge_commit_message: 'COMMIT_MESSAGES',
    actions_can_create_prs: true,
    immutable_releases: false,
    restrict_tag_creation: null,
    protected_branches: [],
    commit_pr_index_lag_ms: 0,
  };
}

export class Model {
  users = new Map<string, User>();
  tokens = new Map<string, Token>();
  repos = new Map<string, Repo>();
  events: SimEvent[] = [];
  private listeners: Array<(e: SimEvent) => void> = [];
  private nextUserId = 100;
  private seq = 0;
  /** When true, changes emit no events (used while seeding a scenario). */
  quiet = false;
  /** Public base URL of the simulated host, set by the server once it listens. */
  baseUrl = 'http://127.0.0.1';
  /**
   * Simulated wall clock for commit and tag dates. Everything in a scenario
   * happens within milliseconds, while git stores dates in whole seconds and
   * `git log` orders by date; each event therefore advances the clock by a
   * minute so history has the distinct, increasing dates real history has.
   */
  private clockMs = Math.floor(Date.now() / 1000) * 1000 - 7 * 24 * 3600 * 1000;

  /** Advance the clock and return the new time. */
  tick(minutes = 1): string {
    this.clockMs += minutes * 60_000;
    return new Date(this.clockMs).toISOString();
  }

  get clockSeconds(): number {
    return Math.floor(this.clockMs / 1000);
  }

  constructor(public readonly root: string) {}

  // --- actors ---

  user(login: string, type: 'User' | 'Bot' = 'User'): User {
    let u = this.users.get(login);
    if (!u) {
      const id = this.nextUserId++;
      u = {
        login,
        id,
        type,
        name: login,
        email: `${id}+${login}@users.noreply.github.com`,
      };
      this.users.set(login, u);
    }
    return u;
  }

  mintToken(
    kind: TokenKind,
    actor: User,
    permissions: Record<string, Permission> = {},
    runId?: string,
  ): Token {
    const prefix = kind === 'pat' ? 'ghp_' : 'ghs_';
    const value = prefix + crypto.randomUUID().replaceAll('-', '');
    const token: Token = { value, kind, actor, permissions, runId };
    this.tokens.set(value, token);
    return token;
  }

  can(token: Token | null, scope: string, level: Permission): boolean {
    if (token === null) return true; // web UI user with write access
    if (token.revoked) return false;
    if (token.kind === 'pat') return true;
    const have = token.permissions[scope] ?? 'none';
    if (level === 'read') return have === 'read' || have === 'write';
    return have === 'write';
  }

  require(token: Token | null, scope: string, level: Permission): void {
    if (!this.can(token, scope, level)) {
      throw new ApiError(403, 'Resource not accessible by integration');
    }
  }

  // --- repositories ---

  async createRepo(
    owner: string,
    name: string,
    settings: Partial<RepoSettings> = {},
  ): Promise<Repo> {
    const dir = `${this.root}/${owner}/${name}.git`;
    const merged = { ...defaultSettings(), ...settings };
    const git = await BareRepo.init(dir, merged.default_branch);
    git.clock = () => this.tick();
    const repo = new Repo(owner, name, git, merged);
    this.repos.set(repo.full, repo);
    await this.writeRuleHook(repo);
    return repo;
  }

  repo(owner: string, name: string): Repo {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }

  /**
   * Install the pre-receive hook that enforces rulesets on git pushes.
   * The smart-HTTP layer passes the pusher's bypass kind in SIM_ACTOR_KIND.
   */
  async writeRuleHook(repo: Repo): Promise<void> {
    const rules = {
      tag: repo.settings.restrict_tag_creation
        ? {
          pattern: repo.settings.restrict_tag_creation.pattern.source,
          bypass: repo.settings.restrict_tag_creation.bypass,
        }
        : null,
      branches: repo.settings.protected_branches.map((b) => ({
        pattern: b.pattern.source,
        bypass: b.bypass,
      })),
      locked: [...repo.lockedTags],
    };
    await Deno.writeTextFile(`${repo.git.dir}/sim-rules.json`, JSON.stringify(rules));
    const hook = `#!/bin/sh
# Simulated GitHub rulesets. Generated by sim/github/model.ts.
exec "${Deno.execPath()}" run --allow-read --allow-env "${
      new URL('./pre_receive.ts', import.meta.url).pathname
    }" "$GIT_DIR/sim-rules.json"
`;
    await Deno.mkdir(`${repo.git.dir}/hooks`, { recursive: true });
    await Deno.writeTextFile(`${repo.git.dir}/hooks/pre-receive`, hook, { mode: 0o755 });
  }

  // --- events ---

  on(listener: (e: SimEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(
    repo: Repo,
    name: string,
    action: string | undefined,
    payload: Record<string, unknown>,
    cause: Cause,
  ): void {
    if (this.quiet) return;
    const event: SimEvent = {
      seq: ++this.seq,
      repo: repo.full,
      name,
      action,
      payload,
      cause,
      at: new Date().toISOString(),
    };
    this.events.push(event);
    for (const l of this.listeners) l(event);
  }

  // --- rules ---

  private kindOf(cause: Cause): TokenKind | 'web' {
    return cause.token ? cause.token.kind : 'web';
  }

  /** Throws if a ref change violates a ruleset. `viaMerge` marks GitHub's own merge. */
  checkRefRules(
    repo: Repo,
    ref: string,
    oldSha: string | null,
    newSha: string | null,
    cause: Cause,
    viaMerge = false,
  ): void {
    const kind = this.kindOf(cause);
    if (ref.startsWith('refs/tags/')) {
      const name = ref.slice('refs/tags/'.length);
      if (repo.lockedTags.has(name) && (oldSha !== null || newSha !== null)) {
        throw new ApiError(422, 'Cannot update this protected ref.', [
          {
            resource: 'Reference',
            code: 'custom',
            message: `tag ${name} is locked by an immutable release`,
          },
        ]);
      }
      const rule = repo.settings.restrict_tag_creation;
      if (rule && oldSha === null && rule.pattern.test(name) && !rule.bypass.includes(kind)) {
        throw new ApiError(
          422,
          'Repository rule violations found\n\nCannot create ref due to creations being restricted.',
        );
      }
    }
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      for (const rule of repo.settings.protected_branches) {
        if (!rule.pattern.test(name)) continue;
        const bypass = viaMerge ? rule.bypass.includes('merge') : rule.bypass.includes(kind);
        if (!bypass) {
          throw new ApiError(
            422,
            'Repository rule violations found\n\nChanges must be made through a pull request.',
          );
        }
      }
    }
  }

  // --- ref changes ---

  /**
   * Record that a ref moved (already applied to the git store) and emit what
   * GitHub emits: push, create, delete, and pull request side effects.
   */
  async refChanged(
    repo: Repo,
    ref: string,
    oldSha: string | null,
    newSha: string | null,
    cause: Cause,
  ): Promise<void> {
    const zero = '0'.repeat(40);
    const repository = this.repoPayload(repo);
    const sender = cause.actor;

    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length);
      if (oldSha === null && newSha !== null) {
        this.emit(repo, 'create', undefined, {
          ref: branch,
          ref_type: 'branch',
          repository,
          sender,
        }, cause);
      }
      if (newSha === null) {
        this.emit(repo, 'delete', undefined, {
          ref: branch,
          ref_type: 'branch',
          repository,
          sender,
        }, cause);
      }
      let forced = false;
      let commits: Array<Record<string, unknown>> = [];
      if (oldSha && newSha) {
        forced = !(await repo.git.isAncestor(oldSha, newSha));
        const shas = forced
          ? await repo.git.revList(newSha, undefined, ['--max-count=20'])
          : await repo.git.revList(newSha, oldSha, ['--max-count=2048']);
        commits = await this.commitPayloads(repo, shas.reverse());
      } else if (newSha) {
        commits = await this.commitPayloads(
          repo,
          (await repo.git.revList(newSha, undefined, ['--max-count=20'])).reverse(),
        );
      }
      this.emit(repo, 'push', undefined, {
        ref,
        before: oldSha ?? zero,
        after: newSha ?? zero,
        created: oldSha === null,
        deleted: newSha === null,
        forced,
        commits,
        head_commit: commits.length > 0 ? commits[commits.length - 1] : null,
        pusher: { name: sender.login, email: sender.email },
        repository,
        sender,
      }, cause);
      await this.syncPullRequests(repo, branch, newSha, cause);
    } else if (ref.startsWith('refs/tags/')) {
      const tag = ref.slice('refs/tags/'.length);
      if (oldSha === null && newSha !== null) {
        this.emit(
          repo,
          'create',
          undefined,
          { ref: tag, ref_type: 'tag', repository, sender },
          cause,
        );
      }
      if (newSha === null) {
        this.emit(
          repo,
          'delete',
          undefined,
          { ref: tag, ref_type: 'tag', repository, sender },
          cause,
        );
      }
      this.emit(repo, 'push', undefined, {
        ref,
        before: oldSha ?? zero,
        after: newSha ?? zero,
        created: oldSha === null,
        deleted: newSha === null,
        forced: false,
        commits: [],
        head_commit: null,
        pusher: { name: sender.login, email: sender.email },
        repository,
        sender,
      }, cause);
    }
  }

  private async commitPayloads(
    repo: Repo,
    shas: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const sha of shas) {
      const c = await repo.git.commit(sha);
      if (!c) continue;
      const files = c.parents.length > 0 ? await repo.git.changedFiles(c.parents[0], sha) : [];
      out.push({
        id: sha,
        tree_id: c.tree,
        message: c.message,
        timestamp: c.committer.date,
        author: { name: c.author.name, email: c.author.email },
        committer: { name: c.committer.name, email: c.committer.email },
        added: files.filter((f) => f.status === 'A').map((f) => f.filename),
        removed: files.filter((f) => f.status === 'D').map((f) => f.filename),
        modified: files.filter((f) => f.status === 'M').map((f) => f.filename),
      });
    }
    return out;
  }

  /** Apply GitHub's pull request side effects after a branch moved. */
  private async syncPullRequests(
    repo: Repo,
    branch: string,
    newSha: string | null,
    cause: Cause,
  ): Promise<void> {
    for (const pr of repo.prs.values()) {
      if (pr.state !== 'open') continue;
      if (pr.head.ref === branch) {
        if (newSha === null) {
          this.closePR(repo, pr, cause);
          continue;
        }
        const before = pr.head.sha;
        pr.head.sha = newSha;
        pr.updated_at = new Date().toISOString();
        await repo.git.updateRef(`refs/pull/${pr.number}/head`, newSha);
        const baseTip = await repo.git.commitSha(`refs/heads/${pr.base.ref}`);
        if (baseTip && await repo.git.isAncestor(newSha, baseTip)) {
          // Head has no commits that base lacks: GitHub closes the PR.
          this.closePR(repo, pr, cause);
          continue;
        }
        this.emit(repo, 'pull_request', 'synchronize', {
          number: pr.number,
          before,
          after: newSha,
          pull_request: this.prPayload(repo, pr),
          repository: this.repoPayload(repo),
          sender: cause.actor,
        }, cause);
      } else if (pr.base.ref === branch && newSha) {
        pr.base.sha = newSha;
        if (await repo.git.isAncestor(pr.head.sha, newSha)) {
          // Head became reachable from base outside the merge button.
          pr.merged = true;
          pr.merged_at = new Date().toISOString();
          pr.merged_by = cause.actor;
          this.closePR(repo, pr, cause);
        }
      }
    }
  }

  private closePR(repo: Repo, pr: PullRequest, cause: Cause): void {
    pr.state = 'closed';
    pr.closed_at = new Date().toISOString();
    pr.updated_at = pr.closed_at;
    this.emit(repo, 'pull_request', 'closed', {
      number: pr.number,
      pull_request: this.prPayload(repo, pr),
      repository: this.repoPayload(repo),
      sender: cause.actor,
    }, cause);
  }

  /** Move a ref through the API or UI: rules, store, then events. */
  async setRef(
    repo: Repo,
    ref: string,
    newSha: string | null,
    cause: Cause,
    opts: { force?: boolean; viaMerge?: boolean } = {},
  ): Promise<void> {
    const oldSha = await repo.git.refSha(ref);
    this.checkRefRules(repo, ref, oldSha, newSha, cause, opts.viaMerge);
    if (newSha === null) {
      if (oldSha === null) throw new ApiError(422, 'Reference does not exist');
      await repo.git.deleteRef(ref);
    } else {
      if (oldSha && ref.startsWith('refs/heads/') && !opts.force) {
        const oldCommit = await repo.git.commitSha(oldSha);
        if (oldCommit && !(await repo.git.isAncestor(oldCommit, newSha))) {
          throw new ApiError(422, 'Update is not a fast forward');
        }
      }
      await repo.git.updateRef(ref, newSha);
    }
    await this.refChanged(repo, ref, oldSha, newSha, cause);
  }

  // --- pull requests ---

  async createPR(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string; draft?: boolean },
    cause: Cause,
  ): Promise<PullRequest> {
    this.require(cause.token, 'pull_requests', 'write');
    if (cause.token?.kind === 'actions' && !repo.settings.actions_can_create_prs) {
      throw new ApiError(
        403,
        'GitHub Actions is not permitted to create or approve pull requests.',
      );
    }
    const headRef = input.head.includes(':') ? input.head.split(':')[1] : input.head;
    const headSha = await repo.git.commitSha(`refs/heads/${headRef}`);
    const baseSha = await repo.git.commitSha(`refs/heads/${input.base}`);
    const invalid = (field: string) =>
      new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', field, code: 'invalid' }]);
    if (!baseSha) throw invalid('base');
    if (!headSha) throw invalid('head');
    for (const pr of repo.prs.values()) {
      if (pr.state === 'open' && pr.head.ref === headRef && pr.base.ref === input.base) {
        throw new ApiError(422, 'Validation Failed', [{
          resource: 'PullRequest',
          code: 'custom',
          message: `A pull request already exists for ${repo.owner}:${headRef}.`,
        }]);
      }
    }
    if (await repo.git.isAncestor(headSha, baseSha)) {
      throw new ApiError(422, 'Validation Failed', [{
        resource: 'PullRequest',
        code: 'custom',
        message: `No commits between ${input.base} and ${headRef}`,
      }]);
    }
    const now = new Date().toISOString();
    const pr: PullRequest = {
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      draft: input.draft ?? false,
      merged: false,
      merged_at: null,
      merged_by: null,
      merge_commit_sha: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: input.base, sha: baseSha },
      user: cause.actor,
      labels: [],
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    repo.prs.set(pr.number, pr);
    await repo.git.updateRef(`refs/pull/${pr.number}/head`, headSha);
    this.emit(repo, 'pull_request', 'opened', {
      number: pr.number,
      pull_request: this.prPayload(repo, pr),
      repository: this.repoPayload(repo),
      sender: cause.actor,
    }, cause);
    return pr;
  }

  pr(repo: Repo, number: number): PullRequest {
    const pr = repo.prs.get(number);
    if (!pr) throw new ApiError(404, 'Not Found');
    return pr;
  }

  updatePR(
    repo: Repo,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string },
    cause: Cause,
  ): PullRequest {
    this.require(cause.token, 'pull_requests', 'write');
    const pr = this.pr(repo, number);
    const changes: Record<string, { from: string }> = {};
    if (patch.title !== undefined && patch.title !== pr.title) {
      changes.title = { from: pr.title };
      pr.title = patch.title;
    }
    if (patch.body !== undefined && patch.body !== pr.body) {
      changes.body = { from: pr.body };
      pr.body = patch.body;
    }
    pr.updated_at = new Date().toISOString();
    if (Object.keys(changes).length > 0) {
      this.emit(repo, 'pull_request', 'edited', {
        number: pr.number,
        changes,
        pull_request: this.prPayload(repo, pr),
        repository: this.repoPayload(repo),
        sender: cause.actor,
      }, cause);
    }
    if (patch.state === 'closed' && pr.state === 'open') this.closePR(repo, pr, cause);
    if (patch.state === 'open' && pr.state === 'closed' && !pr.merged) {
      pr.state = 'open';
      pr.closed_at = null;
      this.emit(repo, 'pull_request', 'reopened', {
        number: pr.number,
        pull_request: this.prPayload(repo, pr),
        repository: this.repoPayload(repo),
        sender: cause.actor,
      }, cause);
    }
    return pr;
  }

  /** Commits a PR would merge, oldest first. */
  async prCommits(repo: Repo, pr: PullRequest): Promise<string[]> {
    const tip = pr.merged && pr.state === 'closed'
      ? pr.base.sha
      : await repo.git.commitSha(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
    const base = await repo.git.mergeBase(tip, pr.head.sha) ?? pr.base.sha;
    return (await repo.git.revList(pr.head.sha, base)).reverse();
  }

  async mergePR(
    repo: Repo,
    number: number,
    input: { method?: MergeMethod; commit_title?: string; commit_message?: string; sha?: string },
    cause: Cause,
  ): Promise<{ sha: string }> {
    this.require(cause.token, 'contents', 'write');
    const pr = this.pr(repo, number);
    const method = input.method ?? 'merge';
    if (pr.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable');
    if (pr.draft) throw new ApiError(405, 'Pull Request is still a draft');
    const allowed = {
      merge: repo.settings.allow_merge_commit,
      squash: repo.settings.allow_squash_merge,
      rebase: repo.settings.allow_rebase_merge,
    }[method];
    if (!allowed) {
      throw new ApiError(
        405,
        `${method[0].toUpperCase()}${method.slice(1)} merges are not allowed on this repository.`,
      );
    }
    if (input.sha && input.sha !== pr.head.sha) {
      throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
    }
    const baseTip = await repo.git.commitSha(`refs/heads/${pr.base.ref}`);
    if (!baseTip) throw new ApiError(404, 'Not Found');
    const commits = await this.prCommits(repo, pr);
    const merger = identityOf(cause.actor);
    let newTip: string;
    const landed: string[] = [];

    if (method === 'rebase') {
      newTip = baseTip;
      for (const sha of commits) {
        const c = await repo.git.commit(sha);
        if (!c || c.parents.length !== 1) continue; // merge commits are dropped by rebase
        const tree = await repo.git.mergeTrees(newTip, sha, c.parents[0]);
        if (!tree) throw new ApiError(405, 'Pull Request is not mergeable');
        newTip = await repo.git.writeCommit(tree, [newTip], c.message, c.author, merger);
        landed.push(newTip);
      }
    } else {
      const tree = await repo.git.mergeTrees(baseTip, pr.head.sha);
      if (!tree) throw new ApiError(405, 'Pull Request is not mergeable');
      if (method === 'merge') {
        const title = input.commit_title ??
          `Merge pull request #${pr.number} from ${repo.owner}/${pr.head.ref}`;
        const body = input.commit_message ?? pr.title;
        newTip = await repo.git.writeCommit(
          tree,
          [baseTip, pr.head.sha],
          body ? `${title}\n\n${body}` : title,
          merger,
          GITHUB_WEB_FLOW,
        );
      } else {
        const infos = [];
        for (const sha of commits) {
          const c = await repo.git.commit(sha);
          if (c && c.parents.length === 1) infos.push(c);
        }
        const single = infos.length === 1;
        const subject = (m: string) => m.split('\n')[0];
        const bodyOf = (m: string) => m.split('\n').slice(1).join('\n').trim();
        let title = input.commit_title;
        if (title === undefined) {
          const base = repo.settings.squash_merge_commit_title === 'COMMIT_OR_PR_TITLE' && single
            ? subject(infos[0].message)
            : pr.title;
          title = `${base} (#${pr.number})`;
        }
        let body = input.commit_message;
        if (body === undefined) {
          switch (repo.settings.squash_merge_commit_message) {
            case 'PR_BODY':
              body = pr.body;
              break;
            case 'BLANK':
              body = '';
              break;
            default:
              body = single ? bodyOf(infos[0].message) : infos.map((c) => {
                const b = bodyOf(c.message);
                return b ? `* ${subject(c.message)}\n\n${b}` : `* ${subject(c.message)}`;
              }).join('\n\n');
          }
        }
        newTip = await repo.git.writeCommit(
          tree,
          [baseTip],
          body ? `${title}\n\n${body}` : title,
          identityOf(pr.user),
          GITHUB_WEB_FLOW,
        );
      }
      repo.verified.add(newTip);
      landed.push(newTip);
    }

    const visibleAt = Date.now() + repo.settings.commit_pr_index_lag_ms;
    for (const sha of landed) repo.commitPrIndex.set(sha, { prs: [pr.number], visibleAt });
    if (method === 'merge') {
      // A merge commit keeps the pull request's own commits in the base history.
      for (const sha of commits) repo.commitPrIndex.set(sha, { prs: [pr.number], visibleAt });
    }

    pr.merged = true;
    pr.merged_at = new Date().toISOString();
    pr.merged_by = cause.actor;
    pr.merge_commit_sha = newTip;
    pr.base.sha = baseTip;
    pr.state = 'closed';
    pr.closed_at = pr.merged_at;
    pr.updated_at = pr.merged_at;

    await this.setRef(repo, `refs/heads/${pr.base.ref}`, newTip, cause, { viaMerge: true });
    this.emit(repo, 'pull_request', 'closed', {
      number: pr.number,
      pull_request: this.prPayload(repo, pr),
      repository: this.repoPayload(repo),
      sender: cause.actor,
    }, cause);
    if (repo.settings.delete_branch_on_merge) {
      await this.setRef(repo, `refs/heads/${pr.head.ref}`, null, cause).catch(() => {});
    }
    return { sha: newTip };
  }

  /** PR numbers associated with a commit, honouring the index lag. */
  pullsForCommit(repo: Repo, sha: string): PullRequest[] {
    const out: PullRequest[] = [];
    const entry = repo.commitPrIndex.get(sha);
    if (entry && Date.now() >= entry.visibleAt) {
      for (const n of entry.prs) {
        const pr = repo.prs.get(n);
        if (pr) out.push(pr);
      }
    }
    for (const pr of repo.prs.values()) {
      if (pr.head.sha === sha && !out.includes(pr)) out.push(pr);
    }
    return out;
  }

  // --- releases ---

  async createRelease(
    repo: Repo,
    input: {
      tag_name: string;
      name?: string | null;
      body?: string | null;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
    },
    cause: Cause,
  ): Promise<Release> {
    this.require(cause.token, 'contents', 'write');
    if (!input.tag_name) {
      throw new ApiError(422, 'Validation Failed', [{
        resource: 'Release',
        code: 'missing_field',
        field: 'tag_name',
      }]);
    }
    const draft = input.draft ?? false;
    if (repo.releases.some((r) => r.tag_name === input.tag_name && !r.draft)) {
      throw new ApiError(422, 'Validation Failed', [
        { resource: 'Release', code: 'already_exists', field: 'tag_name' },
      ]);
    }
    const target = input.target_commitish ?? repo.settings.default_branch;
    const now = new Date().toISOString();
    const release: Release = {
      id: repo.nextId++,
      tag_name: input.tag_name,
      name: input.name ?? null,
      body: input.body ?? null,
      draft,
      prerelease: input.prerelease ?? false,
      target_commitish: target,
      author: cause.actor,
      created_at: now,
      published_at: null,
      immutable: false,
    };
    if (!draft) await this.publishRelease(repo, release, cause, true);
    repo.releases.push(release);
    this.emit(repo, 'release', 'created', this.releaseEventPayload(repo, release, cause), cause);
    if (!draft) this.emitPublished(repo, release, cause);
    return release;
  }

  private async publishRelease(
    repo: Repo,
    release: Release,
    cause: Cause,
    creating: boolean,
  ): Promise<void> {
    const ref = `refs/tags/${release.tag_name}`;
    const existing = await repo.git.refSha(ref);
    if (!existing) {
      const target = await repo.git.commitSha(release.target_commitish) ??
        await repo.git.commitSha(`refs/heads/${release.target_commitish}`);
      if (!target) {
        throw new ApiError(422, 'Validation Failed', [
          { resource: 'Release', code: 'invalid', field: 'target_commitish' },
        ]);
      }
      try {
        await this.setRef(repo, ref, target, cause);
      } catch (e) {
        if (e instanceof ApiError && creating) {
          throw new ApiError(422, 'Validation Failed', [{
            resource: 'Release',
            code: 'custom',
            field: 'pre_receive',
            message: e.message,
          }]);
        }
        throw e;
      }
    }
    release.published_at = new Date().toISOString();
    if (repo.settings.immutable_releases) {
      release.immutable = true;
      repo.lockedTags.add(release.tag_name);
      await this.writeRuleHook(repo);
    }
  }

  private emitPublished(repo: Repo, release: Release, cause: Cause): void {
    const payload = this.releaseEventPayload(repo, release, cause);
    this.emit(repo, 'release', 'published', payload, cause);
    this.emit(repo, 'release', release.prerelease ? 'prereleased' : 'released', payload, cause);
  }

  async updateRelease(
    repo: Repo,
    id: number,
    patch: Partial<Pick<Release, 'name' | 'body' | 'draft' | 'prerelease' | 'tag_name'>>,
    cause: Cause,
  ): Promise<Release> {
    this.require(cause.token, 'contents', 'write');
    const release = repo.releases.find((r) => r.id === id);
    if (!release) throw new ApiError(404, 'Not Found');
    if (release.immutable && patch.tag_name && patch.tag_name !== release.tag_name) {
      throw new ApiError(422, 'Validation Failed', [
        {
          resource: 'Release',
          code: 'custom',
          message: 'tag_name cannot be changed on an immutable release',
        },
      ]);
    }
    if (patch.name !== undefined) release.name = patch.name;
    if (patch.body !== undefined) release.body = patch.body;
    if (patch.prerelease !== undefined) release.prerelease = patch.prerelease;
    if (patch.tag_name !== undefined) release.tag_name = patch.tag_name;
    if (patch.draft === false && release.draft) {
      await this.publishRelease(repo, release, cause, false);
      release.draft = false;
      this.emitPublished(repo, release, cause);
    }
    this.emit(repo, 'release', 'edited', this.releaseEventPayload(repo, release, cause), cause);
    return release;
  }

  deleteRelease(repo: Repo, id: number, cause: Cause): void {
    this.require(cause.token, 'contents', 'write');
    const i = repo.releases.findIndex((r) => r.id === id);
    if (i < 0) throw new ApiError(404, 'Not Found');
    const [release] = repo.releases.splice(i, 1);
    this.emit(repo, 'release', 'deleted', this.releaseEventPayload(repo, release, cause), cause);
  }

  // --- payload shapes shared by events and REST ---

  repoPayload(repo: Repo): Record<string, unknown> {
    const web = `${this.baseUrl}/${repo.full}`;
    return {
      id: 1,
      node_id: `R_${repo.full}`,
      name: repo.name,
      full_name: repo.full,
      private: false,
      owner: {
        login: repo.owner,
        id: 1,
        type: 'User',
        html_url: `${this.baseUrl}/${repo.owner}`,
        url: `${this.baseUrl}/users/${repo.owner}`,
      },
      default_branch: repo.settings.default_branch,
      html_url: web,
      url: `${this.baseUrl}/repos/${repo.full}`,
      clone_url: `${web}.git`,
      git_url: `git://127.0.0.1/${repo.full}.git`,
      ssh_url: `git@127.0.0.1:${repo.full}.git`,
      description: null,
      fork: false,
      visibility: 'public',
    };
  }

  prPayload(repo: Repo, pr: PullRequest): Record<string, unknown> {
    const side = (ref: string, sha: string) => ({
      label: `${repo.owner}:${ref}`,
      ref,
      sha,
      user: { login: repo.owner },
      repo: this.repoPayload(repo),
    });
    return {
      number: pr.number,
      state: pr.state,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      merged: pr.merged,
      merged_at: pr.merged_at,
      merged_by: pr.merged_by,
      merge_commit_sha: pr.merge_commit_sha,
      user: pr.user,
      labels: pr.labels.map((name) => ({ name })),
      head: side(pr.head.ref, pr.head.sha),
      base: side(pr.base.ref, pr.base.sha),
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      closed_at: pr.closed_at,
    };
  }

  private releaseEventPayload(repo: Repo, release: Release, cause: Cause): Record<string, unknown> {
    return { release: { ...release }, repository: this.repoPayload(repo), sender: cause.actor };
  }
}
