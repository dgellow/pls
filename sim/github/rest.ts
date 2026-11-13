/**
 * REST API of the simulated GitHub.
 *
 * Implements the endpoints release tools use, with the status codes, error
 * bodies and field names of api.github.com. Anything not implemented answers
 * 404 and is flagged in the call log, so a run that needed a missing endpoint
 * is reported as a simulator gap rather than as tool behaviour.
 */

import type { CommitInfo, Identity } from './git.ts';
import { ApiError, identityOf, type PullRequest, type Release, type Repo } from './model.ts';
import type { RequestContext } from './server.ts';
import { completeResponse } from './shape.ts';

type Handler = (ctx: RequestContext, repo: Repo, params: string[]) => Promise<Response> | Response;

const ACTIONS_BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

async function readJson(ctx: RequestContext): Promise<Record<string, unknown>> {
  const text = await ctx.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
}

function toBase64(bytes: Uint8Array, wrap = false): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(bin);
  return wrap ? (b64.match(/.{1,60}/g) ?? []).join('\n') + '\n' : b64;
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function paginate<T>(
  ctx: RequestContext,
  items: T[],
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Number(ctx.url.searchParams.get('per_page') ?? 30));
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') ?? 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const link = (p: number, rel: string) => {
    const u = new URL(ctx.url);
    u.searchParams.set('page', String(p));
    links.push(`<${ctx.baseUrl}${u.pathname}${u.search}>; rel="${rel}"`);
  };
  if (start + perPage < items.length) {
    link(page + 1, 'next');
    link(Math.ceil(items.length / perPage), 'last');
  }
  if (page > 1) link(page - 1, 'prev');
  if (links.length > 0) headers.link = links.join(', ');
  return { page: slice, headers };
}

// --- serializers ---

function api(ctx: RequestContext, repo: Repo): string {
  return `${ctx.baseUrl}/repos/${repo.full}`;
}

function html(ctx: RequestContext, repo: Repo): string {
  return `${ctx.baseUrl}/${repo.full}`;
}

function gitCommitJson(ctx: RequestContext, repo: Repo, c: CommitInfo): Record<string, unknown> {
  return {
    sha: c.sha,
    node_id: `C_${c.sha.slice(0, 12)}`,
    url: `${api(ctx, repo)}/git/commits/${c.sha}`,
    html_url: `${html(ctx, repo)}/commit/${c.sha}`,
    author: c.author,
    committer: c.committer,
    tree: { sha: c.tree, url: `${api(ctx, repo)}/git/trees/${c.tree}` },
    message: c.message,
    parents: c.parents.map((sha) => ({
      sha,
      url: `${api(ctx, repo)}/git/commits/${sha}`,
      html_url: `${html(ctx, repo)}/commit/${sha}`,
    })),
    verification: repo.verified.has(c.sha)
      ? { verified: true, reason: 'valid' }
      : { verified: false, reason: 'unsigned' },
  };
}

async function repoCommitJson(
  ctx: RequestContext,
  repo: Repo,
  c: CommitInfo,
  withFiles: boolean,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    sha: c.sha,
    node_id: `C_${c.sha.slice(0, 12)}`,
    url: `${api(ctx, repo)}/commits/${c.sha}`,
    html_url: `${html(ctx, repo)}/commit/${c.sha}`,
    commit: {
      url: `${api(ctx, repo)}/git/commits/${c.sha}`,
      author: c.author,
      committer: c.committer,
      message: c.message,
      tree: { sha: c.tree, url: `${api(ctx, repo)}/git/trees/${c.tree}` },
      verification: repo.verified.has(c.sha)
        ? { verified: true, reason: 'valid' }
        : { verified: false, reason: 'unsigned' },
    },
    author: { login: c.author.name, type: 'User' },
    committer: { login: c.committer.name, type: 'User' },
    parents: c.parents.map((sha) => ({ sha, url: `${api(ctx, repo)}/commits/${sha}` })),
  };
  if (withFiles) {
    out.files = c.parents.length > 0 ? await diffEntries(ctx, repo, c.parents[0], c.sha) : [];
  }
  return out;
}

/** Changed files in the shape of the spec's diff-entry. */
async function diffEntries(
  ctx: RequestContext,
  repo: Repo,
  from: string,
  to: string,
): Promise<Array<Record<string, unknown>>> {
  const names: Record<string, string> = {
    A: 'added',
    M: 'modified',
    D: 'removed',
    R: 'renamed',
    C: 'copied',
    T: 'changed',
  };
  const out = [];
  for (const f of await repo.git.changedFiles(from, to)) {
    const entry = await repo.git.entryAt(to, f.filename) ??
      await repo.git.entryAt(from, f.filename);
    out.push({
      sha: entry?.sha ?? '0'.repeat(40),
      filename: f.filename,
      status: names[f.status[0]] ?? 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
      blob_url: `${html(ctx, repo)}/blob/${to}/${f.filename}`,
      raw_url: `${html(ctx, repo)}/raw/${to}/${f.filename}`,
      contents_url: `${api(ctx, repo)}/contents/${f.filename}?ref=${to}`,
    });
  }
  return out;
}

async function refJson(
  ctx: RequestContext,
  repo: Repo,
  ref: string,
  sha: string,
): Promise<Record<string, unknown>> {
  const type = await repo.git.objectType(sha) ?? 'commit';
  return {
    ref,
    node_id: `REF_${ref}`,
    url: `${api(ctx, repo)}/git/${ref}`,
    object: { sha, type, url: `${api(ctx, repo)}/git/${type}s/${sha}` },
  };
}

function prJson(ctx: RequestContext, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    ...ctx.model.prPayload(repo, pr),
    id: 100000 + pr.number,
    node_id: `PR_${pr.number}`,
    url: `${api(ctx, repo)}/pulls/${pr.number}`,
    html_url: `${html(ctx, repo)}/pull/${pr.number}`,
    issue_url: `${api(ctx, repo)}/issues/${pr.number}`,
    mergeable: pr.state === 'open' ? true : null,
    mergeable_state: pr.state === 'open' ? 'clean' : 'unknown',
    author_association: 'CONTRIBUTOR',
    maintainer_can_modify: false,
  };
}

