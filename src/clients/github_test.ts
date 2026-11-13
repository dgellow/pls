/**
 * Tests of the GitHub client against a local HTTP server that answers like the
 * GitHub API for the routes each test needs.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { PlsError } from '../lib/error.ts';
import { GitHub } from './github.ts';

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
