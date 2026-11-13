/**
 * Tests of the simulator itself: the GitHub behaviours scenarios rely on.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import { Runner } from '../actions/runner.ts';
import type { Repo, Token } from './model.ts';
import { GitHubSim } from './server.ts';

interface Fixture {
  sim: GitHubSim;
  repo: Repo;
  pat: Token;
  work: string;
  home: string;
  git(script: string): Promise<{ code: number; out: string }>;
  api(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    // deno-lint-ignore no-explicit-any
  ): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const sim = await GitHubSim.start();
  const repo = await sim.model.createRepo('acme', 'widget');
  const pat = sim.model.mintToken('pat', sim.model.user('maintainer'));
  const work = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  await Deno.writeTextFile(`${home}/.gitconfig`, '[user]\n\tname = m\n\temail = m@example.com\n');
  const url = sim.gitUrl('acme', 'widget').replace(
    'http://',
    `http://x-access-token:${pat.value}@`,
  );
  const git = async (script: string) => {
    const o = await new Deno.Command('bash', {
      args: ['-c', script],
      cwd: work,
      env: {
        PATH: Deno.env.get('PATH') ?? '',
        HOME: home,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        NO_PROXY: '127.0.0.1',
      },
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    return {
      code: o.code,
      out: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr),
    };
  };
  const api = async (method: string, path: string, body?: unknown, token = pat.value) => {
    const res = await fetch(sim.url + path, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  await git(
    `git init -q -b main . && git remote add origin ${url} && echo one > a.txt && git add -A && ` +
      `git commit -qm 'feat: one' && git push -q origin main`,
  );
  return {
    sim,
    repo,
    pat,
    work,
    home,
    git,
    api,
    close: async () => {
      await sim.close();
      await Deno.remove(work, { recursive: true });
      await Deno.remove(home, { recursive: true });
    },
  };
}

/** Push a branch with one commit and open a pull request for it. */
async function openPR(f: Fixture, branch: string, message = 'fix: change'): Promise<number> {
  await f.git(
    `git checkout -q -b ${branch} main && echo ${branch} > ${branch}.txt && git add -A && ` +
      `git commit -qm '${message}' -m 'body text' && git push -q origin ${branch} && git checkout -q main`,
  );
  const pr = await f.api('POST', '/repos/acme/widget/pulls', {
    title: 'A change',
    head: branch,
    base: 'main',
  });
  assertEquals(pr.status, 201);
  return pr.json.number;
}

Deno.test('sim: git push and the REST API share one repository', async () => {
  const f = await fixture();
  try {
    const ref = await f.api('GET', '/repos/acme/widget/git/ref/heads/main');
    const local = (await f.git('git rev-parse HEAD')).out.trim();
    assertEquals(ref.json.object.sha, local);
    const file = await f.api('GET', '/repos/acme/widget/contents/a.txt');
    assertEquals(atob(file.json.content.replace(/\n/g, '')), 'one\n');
  } finally {
    await f.close();
  }
});

Deno.test('sim: squash, merge and rebase produce what GitHub produces', async (t) => {
  const f = await fixture();
  try {
    await t.step('squash: one commit, subject with PR number, body from the commit', async () => {
      const n = await openPR(f, 'squash-me', 'fix: squashed');
      const merged = await f.api('PUT', `/repos/acme/widget/pulls/${n}/merge`, {
        merge_method: 'squash',
      });
      const c = await f.repo.git.commit(merged.json.sha);
      assertEquals(c?.message, `fix: squashed (#${n})\n\nbody text`);
      assertEquals(c?.parents.length, 1);
      assertEquals(c?.committer.name, 'GitHub');
    });
    await t.step('merge: two parents and the standard subject', async () => {
      const n = await openPR(f, 'merge-me');
      const merged = await f.api('PUT', `/repos/acme/widget/pulls/${n}/merge`, {
        merge_method: 'merge',
      });
      const c = await f.repo.git.commit(merged.json.sha);
      assertEquals(c?.parents.length, 2);
      assert(c?.message.startsWith(`Merge pull request #${n} from acme/merge-me`));
    });
    await t.step('rebase: original message, new SHA, merger as committer', async () => {
      const n = await openPR(f, 'rebase-me', 'fix: rebased');
      const head = (await f.api('GET', `/repos/acme/widget/pulls/${n}`)).json.head.sha;
      const merged = await f.api('PUT', `/repos/acme/widget/pulls/${n}/merge`, {
        merge_method: 'rebase',
      });
      const c = await f.repo.git.commit(merged.json.sha);
      assert(merged.json.sha !== head);
      assertEquals(c?.message, 'fix: rebased\n\nbody text');
      assertEquals(c?.committer.name, 'maintainer');
    });
  } finally {
    await f.close();
  }
});