function releaseJson(ctx: RequestContext, repo: Repo, r: Release): Record<string, unknown> {
  return {
    id: r.id,
    node_id: `RE_${r.id}`,
    tag_name: r.tag_name,
    name: r.name,
    body: r.body,
    draft: r.draft,
    prerelease: r.prerelease,
    immutable: r.immutable,
    target_commitish: r.target_commitish,
    author: r.author,
    created_at: r.created_at,
    published_at: r.published_at,
    url: `${api(ctx, repo)}/releases/${r.id}`,
    html_url: r.draft
      ? `${html(ctx, repo)}/releases/tag/untagged-${r.id}`
      : `${html(ctx, repo)}/releases/tag/${r.tag_name}`,
    upload_url: `${ctx.baseUrl}/uploads/repos/${repo.full}/releases/${r.id}/assets{?name,label}`,
    assets: [],
  };
}

function labelJson(ctx: RequestContext, repo: Repo, name: string): Record<string, unknown> {
  let id = 0;
  for (const ch of name) id = (id * 31 + ch.charCodeAt(0)) % 1_000_000_007;
  return {
    id,
    node_id: `LA_${id}`,
    url: `${api(ctx, repo)}/labels/${encodeURIComponent(name)}`,
    name,
    color: 'ededed',
    default: false,
    description: null,
  };
}

function commentJson(
  ctx: RequestContext,
  repo: Repo,
  issue: number,
  c: { id: number; body: string; user: unknown; created_at: string },
): Record<string, unknown> {
  return {
    ...c,
    node_id: `IC_${c.id}`,
    url: `${api(ctx, repo)}/issues/comments/${c.id}`,
    html_url: `${html(ctx, repo)}/pull/${issue}#issuecomment-${c.id}`,
    issue_url: `${api(ctx, repo)}/issues/${issue}`,
    updated_at: c.created_at,
    author_association: 'CONTRIBUTOR',
  };
}

function issueJson(ctx: RequestContext, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    id: 200000 + pr.number,
    node_id: `I_${pr.number}`,
    url: `${api(ctx, repo)}/issues/${pr.number}`,
    repository_url: api(ctx, repo),
    user: pr.user,
    labels: pr.labels.map((name) => labelJson(ctx, repo, name)),
    comments: (repo.comments.get(pr.number) ?? []).length,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    html_url: `${html(ctx, repo)}/pull/${pr.number}`,
    pull_request: {
      url: `${api(ctx, repo)}/pulls/${pr.number}`,
      html_url: `${html(ctx, repo)}/pull/${pr.number}`,
      merged_at: pr.merged_at,
    },
  };
}

/** Identity GitHub attributes API-created git objects to when none is given. */
function defaultIdentity(ctx: RequestContext): Identity {
  if (ctx.token?.kind === 'actions') {
    return { name: 'github-actions[bot]', email: ACTIONS_BOT_EMAIL };
  }
  return identityOf(ctx.cause.actor);
}

async function requireCommit(repo: Repo, rev: string): Promise<CommitInfo> {
  const c = await repo.git.commit(rev);
  if (!c) throw new ApiError(404, 'Not Found');
  return c;
}

function setLabels(ctx: RequestContext, repo: Repo, pr: PullRequest, labels: string[]): void {
  const before = new Set(pr.labels);
  pr.labels = [...new Set(labels)];
  for (const l of pr.labels) repo.labels.add(l);
  const base = {
    number: pr.number,
    repository: ctx.model.repoPayload(repo),
    sender: ctx.cause.actor,
  };
  for (const l of pr.labels) {
    if (!before.has(l)) {
      ctx.model.emit(repo, 'pull_request', 'labeled', {
        ...base,
        label: { name: l },
        pull_request: ctx.model.prPayload(repo, pr),
      }, ctx.cause);
    }
  }
  for (const l of before) {
    if (!pr.labels.includes(l)) {
      ctx.model.emit(repo, 'pull_request', 'unlabeled', {
        ...base,
        label: { name: l },
        pull_request: ctx.model.prPayload(repo, pr),
      }, ctx.cause);
    }
  }
}

// --- routes under /repos/:owner/:repo ---

