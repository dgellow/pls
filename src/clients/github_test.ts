/**
 * Tests of the GitHub client against a local HTTP server that answers like the
 * GitHub API for the routes each test needs.
 */

import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { PlsError } from '../lib/error.ts';
import { GitHub, resolveApiUrl } from './github.ts';

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/** Run `fn` with a client whose API is served by `handler`. */
async function withApi(handler: Handler, fn: (github: GitHub) => Promise<void>): Promise<void> {
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    (req) => handler(req, new URL(req.url)),
  );
  const { port } = server.addr as Deno.NetAddr;
  try {
    await fn(
      new GitHub({ owner: 'acme', repo: 'widget', token: 't', apiUrl: `http://127.0.0.1:${port}` }),
    );
  } finally {
    await server.shutdown();
  }
}

/** Base64 of UTF-8 text, wrapped at 60 columns the way the contents API wraps it. */
function contentsBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/(.{60})/g, '$1\n');
}

Deno.test('GitHub.readFile', async (t) => {
  await t.step('decodes content as UTF-8, not one character per byte', async () => {
    const text = '# Changelog\n\n- café ⚠️ 日本語 — naïve “quotes”\n';
    await withApi(
      () =>
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: contentsBase64(text),
          sha: 'abc',
          size: new TextEncoder().encode(text).length,
        }),
      async (github) => {
        assertEquals(await github.readFile('CHANGELOG.md', 'main'), text);
      },
    );
  });

  await t.step('keeps a byte order mark', async () => {
    const text = '﻿{"version": "1.0.0"}\n';
    await withApi(
      () =>
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: contentsBase64(text),
          sha: 'abc',
          size: 25,
        }),
      async (github) => {
        assertEquals(await github.readFile('package.json'), text);
      },
    );
  });

  await t.step('reads a file above 1 MB through the blob API', async () => {
    const text = '# Changelog\n\n' + '- an old entry that must survive\n'.repeat(40_000);
    const requested: string[] = [];
    await withApi(
      (_req, url) => {
        requested.push(url.pathname);
        if (url.pathname.endsWith('/contents/CHANGELOG.md')) {
          // What the contents API answers above 1 MB: no content at all.
          return Response.json({
            type: 'file',
            encoding: 'none',
            content: '',
            sha: 'big',
            size: text.length,
          });
        }
        if (url.pathname.endsWith('/git/blobs/big')) {
          return Response.json({ encoding: 'base64', content: contentsBase64(text) });
        }
        return Response.json({ message: 'Not Found' }, { status: 404 });
      },
      async (github) => {
        assertEquals(await github.readFile('CHANGELOG.md', 'main'), text);
        assertEquals(requested, [
          '/repos/acme/widget/contents/CHANGELOG.md',
          '/repos/acme/widget/git/blobs/big',
        ]);
      },
    );
  });

  await t.step('an empty file stays empty without a second request', async () => {
    let calls = 0;
    await withApi(
      () => {
        calls++;
        return Response.json({ type: 'file', encoding: 'base64', content: '', sha: 'e', size: 0 });
      },
      async (github) => {
        assertEquals(await github.readFile('empty.txt'), '');
        assertEquals(calls, 1);
      },
    );
  });

  await t.step('a missing file is null', async () => {
    await withApi(
      () => Response.json({ message: 'Not Found' }, { status: 404 }),
      async (github) => {
        assertEquals(await github.readFile('nope.json'), null);
      },
    );
  });

  await t.step('refuses a file that is not UTF-8 instead of damaging it', async () => {
    await withApi(
      () =>
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: btoa('caf\xe9\n'), // Latin-1
          sha: 'l1',
          size: 5,
        }),
      async (github) => {
        const error = await assertRejects(() => github.readFile('NOTES.txt'), PlsError);
        assertEquals(error.code, 'FILE_NOT_UTF8');
      },
    );
  });

  await t.step('a directory is an error that names the path', async () => {
    await withApi(
      () => Response.json([{ type: 'file', name: 'a.txt' }]),
      async (github) => {
        const error = await assertRejects(() => github.readFile('docs'), PlsError);
        assertEquals(error.code, 'GITHUB_NOT_A_FILE');
      },
    );
  });
});