Deno.test('sim: pull request and ref validation errors', async () => {
  const f = await fixture();
  try {
    const n = await openPR(f, 'topic');
    const again = await f.api('POST', '/repos/acme/widget/pulls', {
      title: 'x',
      head: 'topic',
      base: 'main',
    });
    assertEquals(again.status, 422);
    assert(again.json.errors[0].message.includes('A pull request already exists'));

    const main = (await f.api('GET', '/repos/acme/widget/git/ref/heads/main')).json.object.sha;
    const dup = await f.api('POST', '/repos/acme/widget/git/refs', {
      ref: 'refs/heads/topic',
      sha: main,
    });
    assertEquals(dup.status, 422);
    assertEquals(dup.json.message, 'Reference already exists');

    // Pointing the head at base leaves no commits to merge: GitHub closes the pull request.
    await f.api('PATCH', '/repos/acme/widget/git/refs/heads/topic', { sha: main, force: true });
    assertEquals((await f.api('GET', `/repos/acme/widget/pulls/${n}`)).json.state, 'closed');
  } finally {
    await f.close();
  }
});

Deno.test('sim: releases create tags, reject duplicates, and drafts stay invisible', async () => {
  const f = await fixture();
  try {
    const created = await f.api('POST', '/repos/acme/widget/releases', { tag_name: 'v1.0.0' });
    assertEquals(created.status, 201);
    assert((await f.git('git ls-remote origin refs/tags/v1.0.0')).out.includes('refs/tags/v1.0.0'));
    const dup = await f.api('POST', '/repos/acme/widget/releases', { tag_name: 'v1.0.0' });
    assertEquals(dup.json.errors[0].code, 'already_exists');
    await f.api('POST', '/repos/acme/widget/releases', { tag_name: 'v2.0.0', draft: true });
    assertEquals((await f.api('GET', '/repos/acme/widget/releases/tags/v2.0.0')).status, 404);
    assertEquals((await f.api('GET', '/repos/acme/widget/git/ref/tags/v2.0.0')).status, 404);
  } finally {
    await f.close();
  }
});

Deno.test('sim: rulesets apply to git pushes and API writes alike', async () => {
  const f = await fixture();
  try {
    f.repo.settings.restrict_tag_creation = { pattern: /^v/, bypass: ['app'] };
    f.repo.settings.immutable_releases = true;
    await f.sim.model.writeRuleHook(f.repo);
    const pushed = await f.git('git tag v9.9.9 && git push origin v9.9.9');
    assert(pushed.code !== 0 && pushed.out.includes('GH013'), pushed.out);
    const main = (await f.api('GET', '/repos/acme/widget/git/ref/heads/main')).json.object.sha;
    const viaApi = await f.api('POST', '/repos/acme/widget/git/refs', {
      ref: 'refs/tags/v9.9.9',
      sha: main,
    });
    assertEquals(viaApi.status, 422);

    // An App may create the tag; publishing a release then locks it.
    const app = f.sim.model.mintToken('app', f.sim.model.user('release-app[bot]', 'Bot'), {
      contents: 'write',
    });
    assertEquals(
      (await f.api('POST', '/repos/acme/widget/releases', { tag_name: 'v1.0.0' }, app.value))
        .status,
      201,
    );
    const moved = await f.api(
      'DELETE',
      '/repos/acme/widget/git/refs/tags/v1.0.0',
      undefined,
      app.value,
    );
    assertEquals(moved.status, 422);
  } finally {
    await f.close();
  }
});