const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^$/, (ctx, repo) =>
    json({
      ...ctx.model.repoPayload(repo),
      html_url: html(ctx, repo),
      url: api(ctx, repo),
      clone_url: `${ctx.baseUrl}/${repo.full}.git`,
      allow_merge_commit: repo.settings.allow_merge_commit,
      allow_squash_merge: repo.settings.allow_squash_merge,
      allow_rebase_merge: repo.settings.allow_rebase_merge,
      delete_branch_on_merge: repo.settings.delete_branch_on_merge,
      permissions: {
        admin: false,
        push: ctx.model.can(ctx.token, 'contents', 'write'),
        pull: true,
      },
    })],

  // --- contents ---
  ['GET', /^\/contents\/(.*)$/, async (ctx, repo, [path]) => {
    const ref = ctx.url.searchParams.get('ref') ?? repo.settings.default_branch;
    const rev = await repo.git.commitSha(ref) ?? await repo.git.commitSha(`refs/heads/${ref}`);
    if (!rev) throw new ApiError(404, `No commit found for the ref ${ref}`);
    const clean = decodeURIComponent(path).replace(/^\/+|\/+$/g, '');
    const entry = clean ? await repo.git.entryAt(rev, clean) : null;
    if (clean && !entry) throw new ApiError(404, 'Not Found');
    if (!entry || entry.type === 'tree') {
      const entries = await repo.git.tree(clean ? `${rev}:${clean}` : rev) ?? [];
      return json(entries.map((e) => {
        const full = clean ? `${clean}/${e.path}` : e.path;
        const self = `${api(ctx, repo)}/contents/${full}?ref=${ref}`;
        const kind = e.type === 'tree' ? 'tree' : 'blob';
        return {
          type: e.type === 'tree' ? 'dir' : e.type === 'commit' ? 'submodule' : 'file',
          name: e.path,
          path: full,
          sha: e.sha,
          size: e.size ?? 0,
          url: self,
          git_url: `${api(ctx, repo)}/git/${kind}s/${e.sha}`,
          html_url: `${html(ctx, repo)}/${kind}/${ref}/${full}`,
          download_url: e.type === 'blob' ? `${ctx.baseUrl}/raw/${repo.full}/${rev}/${full}` : null,
          _links: {
            self,
            git: `${api(ctx, repo)}/git/${kind}s/${e.sha}`,
            html: `${html(ctx, repo)}/${kind}/${ref}/${full}`,
          },
        };
      }));
    }
    const bytes = await repo.git.blob(entry.sha) ?? new Uint8Array();
    const accept = ctx.req.headers.get('accept') ?? '';
    if (
      accept.includes('application/vnd.github.raw') ||
      accept.includes('application/vnd.github.v3.raw')
    ) {
      return new Response(bytes as unknown as BodyInit, {
        headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' },
      });
    }
    if (bytes.length > 100 * 1024 * 1024) {
      throw new ApiError(403, 'This API returns blobs up to 100 MB in size.', [
        { resource: 'Blob', field: 'data', code: 'too_large' },
      ]);
    }
    // Between 1 and 100 MB the JSON media type carries no content.
    const large = bytes.length > 1024 * 1024;
    return json({
      type: 'file',
      encoding: large ? 'none' : 'base64',
      size: bytes.length,
      name: clean.split('/').pop(),
      path: clean,
      content: large ? '' : toBase64(bytes, true),
      sha: entry.sha,
      url: `${api(ctx, repo)}/contents/${clean}?ref=${ref}`,
      git_url: `${api(ctx, repo)}/git/blobs/${entry.sha}`,
      html_url: `${html(ctx, repo)}/blob/${ref}/${clean}`,
      download_url: `${ctx.baseUrl}/raw/${repo.full}/${rev}/${clean}`,
    });
  }],
  ['PUT', /^\/contents\/(.*)$/, async (ctx, repo, [path]) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const branch = String(body.branch ?? repo.settings.default_branch);
    const tip = await repo.git.commitSha(`refs/heads/${branch}`);
    if (!tip) throw new ApiError(404, `Branch ${branch} not found`);
    const clean = decodeURIComponent(path);
    const existing = await repo.git.entryAt(tip, clean);
    if (existing && body.sha !== existing.sha) {
      throw new ApiError(409, `${clean} does not match ${body.sha ?? ''}`);
    }
    const blob = await repo.git.writeBlob(fromBase64(String(body.content ?? '')));
    const base = await requireCommit(repo, tip);
    const tree = await repo.git.writeTree(base.tree, [{
      path: clean,
      mode: existing?.mode ?? '100644',
      sha: blob,
    }]);
    const who = defaultIdentity(ctx);
    const sha = await repo.git.writeCommit(
      tree,
      [tip],
      String(body.message ?? `Update ${clean}`),
      who,
    );
    if (ctx.token && ctx.token.kind !== 'pat') repo.verified.add(sha);
    await ctx.model.setRef(repo, `refs/heads/${branch}`, sha, ctx.cause);
    return json({
      content: {
        name: clean.split('/').pop(),
        path: clean,
        sha: blob,
        size: (await repo.git.blob(blob))?.length ?? 0,
        type: 'file',
        url: `${api(ctx, repo)}/contents/${clean}?ref=${branch}`,
        html_url: `${html(ctx, repo)}/blob/${branch}/${clean}`,
        git_url: `${api(ctx, repo)}/git/blobs/${blob}`,
        download_url: `${ctx.baseUrl}/raw/${repo.full}/${branch}/${clean}`,
        _links: {
          self: `${api(ctx, repo)}/contents/${clean}?ref=${branch}`,
          git: `${api(ctx, repo)}/git/blobs/${blob}`,
          html: `${html(ctx, repo)}/blob/${branch}/${clean}`,
        },
      },
      commit: gitCommitJson(ctx, repo, await requireCommit(repo, sha)),
    }, existing ? 200 : 201);
  }],

  // --- git data ---
  ['POST', /^\/git\/blobs$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const content = String(body.content ?? '');
    const bytes = body.encoding === 'base64'
      ? fromBase64(content)
      : new TextEncoder().encode(content);
    const sha = await repo.git.writeBlob(bytes);
    return json({ sha, url: `${api(ctx, repo)}/git/blobs/${sha}` }, 201);
  }],
  ['GET', /^\/git\/blobs\/([0-9a-f]+)$/, async (ctx, repo, [sha]) => {
    const bytes = await repo.git.blob(sha);
    if (!bytes) throw new ApiError(404, 'Not Found');
    return json({
      sha,
      node_id: `B_${sha.slice(0, 12)}`,
      size: bytes.length,
      url: `${api(ctx, repo)}/git/blobs/${sha}`,
      content: toBase64(bytes, true),
      encoding: 'base64',
    });
  }],
  ['POST', /^\/git\/trees$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const items = (body.tree ?? []) as Array<Record<string, unknown>>;
    const changes: Array<{ path: string; mode: string; sha: string | null }> = [];
    for (const item of items) {
      let sha = item.sha === null ? null : (item.sha as string | undefined);
      if (sha === undefined) {
        if (typeof item.content !== 'string') {
          throw new ApiError(422, 'tree.sha or tree.content is required');
        }
        sha = await repo.git.writeBlob(new TextEncoder().encode(item.content));
      } else if (sha !== null && !(await repo.git.objectType(sha))) {
        throw new ApiError(422, `tree.sha ${sha} is not a valid blob`);
      }
      changes.push({ path: String(item.path), mode: String(item.mode ?? '100644'), sha });
    }
    let base: string | null = null;
    if (body.base_tree) {
      const type = await repo.git.objectType(String(body.base_tree));
      if (!type) throw new ApiError(422, 'base_tree is not a valid tree oid');
      base = String(body.base_tree);
    }
    const sha = await repo.git.writeTree(base, changes);
    const entries = await repo.git.tree(sha) ?? [];
    return json(
      { sha, url: `${api(ctx, repo)}/git/trees/${sha}`, tree: entries, truncated: false },
      201,
    );
  }],
  ['GET', /^\/git\/trees\/(.+)$/, async (ctx, repo, [treeish]) => {
    const recursive = ctx.url.searchParams.has('recursive');
    const rev = decodeURIComponent(treeish);
    const entries = await repo.git.tree(rev, recursive) ??
      await repo.git.tree(`refs/heads/${rev}`, recursive);
    if (!entries) throw new ApiError(404, 'Not Found');
    const sha = await repo.git.refSha(`${rev}^{tree}`) ??
      await repo.git.refSha(`refs/heads/${rev}^{tree}`);
    return json({
      sha,
      url: `${api(ctx, repo)}/git/trees/${sha}`,
      tree: entries.map((e) => ({ ...e, url: `${api(ctx, repo)}/git/${e.type}s/${e.sha}` })),
      truncated: false,
    });
  }],
  ['POST', /^\/git\/commits$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const parents = (body.parents ?? []) as string[];
    for (const p of parents) {
      if (!(await repo.git.commitSha(p))) throw new ApiError(422, `Parent ${p} is not a commit`);
    }
    if (await repo.git.objectType(String(body.tree)) !== 'tree') {
      throw new ApiError(422, 'Tree SHA is not a tree object');
    }
    const custom = body.author !== undefined || body.committer !== undefined;
    const author = (body.author as Identity | undefined) ?? defaultIdentity(ctx);
    const committer = (body.committer as Identity | undefined) ?? author;
    const sha = await repo.git.writeCommit(
      String(body.tree),
      parents,
      String(body.message ?? ''),
      author,
      committer,
    );
    // GitHub signs API commits made by Apps and the Actions bot when no custom identity is sent.
    if (!custom && ctx.token && ctx.token.kind !== 'pat') repo.verified.add(sha);
    return json(gitCommitJson(ctx, repo, await requireCommit(repo, sha)), 201);
  }],
  [
    'GET',
    /^\/git\/commits\/([0-9a-f]+)$/,
    async (ctx, repo, [sha]) => json(gitCommitJson(ctx, repo, await requireCommit(repo, sha))),
  ],
  ['POST', /^\/git\/tags$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const object = String(body.object);
    if (!(await repo.git.objectType(object))) throw new ApiError(422, 'Object does not exist');
    const tagger = (body.tagger as Identity | undefined) ?? defaultIdentity(ctx);
    const sha = await repo.git.writeTag(
      String(body.tag),
      object,
      String(body.type ?? 'commit'),
      String(body.message ?? ''),
      tagger,
    );
    return json({
      sha,
      node_id: `TAG_${sha.slice(0, 12)}`,
      url: `${api(ctx, repo)}/git/tags/${sha}`,
      tag: body.tag,
      message: body.message ?? '',
      tagger,
      object: {
        sha: object,
        type: body.type ?? 'commit',
        url: `${api(ctx, repo)}/git/commits/${object}`,
      },
      verification: { verified: false, reason: 'unsigned' },
    }, 201);
  }],
  ['GET', /^\/git\/tags\/([0-9a-f]+)$/, async (ctx, repo, [sha]) => {
    const tag = await repo.git.tagObject(sha);
    if (!tag) throw new ApiError(404, 'Not Found');
    return json({
      sha,
      node_id: `TAG_${sha.slice(0, 12)}`,
      url: `${api(ctx, repo)}/git/tags/${sha}`,
      tag: tag.tag,
      message: tag.message,
      tagger: {
        name: tag.tagger.replace(/ <.*$/, ''),
        email: (tag.tagger.match(/<(.*)>/) ?? [])[1] ?? '',
        date: new Date(Number((tag.tagger.match(/> (\d+)/) ?? [])[1] ?? 0) * 1000).toISOString(),
      },
      object: {
        sha: tag.object,
        type: tag.type,
        url: `${api(ctx, repo)}/git/${tag.type}s/${tag.object}`,
      },
      verification: { verified: false, reason: 'unsigned' },
    });
  }],
  ['GET', /^\/git\/ref\/(.+)$/, async (ctx, repo, [name]) => {
    const ref = `refs/${decodeURIComponent(name)}`;
    const sha = await repo.git.refSha(ref);
    // rev-parse also resolves partial names; the API only answers exact refs.
    if (!sha || !(await repo.git.refs(ref)).has(ref)) throw new ApiError(404, 'Not Found');
    return json(await refJson(ctx, repo, ref, sha));
  }],
  ['GET', /^\/git\/matching-refs\/(.+)$/, async (ctx, repo, [name]) => {
    const prefix = `refs/${decodeURIComponent(name)}`;
    // Prefix match on the ref name, as the API does (heads/feat matches heads/feature too).
    const all = new Map(
      [...(await repo.git.refs('refs/'))].filter(([ref]) => ref.startsWith(prefix)),
    );
    const out = [];
    for (const [ref, sha] of all) out.push(await refJson(ctx, repo, ref, sha));
    return json(out);
  }],
  ['POST', /^\/git\/refs$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const ref = String(body.ref ?? '');
    const sha = String(body.sha ?? '');
    if (!ref.startsWith('refs/') || ref.split('/').length < 3) {
      throw new ApiError(
        422,
        "Reference name must start with 'refs/' and have at least two slashes",
      );
    }
    if (!(await repo.git.objectType(sha))) throw new ApiError(422, 'Object does not exist');
    if (await repo.git.refSha(ref) && (await repo.git.refs(ref)).has(ref)) {
      throw new ApiError(422, 'Reference already exists');
    }
    await ctx.model.setRef(repo, ref, sha, ctx.cause);
    return json(await refJson(ctx, repo, ref, sha), 201);
  }],
  ['PATCH', /^\/git\/refs\/(.+)$/, async (ctx, repo, [name]) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const ref = `refs/${decodeURIComponent(name)}`;
    const body = await readJson(ctx);
    const sha = String(body.sha ?? '');
    if (!(await repo.git.refs(ref)).has(ref)) throw new ApiError(422, 'Reference does not exist');
    if (!(await repo.git.objectType(sha))) throw new ApiError(422, 'Object does not exist');
    await ctx.model.setRef(repo, ref, sha, ctx.cause, { force: body.force === true });
    return json(await refJson(ctx, repo, ref, sha));
  }],
  ['DELETE', /^\/git\/refs\/(.+)$/, async (ctx, repo, [name]) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    await ctx.model.setRef(repo, `refs/${decodeURIComponent(name)}`, null, ctx.cause);
    return new Response(null, { status: 204 });
  }],

  // --- commits, branches, tags, compare ---
  ['GET', /^\/branches\/(.+)$/, async (ctx, repo, [branch]) => {
    const name = decodeURIComponent(branch);
    const sha = await repo.git.commitSha(`refs/heads/${name}`);
    if (!sha) throw new ApiError(404, 'Branch not found');
    return json({
      name,
      commit: await repoCommitJson(ctx, repo, await requireCommit(repo, sha), false),
      protected: repo.settings.protected_branches.some((b) => b.pattern.test(name)),
    });
  }],
  ['GET', /^\/branches$/, async (ctx, repo) => {
    const refs = await repo.git.refs('refs/heads/');
    const all = [...refs].map(([ref, sha]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha, url: `${api(ctx, repo)}/commits/${sha}` },
      protected: false,
    }));
    const { page, headers } = paginate(ctx, all);
    return json(page, 200, headers);
  }],
  ['GET', /^\/commits$/, async (ctx, repo) => {
    const from = ctx.url.searchParams.get('sha') ?? repo.settings.default_branch;
    const tip = await repo.git.commitSha(from) ?? await repo.git.commitSha(`refs/heads/${from}`);
    if (!tip) throw new ApiError(404, 'Not Found');
    const { page, headers } = paginate(ctx, await repo.git.revList(tip));
    const out = [];
    for (const sha of page) {
      out.push(await repoCommitJson(ctx, repo, await requireCommit(repo, sha), false));
    }
    return json(out, 200, headers);
  }],
  [
    'GET',
    /^\/commits\/([^/]+)\/pulls$/,
    (ctx, repo, [sha]) =>
      json(ctx.model.pullsForCommit(repo, sha).map((pr) => prJson(ctx, repo, pr))),
  ],
  ['GET', /^\/commits\/(.+)$/, async (ctx, repo, [rev]) => {
    const name = decodeURIComponent(rev);
    const sha = await repo.git.commitSha(name) ?? await repo.git.commitSha(`refs/heads/${name}`);
    if (!sha) throw new ApiError(422, `No commit found for SHA: ${name}`);
    return json(await repoCommitJson(ctx, repo, await requireCommit(repo, sha), true));
  }],
  ['GET', /^\/tags$/, async (ctx, repo) => {
    const refs = await repo.git.refs('refs/tags/');
    const all = [];
    for (const [ref, raw] of [...refs].reverse()) {
      const sha = await repo.git.commitSha(raw) ?? raw;
      all.push({
        name: ref.slice('refs/tags/'.length),
        commit: { sha, url: `${api(ctx, repo)}/commits/${sha}` },
        node_id: `T_${ref}`,
      });
    }
    const { page, headers } = paginate(ctx, all);
    return json(page, 200, headers);
  }],
  ['GET', /^\/compare\/(.+)\.\.\.(.+)$/, async (ctx, repo, [a, b]) => {
    const resolve = async (r: string) =>
      await repo.git.commitSha(decodeURIComponent(r)) ??
        await repo.git.commitSha(`refs/heads/${decodeURIComponent(r)}`) ??
        await repo.git.commitSha(`refs/tags/${decodeURIComponent(r)}`);
    const base = await resolve(a);
    const head = await resolve(b);
    if (!base || !head) throw new ApiError(404, 'Not Found');
    const ahead = await repo.git.revList(head, base);
    const behind = await repo.git.revList(base, head);
    const mergeBase = await repo.git.mergeBase(base, head);
    const commits = [];
    for (const sha of ahead.reverse().slice(0, 250)) {
      commits.push(await repoCommitJson(ctx, repo, await requireCommit(repo, sha), false));
    }
    const status = ahead.length && behind.length
      ? 'diverged'
      : ahead.length
      ? 'ahead'
      : behind.length
      ? 'behind'
      : 'identical';
    return json({
      status,
      ahead_by: ahead.length,
      behind_by: behind.length,
      total_commits: ahead.length,
      merge_base_commit: mergeBase
        ? await repoCommitJson(ctx, repo, await requireCommit(repo, mergeBase), false)
        : null,
      commits,
      base_commit: await repoCommitJson(ctx, repo, await requireCommit(repo, base), false),
      url: `${api(ctx, repo)}/compare/${a}...${b}`,
      html_url: `${html(ctx, repo)}/compare/${a}...${b}`,
      files: mergeBase ? await diffEntries(ctx, repo, mergeBase, head) : [],
    });
  }],
  ['POST', /^\/merges$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const baseRef = `refs/heads/${body.base}`;
    const baseSha = await repo.git.commitSha(baseRef);
    const headSha = await repo.git.commitSha(String(body.head)) ??
      await repo.git.commitSha(`refs/heads/${body.head}`);
    if (!baseSha) throw new ApiError(404, 'Base does not exist');
    if (!headSha) throw new ApiError(404, 'Head does not exist');
    if (await repo.git.isAncestor(headSha, baseSha)) return new Response(null, { status: 204 });
    const tree = await repo.git.mergeTrees(baseSha, headSha);
    if (!tree) throw new ApiError(409, 'Merge conflict');
    const who = defaultIdentity(ctx);
    const message = String(body.commit_message ?? `Merge ${body.head} into ${body.base}`);
    const sha = await repo.git.writeCommit(tree, [baseSha, headSha], message, who);
    await ctx.model.setRef(repo, baseRef, sha, ctx.cause);
    return json(await repoCommitJson(ctx, repo, await requireCommit(repo, sha), false), 201);
  }],

  // --- pull requests ---
  ['GET', /^\/pulls$/, (ctx, repo) => {
    const q = ctx.url.searchParams;
    const state = q.get('state') ?? 'open';
    const head = q.get('head');
    const base = q.get('base');
    const sort = q.get('sort') ?? 'created';
    const direction = q.get('direction') ?? (sort === 'created' ? 'desc' : 'asc');
    let prs = [...repo.prs.values()].filter((pr) => state === 'all' || pr.state === state);
    if (head) {
      const [owner, ref] = head.includes(':') ? head.split(':') : [repo.owner, head];
      prs = prs.filter((pr) => owner === repo.owner && pr.head.ref === ref);
    }
    if (base) prs = prs.filter((pr) => pr.base.ref === base);
    const key = (pr: PullRequest) =>
      (sort === 'updated' ? pr.updated_at : pr.created_at) + String(pr.number).padStart(8, '0');
    prs.sort((x, y) => key(x) < key(y) ? -1 : 1);
    if (direction === 'desc') prs.reverse();
    const { page, headers } = paginate(ctx, prs);
    return json(page.map((pr) => prJson(ctx, repo, pr)), 200, headers);
  }],
  ['POST', /^\/pulls$/, async (ctx, repo) => {
    const body = await readJson(ctx);
    const pr = await ctx.model.createPR(repo, {
      title: String(body.title ?? ''),
      body: body.body === undefined || body.body === null ? '' : String(body.body),
      head: String(body.head ?? ''),
      base: String(body.base ?? ''),
      draft: body.draft === true,
    }, ctx.cause);
    return json(prJson(ctx, repo, pr), 201);
  }],
  [
    'GET',
    /^\/pulls\/(\d+)$/,
    async (ctx, repo, [n]) => {
      const pr = ctx.model.pr(repo, Number(n));
      const base = await repo.git.mergeBase(pr.base.sha, pr.head.sha) ?? pr.base.sha;
      return json({
        ...prJson(ctx, repo, pr),
        commits: (await ctx.model.prCommits(repo, pr)).length,
        changed_files: (await repo.git.changedFiles(base, pr.head.sha)).length,
        comments: (repo.comments.get(pr.number) ?? []).length,
      });
    },
  ],
  ['PATCH', /^\/pulls\/(\d+)$/, async (ctx, repo, [n]) => {
    const body = await readJson(ctx);
    const text = body.body === undefined ? undefined : String(body.body ?? '');
    if (text !== undefined && text.length > 65536) {
      throw new ApiError(422, 'Validation Failed', [
        {
          resource: 'PullRequest',
          code: 'custom',
          field: 'body',
          message: 'body is too long (maximum is 65536 characters)',
        },
      ]);
    }
    const pr = ctx.model.updatePR(repo, Number(n), {
      title: body.title === undefined ? undefined : String(body.title),
      body: text,
      state: body.state as 'open' | 'closed' | undefined,
    }, ctx.cause);
    return json(prJson(ctx, repo, pr));
  }],
  ['PUT', /^\/pulls\/(\d+)\/merge$/, async (ctx, repo, [n]) => {
    const body = await readJson(ctx);
    const result = await ctx.model.mergePR(repo, Number(n), {
      method: body.merge_method as 'merge' | 'squash' | 'rebase' | undefined,
      commit_title: body.commit_title as string | undefined,
      commit_message: body.commit_message as string | undefined,
      sha: body.sha as string | undefined,
    }, ctx.cause);
    return json({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }],
  ['GET', /^\/pulls\/(\d+)\/commits$/, async (ctx, repo, [n]) => {
    const pr = ctx.model.pr(repo, Number(n));
    const out = [];
    for (const sha of await ctx.model.prCommits(repo, pr)) {
      out.push(await repoCommitJson(ctx, repo, await requireCommit(repo, sha), false));
    }
    const { page, headers } = paginate(ctx, out);
    return json(page, 200, headers);
  }],
  ['GET', /^\/pulls\/(\d+)\/files$/, async (ctx, repo, [n]) => {
    const pr = ctx.model.pr(repo, Number(n));
    const base = await repo.git.mergeBase(pr.base.sha, pr.head.sha) ?? pr.base.sha;
    const { page, headers } = paginate(ctx, await diffEntries(ctx, repo, base, pr.head.sha));
    return json(page, 200, headers);
  }],

  // --- issues (pull requests seen as issues): labels and comments ---
  ['GET', /^\/issues$/, (ctx, repo) => {
    const q = ctx.url.searchParams;
    const state = q.get('state') ?? 'open';
    const labels = (q.get('labels') ?? '').split(',').filter((l) => l);
    const prs = [...repo.prs.values()]
      .filter((pr) => state === 'all' || pr.state === state)
      .filter((pr) => labels.every((l) => pr.labels.includes(l)))
      .reverse();
    const { page, headers } = paginate(ctx, prs);
    return json(page.map((pr) => issueJson(ctx, repo, pr)), 200, headers);
  }],
  [
    'GET',
    /^\/issues\/(\d+)$/,
    (ctx, repo, [n]) => json(issueJson(ctx, repo, ctx.model.pr(repo, Number(n)))),
  ],
  ['PATCH', /^\/issues\/(\d+)$/, async (ctx, repo, [n]) => {
    ctx.model.require(ctx.token, 'pull_requests', 'write');
    const body = await readJson(ctx);
    const pr = ctx.model.pr(repo, Number(n));
    if (Array.isArray(body.labels)) setLabels(ctx, repo, pr, body.labels.map(String));
    if (body.title !== undefined || body.body !== undefined || body.state !== undefined) {
      ctx.model.updatePR(repo, pr.number, {
        title: body.title as string | undefined,
        body: body.body as string | undefined,
        state: body.state as 'open' | 'closed' | undefined,
      }, ctx.cause);
    }
    return json(issueJson(ctx, repo, pr));
  }],
  [
    'GET',
    /^\/issues\/(\d+)\/labels$/,
    (ctx, repo, [n]) =>
      json(ctx.model.pr(repo, Number(n)).labels.map((name) => labelJson(ctx, repo, name))),
  ],
  ['POST', /^\/issues\/(\d+)\/labels$/, async (ctx, repo, [n]) => {
    ctx.model.require(ctx.token, 'pull_requests', 'write');
    const body = await readJson(ctx);
    const pr = ctx.model.pr(repo, Number(n));
    const add = (Array.isArray(body) ? body : (body.labels ?? [])) as string[];
    setLabels(ctx, repo, pr, [...pr.labels, ...add]);
    return json(pr.labels.map((name) => labelJson(ctx, repo, name)));
  }],
  ['PUT', /^\/issues\/(\d+)\/labels$/, async (ctx, repo, [n]) => {
    ctx.model.require(ctx.token, 'pull_requests', 'write');
    const body = await readJson(ctx);
    const pr = ctx.model.pr(repo, Number(n));
    setLabels(ctx, repo, pr, (Array.isArray(body) ? body : (body.labels ?? [])) as string[]);
    return json(pr.labels.map((name) => labelJson(ctx, repo, name)));
  }],
  ['DELETE', /^\/issues\/(\d+)\/labels\/(.+)$/, (ctx, repo, [n, label]) => {
    ctx.model.require(ctx.token, 'pull_requests', 'write');
    const pr = ctx.model.pr(repo, Number(n));
    const name = decodeURIComponent(label);
    if (!pr.labels.includes(name)) throw new ApiError(404, 'Label does not exist');
    setLabels(ctx, repo, pr, pr.labels.filter((l) => l !== name));
    return json(pr.labels.map((l) => labelJson(ctx, repo, l)));
  }],
  ['GET', /^\/issues\/(\d+)\/comments$/, (ctx, repo, [n]) => {
    const { page, headers } = paginate(ctx, repo.comments.get(Number(n)) ?? []);
    return json(page.map((c) => commentJson(ctx, repo, Number(n), c)), 200, headers);
  }],
  ['POST', /^\/issues\/(\d+)\/comments$/, async (ctx, repo, [n]) => {
    ctx.model.require(ctx.token, 'pull_requests', 'write');
    const body = await readJson(ctx);
    ctx.model.pr(repo, Number(n));
    const comment = {
      id: repo.nextId++,
      body: String(body.body ?? ''),
      user: ctx.cause.actor,
      created_at: new Date().toISOString(),
    };
    repo.comments.set(Number(n), [...(repo.comments.get(Number(n)) ?? []), comment]);
    return json(commentJson(ctx, repo, Number(n), comment), 201);
  }],
  ['GET', /^\/labels$/, (ctx, repo) => {
    const { page, headers } = paginate(
      ctx,
      [...repo.labels].map((name) => labelJson(ctx, repo, name)),
    );
    return json(page, 200, headers);
  }],
  ['GET', /^\/labels\/(.+)$/, (ctx, repo, [label]) => {
    const name = decodeURIComponent(label);
    if (!repo.labels.has(name)) throw new ApiError(404, 'Not Found');
    return json(labelJson(ctx, repo, name));
  }],
  ['POST', /^\/labels$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'pull_requests', 'write');
    const body = await readJson(ctx);
    const name = String(body.name ?? '');
    if (repo.labels.has(name)) {
      throw new ApiError(422, 'Validation Failed', [{
        resource: 'Label',
        code: 'already_exists',
        field: 'name',
      }]);
    }
    repo.labels.add(name);
    return json({ ...labelJson(ctx, repo, name), color: body.color ?? 'ededed' }, 201);
  }],

  // --- releases ---
  ['GET', /^\/releases$/, (ctx, repo) => {
    const visible = [...repo.releases].reverse()
      .filter((r) => !r.draft || ctx.model.can(ctx.token, 'contents', 'write'));
    const { page, headers } = paginate(ctx, visible);
    return json(page.map((r) => releaseJson(ctx, repo, r)), 200, headers);
  }],
  ['POST', /^\/releases$/, async (ctx, repo) => {
    const body = await readJson(ctx);
    const release = await ctx.model.createRelease(repo, {
      tag_name: String(body.tag_name ?? ''),
      name: body.name as string | undefined,
      body: body.body as string | undefined,
      draft: body.draft === true,
      prerelease: body.prerelease === true,
      target_commitish: body.target_commitish as string | undefined,
    }, ctx.cause);
    return json(releaseJson(ctx, repo, release), 201);
  }],
  ['POST', /^\/releases\/generate-notes$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    const tag = String(body.tag_name ?? '');
    const target = await repo.git.commitSha(`refs/tags/${tag}`) ??
      await repo.git.commitSha(String(body.target_commitish ?? repo.settings.default_branch)) ??
      await repo.git.commitSha(
        `refs/heads/${body.target_commitish ?? repo.settings.default_branch}`,
      );
    const prev = body.previous_tag_name
      ? await repo.git.commitSha(`refs/tags/${body.previous_tag_name}`)
      : null;
    const shas = target
      ? new Set(await repo.git.revList(target, prev ?? undefined))
      : new Set<string>();
    const lines = [...repo.prs.values()]
      .filter((pr) => pr.merged && pr.merge_commit_sha && shas.has(pr.merge_commit_sha))
      .map((pr) => `* ${pr.title} by @${pr.user.login} in ${html(ctx, repo)}/pull/${pr.number}`);
    const compare = body.previous_tag_name
      ? `\n\n**Full Changelog**: ${html(ctx, repo)}/compare/${body.previous_tag_name}...${tag}`
      : '';
    return json({ name: tag, body: `## What's Changed\n${lines.join('\n')}${compare}` });
  }],
  ['GET', /^\/releases\/latest$/, (ctx, repo) => {
    const latest = [...repo.releases].reverse().find((r) => !r.draft && !r.prerelease);
    if (!latest) throw new ApiError(404, 'Not Found');
    return json(releaseJson(ctx, repo, latest));
  }],
  ['GET', /^\/releases\/tags\/(.+)$/, (ctx, repo, [tag]) => {
    const name = decodeURIComponent(tag);
    const release = repo.releases.find((r) => r.tag_name === name && !r.draft);
    if (!release) throw new ApiError(404, 'Not Found');
    return json(releaseJson(ctx, repo, release));
  }],
  ['GET', /^\/releases\/(\d+)$/, (ctx, repo, [id]) => {
    const release = repo.releases.find((r) => r.id === Number(id));
    if (!release) throw new ApiError(404, 'Not Found');
    return json(releaseJson(ctx, repo, release));
  }],
  ['PATCH', /^\/releases\/(\d+)$/, async (ctx, repo, [id]) => {
    const body = await readJson(ctx);
    const release = await ctx.model.updateRelease(repo, Number(id), body, ctx.cause);
    return json(releaseJson(ctx, repo, release));
  }],
  ['DELETE', /^\/releases\/(\d+)$/, (ctx, repo, [id]) => {
    ctx.model.deleteRelease(repo, Number(id), ctx.cause);
    return new Response(null, { status: 204 });
  }],

  // --- dispatch ---
  ['POST', /^\/dispatches$/, async (ctx, repo) => {
    ctx.model.require(ctx.token, 'contents', 'write');
    const body = await readJson(ctx);
    ctx.model.emit(repo, 'repository_dispatch', String(body.event_type ?? ''), {
      action: body.event_type,
      client_payload: body.client_payload ?? {},
      repository: ctx.model.repoPayload(repo),
      sender: ctx.cause.actor,
    }, ctx.cause);
    return new Response(null, { status: 204 });
  }],
  ['POST', /^\/actions\/workflows\/([^/]+)\/dispatches$/, async (ctx, repo, [workflow]) => {
    ctx.model.require(ctx.token, 'actions', 'write');
    const body = await readJson(ctx);
    ctx.model.emit(repo, 'workflow_dispatch', undefined, {
      workflow: decodeURIComponent(workflow),
      ref: body.ref ?? repo.settings.default_branch,
      inputs: body.inputs ?? {},
      repository: ctx.model.repoPayload(repo),
      sender: ctx.cause.actor,
    }, ctx.cause);
    return new Response(null, { status: 204 });
  }],
];

