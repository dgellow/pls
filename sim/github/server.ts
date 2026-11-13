/**
 * Simulated github.com: one HTTP server for the REST API, the GraphQL API and
 * git smart HTTP, all backed by the same bare repositories.
 *
 * Besides routing, this layer provides what scenarios need to observe and
 * disturb traffic: a log of every call, fault injection, barriers that hold a
 * request until the scenario releases it, and per-token rate limits.
 */

import { ApiError, type Cause, Model, type Token } from './model.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleSmartHttp, isSmartHttpPath } from './smart_http.ts';
import { Network } from './net.ts';

export interface CallRecord {
  seq: number;
  at: number;
  method: string;
  path: string;
  /** REST route pattern or GraphQL operation, for grouping. */
  route: string;
  kind: 'rest' | 'graphql' | 'git';
  tokenKind: string;
  runId: string | null;
  status: number;
  ms: number;
  fault: string | null;
  unimplemented: boolean;
}

export type FaultAction =
  | { type: 'status'; status: number; body?: unknown; headers?: Record<string, string> }
  /** Close the connection without a response. */
  | { type: 'reset' }
  /** Never answer (until the server shuts down). */
  | { type: 'hang' }
  /** Add latency, then proceed normally. */
  | { type: 'delay'; ms: number }
  /** Apply the request, then lose the response. */
  | { type: 'lost-response' };

export interface Fault {
  name: string;
  method?: string;
  path?: RegExp;
  kind?: 'rest' | 'graphql' | 'git';
  runId?: string;
  /** Only calls made with a workflow run's token (not people pushing or the web UI). */
  fromRun?: boolean;
  /** Arbitrary predicate, combined with the fields above. */
  match?: (
    call: { kind: 'rest' | 'graphql' | 'git'; method: string; path: string; search: string },
  ) => boolean;
  /** Skip this many matching calls first. */
  skip?: number;
  /** Apply to this many calls, then expire. Default 1. Infinity for permanent. */
  times?: number;
  action: FaultAction;
  /** Filled in by the server. */
  hits?: number;
}

interface Barrier {
  match: (req: { method: string; path: string; runId: string | null }) => boolean;
  reached: () => void;
  release: Promise<void>;
  used: boolean;
}

export interface RequestContext {
  model: Model;
  req: Request;
  url: URL;
  method: string;
  /** Path with any /api/v3 prefix removed. */
  path: string;
  token: Token | null;
  cause: Cause;
  baseUrl: string;
  /** Set by handlers so the call log can group by route. */
  route: string;
  unimplemented: boolean;
}

export class GitHubSim {
  readonly model: Model;
  calls: CallRecord[] = [];
  faults: Fault[] = [];
  private barriers: Barrier[] = [];
  private server: Deno.HttpServer | null = null;
  /** Transport faults: see net.ts. */
  net: Network = new Network(0);
  private seq = 0;
  private hung: Array<() => void> = [];
  port = 0;
  /** Remaining requests per token value. Absent means unlimited. */
  rateRemaining = new Map<string, number>();
  /** When set, every workflow run's GITHUB_TOKEN gets this many API requests. */
  rateBudgetPerRun: number | null = null;

  constructor(root: string) {
    this.model = new Model(root);
  }

  static async start(): Promise<GitHubSim> {
    const root = await Deno.makeTempDir({ prefix: 'pls-sim-github-' });
    const sim = new GitHubSim(root);
    sim.server = Deno.serve(
      { port: 0, hostname: '127.0.0.1', onListen: () => {} },
      (req, info) => sim.handle(req, (info.remoteAddr as Deno.NetAddr).port),
    );
    sim.net = new Network((sim.server.addr as Deno.NetAddr).port);
    sim.net.start();
    sim.port = sim.net.port;
    sim.model.baseUrl = sim.url;
    return sim;
  }

  /** Base URL for both the API and git remotes. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Where tool processes are told the npm registry is. No registry is simulated:
   * a request here is recorded as a gap instead of reaching registry.npmjs.org.
   */
  get npmRegistryUrl(): string {
    return `${this.url}/npm-registry/`;
  }

  gitUrl(owner: string, repo: string): string {
    return `${this.url}/${owner}/${repo}.git`;
  }

  async close(): Promise<void> {
    this.net.close();
    for (const release of this.hung) release();
    await this.server?.shutdown();
    await Deno.remove(this.model.root, { recursive: true }).catch(() => {});
  }

  // --- disturbance controls ---

  fault(fault: Fault): Fault {
    fault.hits = 0;
    this.faults.push(fault);
    return fault;
  }

  clearFaults(): void {
    this.faults = [];
  }

  /**
   * Hold the first request matching `match` until release() is called.
   * `reached` resolves when a request is being held.
   */
  barrier(
    match: (req: { method: string; path: string; runId: string | null }) => boolean,
  ): { reached: Promise<void>; release: () => void } {
    let reachedResolve = () => {};
    let releaseResolve = () => {};
    const reached = new Promise<void>((r) => (reachedResolve = r));
    const release = new Promise<void>((r) => (releaseResolve = r));
    this.barriers.push({ match, reached: reachedResolve, release, used: false });
    return { reached, release: releaseResolve };
  }

  callsFor(runId: string): CallRecord[] {
    return this.calls.filter((c) => c.runId === runId);
  }

  // --- request handling ---

