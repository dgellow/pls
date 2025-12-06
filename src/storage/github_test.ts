import { assertEquals, assertExists } from '@std/assert';
import { GitHubStorage } from './github.ts';

// Mock fetch globally for testing
const originalFetch = globalThis.fetch;

function mockFetch(responses: Map<string, unknown>) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    const method = init?.method || 'GET';
    const key = `${method}:${urlStr}`;

    const mockData = responses.get(key);
    if (!mockData) {
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    }

    return Promise.resolve(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}

Deno.test('GitHubStorage - getLastRelease', async () => {
  const responses = new Map<string, unknown>();
  responses.set(
    'GET:https://api.github.com/repos/test-owner/test-repo/releases?per_page=1',
    [
      {
        id: 1,
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        body: 'Release notes',
        created_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/releases/tag/v1.0.0',
        target_commitish: 'abc123',
      },
    ],
  );

  globalThis.fetch = mockFetch(responses) as typeof fetch;

  try {
    const storage = new GitHubStorage({ owner: 'test-owner', repo: 'test-repo' });
    const release = await storage.getLastRelease();

    assertExists(release);
    assertEquals(release.version, '1.0.0');
    assertEquals(release.tag, 'v1.0.0');
    assertEquals(release.sha, 'abc123');
    assertEquals(release.notes, 'Release notes');
    assertEquals(release.url, 'https://github.com/test-owner/test-repo/releases/tag/v1.0.0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('GitHubStorage - getLastRelease returns null when no releases', async () => {
  const responses = new Map<string, unknown>();
  responses.set(
    'GET:https://api.github.com/repos/test-owner/test-repo/releases?per_page=1',
    [],
  );

  globalThis.fetch = mockFetch(responses) as typeof fetch;

  try {
    const storage = new GitHubStorage({ owner: 'test-owner', repo: 'test-repo' });
    const release = await storage.getLastRelease();

    assertEquals(release, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('GitHubStorage - listReleases', async () => {
  const responses = new Map<string, unknown>();
  responses.set(
    'GET:https://api.github.com/repos/test-owner/test-repo/releases?per_page=100',
    [
      {
        id: 2,
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        body: 'Second release',
        created_at: '2025-01-02T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/releases/tag/v1.1.0',
        target_commitish: 'def456',
      },
      {
        id: 1,
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        body: 'First release',
        created_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/releases/tag/v1.0.0',
        target_commitish: 'abc123',
      },
    ],
  );

  globalThis.fetch = mockFetch(responses) as typeof fetch;

  try {
    const storage = new GitHubStorage({ owner: 'test-owner', repo: 'test-repo' });
    const releases = await storage.listReleases();

    assertEquals(releases.length, 2);
    assertEquals(releases[0].version, '1.1.0');
    assertEquals(releases[1].version, '1.0.0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('GitHubStorage - saveRelease', async () => {
  const responses = new Map<string, unknown>();
  responses.set('POST:https://api.github.com/repos/test-owner/test-repo/releases', {
    id: 3,
    tag_name: 'v2.0.0',
    name: 'v2.0.0',
    body: 'New release',
    created_at: '2025-01-03T00:00:00Z',
    html_url: 'https://github.com/test-owner/test-repo/releases/tag/v2.0.0',
    target_commitish: 'xyz789',
  });

  globalThis.fetch = mockFetch(responses) as typeof fetch;

  try {
    const storage = new GitHubStorage({ owner: 'test-owner', repo: 'test-repo' });
    await storage.saveRelease({
      version: '2.0.0',
      tag: 'v2.0.0',
      sha: 'xyz789',
      createdAt: new Date('2025-01-03'),
      notes: 'New release',
    });

    // If it doesn't throw, the test passes
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('GitHubStorage - saveRelease marks prerelease versions', async () => {
  let capturedBody: string | undefined;

  const mockFetchCapture = (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body as string;
    return Promise.resolve(
      new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };

  globalThis.fetch = mockFetchCapture as typeof fetch;

  try {
    const storage = new GitHubStorage({ owner: 'test-owner', repo: 'test-repo' });

    // Test alpha version
    await storage.saveRelease({
      version: '1.0.0-alpha.0',
      tag: 'v1.0.0-alpha.0',
      sha: 'abc123',
      createdAt: new Date(),
    });
    let parsed = JSON.parse(capturedBody!);
    assertEquals(parsed.prerelease, true);

    // Test beta version
    await storage.saveRelease({
      version: '1.0.0-beta.1',
      tag: 'v1.0.0-beta.1',
      sha: 'abc123',
      createdAt: new Date(),
    });
    parsed = JSON.parse(capturedBody!);
    assertEquals(parsed.prerelease, true);

    // Test rc version
    await storage.saveRelease({
      version: '1.0.0-rc.0',
      tag: 'v1.0.0-rc.0',
      sha: 'abc123',
      createdAt: new Date(),
    });
    parsed = JSON.parse(capturedBody!);
    assertEquals(parsed.prerelease, true);

    // Test stable version
    await storage.saveRelease({
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'abc123',
      createdAt: new Date(),
    });
    parsed = JSON.parse(capturedBody!);
    assertEquals(parsed.prerelease, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