Deno.test('sim: the contents API carries no content above 1 MB', async () => {
  const f = await fixture();
  try {
    await f.git(
      `head -c 1200000 /dev/zero | tr '\\0' 'x' > big.txt && git add -A && git commit -qm 'chore: big' && ` +
        `git push -q origin main`,
    );
    const big = await f.api('GET', '/repos/acme/widget/contents/big.txt');
    assertEquals(big.json.encoding, 'none');
    assertEquals(big.json.content, '');
    assertEquals(big.json.size, 1200000);
  } finally {
    await f.close();
  }
});

Deno.test('sim: transport faults reach the client as transport errors', async () => {
  const f = await fixture();
  try {
    f.sim.fault({
      name: 'lost',
      method: 'POST',
      path: /\/releases$/,
      action: { type: 'lost-response' },
    });
    await assertRejects(() => f.api('POST', '/repos/acme/widget/releases', { tag_name: 'v1.0.0' }));
    // The write happened although the client saw an error.
    assertEquals(f.repo.releases.length, 1);
    f.sim.net.down = true;
    await assertRejects(() => fetch(`${f.sim.url}/rate_limit`));
  } finally {
    await f.close();
  }
});

Deno.test('sim: Actions trigger rules, shallow checkout and token lifetime', async () => {
  const f = await fixture();
  try {
    const runner = new Runner(f.sim, f.repo);
    runner.secrets.set('PAT', f.pat.value);
    const release = (tokenEnv: 'GITHUB_TOKEN' | 'PAT') =>
      `curl -fsS -X POST -H "authorization: Bearer $TOKEN" "$GITHUB_API_URL/repos/acme/widget/releases" ` +
      `-d '{"tag_name":"${tokenEnv === 'PAT' ? 'v2.0.0' : 'v1.0.0'}"}' >/dev/null`;
    runner.workflows = [
      {
        name: 'release with GITHUB_TOKEN',
        on: [{ event: 'push', branches: ['main'] }],
        permissions: { contents: 'write' },
        steps: [
          {
            id: 'depth',
            name: 'depth',
            run: 'echo "commits=$(git rev-list --count HEAD)" >> "$GITHUB_OUTPUT"',
          },
          { name: 'release', run: release('GITHUB_TOKEN'), env: { TOKEN: { githubToken: true } } },
          {
            name: 'save token',
            run: 'echo "$TOKEN" > /tmp/sim-test-token',
            env: { TOKEN: { githubToken: true } },
          },
        ],
      },
      {
        name: 'release with PAT',
        on: [{ event: 'push', branches: ['main'] }],
        checkout: false,
        steps: [{ name: 'release', run: release('PAT'), env: { TOKEN: { secret: 'PAT' } } }],
      },
      {
        name: 'publish',
        on: [{ event: 'release', types: ['published'] }],
        checkout: false,
        steps: [{ name: 'publish', run: 'true' }],
      },
    ];
    await f.git(
      `echo two > a.txt && git add -A && git commit -qm 'fix: two' && git push -q origin main`,
    );
    while (runner.pending.length > 0) await runner.drain();

    const first = runner.runs.find((r) => r.workflow === 'release with GITHUB_TOKEN')!;
    assertEquals(first.conclusion, 'success');
    assertEquals(first.outputs.depth.commits, '1', 'default checkout is one commit deep');
    // Only the release created with the PAT started the publish workflow.
    const publishes = runner.runs.filter((r) => r.workflow === 'publish');
    assertEquals(publishes.length, 1);
    assertEquals(publishes[0].ref, 'refs/tags/v2.0.0');
    assert(
      runner.suppressed.some((s) => s.workflow === 'publish' && s.reason.includes('GITHUB_TOKEN')),
    );
    // The run's token no longer works.
    const stale = (await Deno.readTextFile('/tmp/sim-test-token')).trim();
    assertEquals((await f.api('GET', '/repos/acme/widget', undefined, stale)).status, 401);
  } finally {
    await f.close();
  }
});