Deno.test('GitHub.commit keeps the mode of files that exist', async (t) => {
  /** Serve the routes commit() uses; record the tree it creates. */
  function api(trees: Record<string, unknown>): {
    handler: Handler;
    created: () => Array<{ path: string; mode: string }>;
  } {
    let created: Array<{ path: string; mode: string }> = [];
    const handler: Handler = async (req, url) => {
      const path = url.pathname.replace('/repos/acme/widget', '');
      if (req.method === 'GET' && path === '/git/commits/parent') {
        return Response.json({ tree: { sha: 'root' } });
      }
      if (req.method === 'GET' && path.startsWith('/git/trees/')) {
        const key = path.slice('/git/trees/'.length) + url.search;
        return key in trees
          ? Response.json(trees[key])
          : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      if (req.method === 'POST' && path === '/git/blobs') return Response.json({ sha: 'blob' });
      if (req.method === 'POST' && path === '/git/trees') {
        created = (await req.json()).tree;
        return Response.json({ sha: 'newtree' });
      }
      if (req.method === 'POST' && path === '/git/commits') return Response.json({ sha: 'new' });
      return Response.json({ message: 'Not Found' }, { status: 404 });
    };
    return { handler, created: () => created };
  }

  const files = new Map([
    ['bin/widget', '#!/bin/sh\n'],
    ['package.json', '{}\n'],
    ['CHANGELOG.md', '# Changelog\n'],
  ]);
  const expected = [
    { path: 'bin/widget', mode: '100755' },
    { path: 'package.json', mode: '100644' },
    { path: 'CHANGELOG.md', mode: '100644' }, // new file
  ];
  const modesOf = (tree: Array<{ path: string; mode: string }>) =>
    tree.map((e) => ({ path: e.path, mode: e.mode }));

  await t.step('from the recursive listing', async () => {
    const { handler, created } = api({
      'root?recursive=1': {
        truncated: false,
        tree: [
          { path: 'bin', mode: '040000', type: 'tree', sha: 'bin' },
          { path: 'bin/widget', mode: '100755', type: 'blob', sha: 'w' },
          { path: 'package.json', mode: '100644', type: 'blob', sha: 'p' },
        ],
      },
    });
    await withApi(handler, async (github) => {
      assertEquals(await github.commit(files, 'chore: release', 'parent'), 'new');
      assertEquals(modesOf(created()), expected);
    });
  });

  await t.step('directory by directory when the listing is truncated', async () => {
    const { handler, created } = api({
      'root?recursive=1': { truncated: true, tree: [] },
      'root': {
        truncated: false,
        tree: [
          { path: 'bin', mode: '040000', type: 'tree', sha: 'bintree' },
          { path: 'package.json', mode: '100644', type: 'blob', sha: 'p' },
        ],
      },
      'bintree': {
        truncated: false,
        tree: [{ path: 'widget', mode: '100755', type: 'blob', sha: 'w' }],
      },
    });
    await withApi(handler, async (github) => {
      await github.commit(files, 'chore: release', 'parent');
      assertEquals(modesOf(created()), expected);
    });
  });
});

Deno.test('GitHub requests have a time limit', async (t) => {
  await t.step('a request that is never answered fails, naming the request', async () => {
    let release = () => {};
    const never = new Promise<void>((resolve) => (release = resolve));
    const server = Deno.serve(
      { port: 0, hostname: '127.0.0.1', onListen: () => {} },
      async () => {
        await never;
        return new Response('late');
      },
    );
    const { port } = server.addr as Deno.NetAddr;
    const github = new GitHub({
      owner: 'acme',
      repo: 'widget',
      token: 't',
      apiUrl: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 300,
    });

    try {
      const started = performance.now();
      const error = await assertRejects(() => github.getBranchRevision('main'), PlsError);

      assertEquals(error.code, 'GITHUB_TIMEOUT');
      assertEquals(error.message.includes('GET /repos/acme/widget/git/ref/heads/main'), true);
      assertEquals(performance.now() - started < 5000, true);
    } finally {
      release();
      await server.shutdown();
    }
  });

  await t.step('an unreachable host is a network error, not a crash', async () => {
    // A port nothing listens on.
    const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const { port } = listener.addr as Deno.NetAddr;
    listener.close();
    const github = new GitHub({
      owner: 'acme',
      repo: 'widget',
      token: 't',
      apiUrl: `http://127.0.0.1:${port}`,
    });

    const error = await assertRejects(() => github.getBranchRevision('main'), PlsError);

    assertEquals(error.code, 'GITHUB_NETWORK_ERROR');
    assertEquals(error.message.includes('Check your connection'), true);
  });
});

Deno.test('GitHub client: the API URL and the repository names are checked up front', async (t) => {
  const client = (apiUrl: string | undefined, owner = 'acme', repo = 'widget') =>
    new GitHub({ owner, repo, token: 't', apiUrl });

  await t.step('accepts github.com, a GitHub Enterprise Server URL and a local server', () => {
    assertEquals(resolveApiUrl(undefined), 'https://api.github.com');
    assertEquals(resolveApiUrl(''), 'https://api.github.com');
    assertEquals(resolveApiUrl('https://api.github.com/'), 'https://api.github.com');
    assertEquals(
      resolveApiUrl('https://github.example.com/api/v3/'),
      'https://github.example.com/api/v3',
    );
    assertEquals(resolveApiUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assertEquals(resolveApiUrl('http://localhost:8080/'), 'http://localhost:8080');
  });

  await t.step('refuses to send the token over plain http to another machine', () => {
    const error = assertThrows(() => client('http://github.example.com/api/v3'), PlsError);
    assertEquals(error.code, 'GITHUB_API_URL_INVALID');
    assertEquals(error.message.includes('GITHUB_API_URL'), true);
    assertEquals(error.message.includes('use https'), true);
  });

  await t.step('refuses what is not a usable base URL', () => {
    for (
      const bad of [
        'not a url',
        'ftp://github.example.com',
        'https://user:secret@github.example.com',
        'https://github.example.com/api/v3?x=1',
        'https://github.example.com/api/v3#frag',
        'http://127.0.0.1.example.com',
      ]
    ) {
      const error = assertThrows(() => client(bad), PlsError, undefined, bad);
      assertEquals(error.code, 'GITHUB_API_URL_INVALID', bad);
    }
  });

  await t.step('does not echo credentials found in the URL', () => {
    for (
      const bad of [
        'https://user:hunter2@github.example.com/api/v3',
        'http://user:hunter2@github.example.com/api/v3',
        'user:hunter2@github.example.com',
      ]
    ) {
      const error = assertThrows(() => client(bad), PlsError);
      assertEquals(error.code, 'GITHUB_API_URL_INVALID');
      assertEquals(error.message.includes('hunter2'), false, error.message);
      assertEquals(JSON.stringify(error.details).includes('hunter2'), false);
      assertEquals(error.message.includes('github.example.com'), true);
    }
  });

  await t.step('refuses owner and repository names that are not names', () => {
    for (
      const [owner, repo] of [
        ['acme/evil', 'widget'],
        ['acme', '../other'],
        ['', 'widget'],
        ['acme', '..'],
        ['.', 'widget'],
      ]
    ) {
      const error = assertThrows(() => client(undefined, owner, repo), PlsError);
      assertEquals(error.code, 'INVALID_REPO_NAME');
    }
    client(undefined, 'Acme-Corp_1', 'my.widget-2');
  });
});
