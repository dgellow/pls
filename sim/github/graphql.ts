/**
 * GraphQL API of the simulated GitHub.
 *
 * Not a general GraphQL engine. Release tools send a small, fixed set of
 * queries; each one is recognised by the fields it selects and answered from
 * the same model the REST API uses. An unrecognised query is flagged in the
 * call log as a simulator gap.
 */

import { ApiError } from './model.ts';
import type { RequestContext } from './server.ts';

export type GraphqlHandler = (
  ctx: RequestContext,
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

/** Offset-based cursors: the opaque string is just the next index. */
function page<T>(
  items: T[],
  first: number,
  after: unknown,
): { nodes: T[]; pageInfo: Record<string, unknown> } {
  const start = after ? Number(after) : 0;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: String(end) } };
}

const handlers: Array<{ name: string; test: (query: string) => boolean; run: GraphqlHandler }> = [
  {
    // release-please: commit history of a branch with the pull requests that introduced each commit.
    name: 'pullRequestsSince',
    test: (q) => q.includes('associatedPullRequests') && q.includes('history('),
    run: async (ctx, _query, v) => {
      const repo = ctx.model.repo(String(v.owner), String(v.repo));
      const branch = String(v.targetBranch);
      const tip = await repo.git.commitSha(`refs/heads/${branch.replace(/^refs\/heads\//, '')}`);
      if (!tip) return { repository: { ref: null } };
      const shas = await repo.git.revList(tip);
      const { nodes: slice, pageInfo } = page(shas, Number(v.num ?? 10), v.cursor);
      const nodes = [];
      for (const sha of slice) {
        const c = await repo.git.commit(sha);
        if (!c) continue;
        const prs = [];
        for (const pr of ctx.model.pullsForCommit(repo, sha)) {
          if (!pr.merged) continue;
          const base = await repo.git.mergeBase(pr.base.sha, pr.head.sha) ?? pr.base.sha;
          const files = (await repo.git.changedFiles(base, pr.head.sha)).map((f) => ({
            path: f.filename,
          }));
          prs.push({
            number: pr.number,
            title: pr.title,
            baseRefName: pr.base.ref,
            headRefName: pr.head.ref,
            labels: { nodes: pr.labels.map((name) => ({ name })) },
            body: pr.body,
            mergeCommit: pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null,
            files: page(files, Number(v.maxFilesChanged ?? 100), null),
          });
        }
        nodes.push({
          associatedPullRequests: { nodes: prs },
          sha,
          message: c.message,
          author: { name: c.author.name, email: c.author.email, user: { login: c.author.name } },
        });
      }
      return { repository: { ref: { target: { history: { nodes, pageInfo } } } } };
    },
  },
  {
    // changesets/action (ghcommit): look up the base ref and the target branch.
    name: 'getRepositoryMetadata',
    test: (q) => q.includes('getRepositoryMetadata'),
    run: async (ctx, _query, v) => {
      const repo = ctx.model.repo(String(v.owner), String(v.repo));
      const lookup = async (name: string) => {
        const candidates = name.startsWith('refs/')
          ? [name]
          : [`refs/heads/${name}`, `refs/tags/${name}`];
        for (const ref of candidates) {
          const all = await repo.git.refs(ref);
          const sha = all.get(ref);
          if (!sha) continue;
          const commit = await repo.git.commitSha(sha);
          return {
            id: `REF_${ref}`,
            target: sha === commit ? { oid: sha } : { oid: sha, target: { oid: commit } },
          };
        }
        return null;
      };
      return {
        repository: {
          id: `R_${repo.full}`,
          baseRef: await lookup(String(v.baseRef)),
          targetBranch: await lookup(String(v.targetRef)),
        },
      };
    },
  },
  {
    // changesets/action (ghcommit), release-plz: commit files onto a branch through the API.
    name: 'createCommitOnBranch',
    test: (q) => q.includes('createCommitOnBranch'),
    run: async (ctx, _query, v) => {
      ctx.model.require(ctx.token, 'contents', 'write');
      const input = v.input as {
        branch: { id?: string; repositoryNameWithOwner?: string; branchName?: string };
        expectedHeadOid: string;
        message: { headline: string; body?: string };
        fileChanges?: {
          additions?: Array<{ path: string; contents: string }>;
          deletions?: Array<{ path: string }>;
        };
      };
      let ref = input.branch.id?.replace(/^REF_/, '') ?? `refs/heads/${input.branch.branchName}`;
      if (!ref.startsWith('refs/')) ref = `refs/heads/${ref}`;
      const repo = input.branch.repositoryNameWithOwner
        ? ctx.model.repos.get(input.branch.repositoryNameWithOwner)
        : [...ctx.model.repos.values()][0];
      if (!repo) throw new ApiError(404, 'Not Found');
      const head = await repo.git.commitSha(ref);
      if (head !== input.expectedHeadOid) {
        throw new ApiError(
          422,
          `Expected branch to point to "${input.expectedHeadOid}" but it did not. Pull and try again.`,
        );
      }
      const base = await repo.git.commit(head);
      if (!base) throw new ApiError(404, 'Not Found');
      const changes: Array<{ path: string; mode: string; sha: string | null }> = [];
      for (const a of input.fileChanges?.additions ?? []) {
        const bin = atob(a.contents);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // The API has no way to express file modes: additions are always regular files.
        changes.push({ path: a.path, mode: '100644', sha: await repo.git.writeBlob(bytes) });
      }
      for (const d of input.fileChanges?.deletions ?? []) {
        changes.push({ path: d.path, mode: '100644', sha: null });
      }
      const tree = await repo.git.writeTree(base.tree, changes);
      const who = ctx.token?.kind === 'actions'
        ? {
          name: 'github-actions[bot]',
          email: '41898282+github-actions[bot]@users.noreply.github.com',
        }
        : { name: ctx.cause.actor.name, email: ctx.cause.actor.email };
      const message = input.message.body
        ? `${input.message.headline}\n\n${input.message.body}`
        : input.message.headline;
      const sha = await repo.git.writeCommit(tree, [head], message, who, {
        name: 'GitHub',
        email: 'noreply@github.com',
      });
      repo.verified.add(sha);
      await ctx.model.setRef(repo, ref, sha, ctx.cause);
      return { createCommitOnBranch: { commit: { oid: sha }, ref: { id: `REF_${ref}` } } };
    },
  },
  {
    // changesets/action: update the version pull request.
    name: 'updatePullRequest',
    test: (q) => q.includes('updatePullRequest('),
    run: (ctx, _query, v) => {
      const number = Number(String(v.pullRequestId).replace(/^PR_/, ''));
      for (const repo of ctx.model.repos.values()) {
        if (!repo.prs.has(number)) continue;
        ctx.model.updatePR(repo, number, {
          title: v.title === undefined ? undefined : String(v.title),
          body: v.body === undefined ? undefined : String(v.body),
          state: 'open',
        }, ctx.cause);
        return Promise.resolve({ updatePullRequest: { pullRequest: { id: `PR_${number}` } } });
      }
      throw new ApiError(404, 'Could not resolve to a node with the global id');
    },
  },
  {
    // release-please: releases, newest first.
    name: 'releases',
    test: (q) => q.includes('releases(') && q.includes('tagCommit'),
    run: async (ctx, _query, v) => {
      const repo = ctx.model.repo(String(v.owner), String(v.repo));
      const all = [];
      for (const r of [...repo.releases].reverse()) {
        const oid = r.draft ? null : await repo.git.commitSha(`refs/tags/${r.tag_name}`);
        all.push({
          name: r.name,
          tag: r.draft ? null : { name: r.tag_name },
          tagCommit: oid ? { oid } : null,
          url: `${ctx.baseUrl}/${repo.full}/releases/tag/${r.tag_name}`,
          description: r.body ?? '',
          isDraft: r.draft,
        });
      }
      return { repository: { releases: page(all, Number(v.num ?? 25), v.cursor) } };
    },
  },
];

export async function handleGraphql(ctx: RequestContext): Promise<Response> {
  if (!ctx.token) throw new ApiError(401, 'Requires authentication');
  const body = await ctx.req.json() as { query?: string; variables?: Record<string, unknown> };
  const query = body.query ?? '';
  for (const h of handlers) {
    if (!h.test(query)) continue;
    ctx.route = `graphql:${h.name}`;
    try {
      const data = await h.run(ctx, query, body.variables ?? {});
      return Response.json({ data });
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) {
        return Response.json({
          data: null,
          errors: [{ type: 'UNPROCESSABLE', message: e.message }],
        });
      }
      throw e;
    }
  }
  ctx.unimplemented = true;
  ctx.route = `graphql:(not simulated) ${query.replace(/\s+/g, ' ').slice(0, 80)}`;
  return Response.json({ errors: [{ message: 'sim: query not simulated' }] });
}