function searchIssues(ctx: RequestContext): Response {
  const q = ctx.url.searchParams.get('q') ?? '';
  const terms = q.split(/\s+/).filter((t) => t);
  const repoTerm = terms.find((t) => t.startsWith('repo:'));
  if (!repoTerm) throw new ApiError(422, 'Validation Failed');
  const [owner, name] = repoTerm.slice(5).split('/');
  const repo = ctx.model.repo(owner, name);
  const free = terms.filter((t) => !t.includes(':'));
  const has = (t: string) => terms.includes(t);
  const labels = terms.filter((t) => t.startsWith('label:')).map((t) =>
    t.slice(6).replaceAll('"', '')
  );
  const matches = [...repo.prs.values()].filter((pr) => {
    if (has('is:merged') && !pr.merged) return false;
    if (has('is:open') && pr.state !== 'open') return false;
    if (has('is:closed') && pr.state !== 'closed') return false;
    if (!labels.every((l) => pr.labels.includes(l))) return false;
    if (free.length === 0) return true;
    // GitHub matches free terms that look like SHAs against commits of the PR.
    const shas = [pr.head.sha, pr.merge_commit_sha ?? ''];
    for (const [sha, entry] of repo.commitPrIndex) {
      if (entry.prs.includes(pr.number) && Date.now() >= entry.visibleAt) shas.push(sha);
    }
    return free.some((t) =>
      shas.some((s) => s.startsWith(t)) || pr.title.includes(t) || pr.body.includes(t)
    );
  });
  const { page, headers } = paginate(ctx, matches);
  return json(
    {
      total_count: matches.length,
      incomplete_results: false,
      items: page.map((pr) => issueJson(ctx, repo, pr)),
    },
    200,
    headers,
  );
}

