/**
 * Git smart HTTP for simulated repositories.
 *
 * Requests are handed to the real `git http-backend` CGI program, so clone,
 * fetch (including shallow and partial), ls-remote and push behave exactly as
 * they do against any git server. This layer adds what GitHub adds: token
 * authentication, rulesets (through the pre-receive hook) and the events a
 * push produces.
 */

import { ApiError } from './model.ts';
import type { RequestContext } from './server.ts';

const SMART_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function isSmartHttpPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git\//.test(path);
}

function indexOfDoubleNewline(bytes: Uint8Array): { headerEnd: number; bodyStart: number } | null {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return { headerEnd: i, bodyStart: i + 4 };
    }
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { headerEnd: i, bodyStart: i + 2 };
  }
  return null;
}

export async function handleSmartHttp(ctx: RequestContext): Promise<Response> {
  const m = SMART_PATH.exec(ctx.path);
  if (!m) throw new ApiError(404, 'Not Found');
  const [, owner, name, endpoint] = m;
  const repo = ctx.model.repo(owner, name);
  ctx.route = `git:${endpoint}`;

  const service = endpoint === 'info/refs' ? ctx.url.searchParams.get('service') : endpoint;
  const isPush = service === 'git-receive-pack';
  ctx.route = `git:${service}${endpoint === 'info/refs' ? ':advertise' : ''}`;

  if (isPush) {
    if (!ctx.token) {
      return new Response('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="GitHub"' },
      });
    }
    if (!ctx.model.can(ctx.token, 'contents', 'write')) {
      return new Response(
        `remote: Permission to ${repo.full}.git denied to ${ctx.token.actor.login}.\n`,
        { status: 403 },
      );
    }
  }

  const body = new Uint8Array(await ctx.req.arrayBuffer());
  const before = isPush && endpoint !== 'info/refs' ? await repo.git.refs() : null;

  const env: Record<string, string> = {
    PATH: Deno.env.get('PATH') ?? '',
    HOME: Deno.env.get('HOME') ?? '/tmp',
    GIT_PROJECT_ROOT: ctx.model.root,
    GIT_HTTP_EXPORT_ALL: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    REQUEST_METHOD: ctx.method,
    PATH_INFO: ctx.path,
    QUERY_STRING: ctx.url.search.replace(/^\?/, ''),
    CONTENT_TYPE: ctx.req.headers.get('content-type') ?? '',
    CONTENT_LENGTH: String(body.length),
    REMOTE_ADDR: '127.0.0.1',
    REMOTE_USER: ctx.token?.actor.login ?? '',
    SIM_ACTOR_KIND: ctx.token?.kind ?? 'web',
  };
  const encoding = ctx.req.headers.get('content-encoding');
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  const protocol = ctx.req.headers.get('git-protocol');
  if (protocol) env.HTTP_GIT_PROTOCOL = protocol;

  const child = new Deno.Command('git', {
    args: ['http-backend'],
    env,
    clearEnv: true,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(body);
  await writer.close();
  const out = await child.output();

  const split = indexOfDoubleNewline(out.stdout);
  if (!split) {
    const err = new TextDecoder().decode(out.stderr);
    throw new ApiError(500, `git http-backend produced no headers: ${err}`);
  }
  const headerText = new TextDecoder().decode(out.stdout.subarray(0, split.headerEnd));
  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key.toLowerCase() === 'status') status = parseInt(value, 10);
    else headers.set(key, value);
  }

  if (before) {
    const after = await repo.git.refs();
    const names = new Set([...before.keys(), ...after.keys()]);
    for (const ref of [...names].sort()) {
      const oldSha = before.get(ref) ?? null;
      const newSha = after.get(ref) ?? null;
      if (oldSha === newSha) continue;
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) continue;
      await ctx.model.refChanged(repo, ref, oldSha, newSha, ctx.cause);
    }
  }

  return new Response(out.stdout.subarray(split.bodyStart), { status, headers });
}