  private authenticate(req: Request): { token: Token | null; bad: boolean } {
    const header = req.headers.get('authorization');
    if (!header) return { token: null, bad: false };
    let value = '';
    const [scheme, rest] = header.split(/\s+/, 2);
    if (/^basic$/i.test(scheme)) {
      const decoded = atob(rest ?? '');
      value = decoded.slice(decoded.indexOf(':') + 1);
    } else {
      value = rest ?? '';
    }
    const token = this.model.tokens.get(value);
    if (!token || token.revoked) return { token: null, bad: true };
    return { token, bad: false };
  }

  private matchFault(
    kind: CallRecord['kind'],
    method: string,
    path: string,
    runId: string | null,
    search: string,
  ): Fault | null {
    for (const f of this.faults) {
      if (f.kind && f.kind !== kind) continue;
      if (f.method && f.method !== method) continue;
      if (f.path && !f.path.test(path)) continue;
      if (f.runId && f.runId !== runId) continue;
      if (f.fromRun && runId === null) continue;
      if (f.match && !f.match({ kind, method, path, search })) continue;
      f.hits = (f.hits ?? 0) + 1;
      const skip = f.skip ?? 0;
      const times = f.times ?? 1;
      if (f.hits <= skip) continue;
      if (f.hits > skip + times) continue;
      return f;
    }
    return null;
  }

  private async handle(req: Request, connPort: number): Promise<Response> {
    const started = performance.now();
    const url = new URL(req.url);
    const method = req.method;
    const rawPath = url.pathname;
    const isGit = isSmartHttpPath(rawPath);
    const isGraphql = /^(\/api)?\/graphql$/.test(rawPath);
    const kind: CallRecord['kind'] = isGit ? 'git' : isGraphql ? 'graphql' : 'rest';
    const path = rawPath.replace(/^\/api\/v3/, '');
    const { token, bad } = this.authenticate(req);
    const runId = token?.runId ?? null;

    const record: CallRecord = {
      seq: ++this.seq,
      at: Date.now(),
      method,
      path: path + url.search,
      route: path,
      kind,
      tokenKind: token ? token.kind : (bad ? 'invalid' : 'none'),
      runId,
      status: 0,
      ms: 0,
      fault: null,
      unimplemented: false,
    };
    this.calls.push(record);
    const finish = (res: Response): Response => {
      record.status = res.status;
      record.ms = Math.round(performance.now() - started);
      return res;
    };

    for (const b of this.barriers) {
      if (!b.used && b.match({ method, path, runId })) {
        b.used = true;
        b.reached();
        await b.release;
      }
    }

    const fault = this.matchFault(kind, method, path, runId, url.search);
    if (fault) {
      record.fault = fault.name;
      const a = fault.action;
      if (a.type === 'status') {
        return finish(Response.json(a.body ?? { message: 'Server Error' }, {
          status: a.status,
          headers: a.headers,
        }));
      }
      if (a.type === 'reset') {
        record.status = -1;
        this.net.kill(connPort);
        return new Response(null, { status: 503 });
      }
      if (a.type === 'hang') {
        record.status = -2;
        await new Promise<void>((resolve) => this.hung.push(resolve));
        return new Response(null, { status: 503 });
      }
      if (a.type === 'delay') await new Promise((r) => setTimeout(r, a.ms));
    }

    if (bad) {
      return finish(Response.json({ message: 'Bad credentials' }, { status: 401 }));
    }

    const headers: Record<string, string> = {};
    if (token && !isGit) {
      if (
        token.kind === 'actions' && this.rateBudgetPerRun !== null &&
        !this.rateRemaining.has(token.value)
      ) {
        this.rateRemaining.set(token.value, this.rateBudgetPerRun);
      }
      const remaining = this.rateRemaining.get(token.value);
      if (remaining !== undefined) {
        const reset = String(Math.floor(Date.now() / 1000) + 3600);
        if (remaining <= 0) {
          return finish(Response.json(
            { message: `API rate limit exceeded for ${token.kind} token.` },
            {
              status: 403,
              headers: {
                'x-ratelimit-limit': '5000',
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': reset,
              },
            },
          ));
        }
        this.rateRemaining.set(token.value, remaining - 1);
        headers['x-ratelimit-limit'] = '5000';
        headers['x-ratelimit-remaining'] = String(remaining - 1);
        headers['x-ratelimit-reset'] = reset;
      }
    }

    const ctx: RequestContext = {
      model: this.model,
      req,
      url,
      method,
      path,
      token,
      cause: { actor: token?.actor ?? this.model.user('anonymous'), token },
      baseUrl: this.url,
      route: path,
      unimplemented: false,
    };

    let res: Response;
    try {
      if (isGit) res = await handleSmartHttp(ctx);
      else if (isGraphql) res = await handleGraphql(ctx);
      else res = await handleRest(ctx);
    } catch (e) {
      if (e instanceof ApiError) {
        const body: Record<string, unknown> = {
          message: e.message,
          documentation_url: 'https://docs.github.com/rest',
        };
        if (e.errors) body.errors = e.errors;
        res = Response.json(body, { status: e.status, headers: e.headers });
      } else {
        console.error('sim: internal error', method, path, e);
        res = Response.json({ message: `sim internal error: ${e}` }, { status: 500 });
      }
    }
    record.route = ctx.route;
    record.unimplemented = ctx.unimplemented;
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);

    if (fault?.action.type === 'lost-response') {
      record.status = -1;
      record.ms = Math.round(performance.now() - started);
      this.net.kill(connPort);
      return new Response(null, { status: 503 });
    }
    return finish(res);
  }
}