/** Fill a JSON response to the shape the OpenAPI description gives for this operation. */
async function shaped(ctx: RequestContext, res: Response): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json') || res.status === 204) {
    return res;
  }
  const body = await res.json();
  // SIM_RAW_RESPONSES=1 returns what the handlers produce, for the conformance report.
  if (Deno.env.get('SIM_RAW_RESPONSES') === '1') {
    return Response.json(body, { status: res.status, headers: res.headers });
  }
  const done = completeResponse(ctx.method, ctx.path, res.status, body, ctx.baseUrl);
  return Response.json(done, { status: res.status, headers: res.headers });
}

export async function handleRest(ctx: RequestContext): Promise<Response> {
  if (ctx.method === 'GET' && ctx.path === '/user') {
    if (!ctx.token) throw new ApiError(401, 'Requires authentication');
    if (ctx.token.kind !== 'pat') throw new ApiError(403, 'Resource not accessible by integration');
    ctx.route = 'GET /user';
    const actor = ctx.token.actor;
    return await shaped(
      ctx,
      json({
        ...actor,
        url: `${ctx.baseUrl}/users/${actor.login}`,
        html_url: `${ctx.baseUrl}/${actor.login}`,
      }),
    );
  }
  if (ctx.method === 'GET' && ctx.path === '/rate_limit') {
    ctx.route = 'GET /rate_limit';
    const core = {
      limit: 5000,
      remaining: 4999,
      reset: Math.floor(Date.now() / 1000) + 3600,
      used: 1,
    };
    return await shaped(
      ctx,
      json({ resources: { core, graphql: core, search: core }, rate: core }),
    );
  }
  if (ctx.method === 'GET' && ctx.path === '/search/issues') {
    ctx.route = 'GET /search/issues';
    return await shaped(ctx, searchIssues(ctx));
  }

  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(ctx.path);
  if (m) {
    const [, owner, name, rest = ''] = m;
    const repo = ctx.model.repo(owner, name);
    for (const [method, pattern, handler] of routes) {
      if (method !== ctx.method) continue;
      const match = pattern.exec(rest);
      if (!match) continue;
      ctx.route = `${method} /repos/{owner}/{repo}${
        pattern.source.replace(/\\\//g, '/').replace(/^\^|\$$/g, '')
      }`;
      if (method !== 'GET' && !ctx.token) throw new ApiError(401, 'Requires authentication');
      return await shaped(ctx, await handler(ctx, repo, match.slice(1)));
    }
  }
  ctx.unimplemented = true;
  ctx.route = `${ctx.method} ${ctx.path} (not simulated)`;
  throw new ApiError(404, 'Not Found');
}
