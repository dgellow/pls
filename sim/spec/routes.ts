/**
 * The REST operations the simulator implements, as they are named in GitHub's
 * OpenAPI description. Shared by the shape generator and the conformance check.
 */

export const SPEC_URL =
  'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json';

const R = '/repos/{owner}/{repo}';

export const ROUTES: Array<[method: string, path: string]> = [
  ['get', R],
  ['get', `${R}/contents/{path}`],
  ['put', `${R}/contents/{path}`],
  ['post', `${R}/git/blobs`],
  ['get', `${R}/git/blobs/{file_sha}`],
  ['post', `${R}/git/trees`],
  ['get', `${R}/git/trees/{tree_sha}`],
  ['post', `${R}/git/commits`],
  ['get', `${R}/git/commits/{commit_sha}`],
  ['post', `${R}/git/tags`],
  ['get', `${R}/git/tags/{tag_sha}`],
  ['get', `${R}/git/ref/{ref}`],
  ['get', `${R}/git/matching-refs/{ref}`],
  ['post', `${R}/git/refs`],
  ['patch', `${R}/git/refs/{ref}`],
  ['delete', `${R}/git/refs/{ref}`],
  ['get', `${R}/branches`],
  ['get', `${R}/branches/{branch}`],
  ['get', `${R}/commits`],
  ['get', `${R}/commits/{commit_sha}/pulls`],
  ['get', `${R}/commits/{ref}`],
  ['get', `${R}/tags`],
  ['get', `${R}/compare/{basehead}`],
  ['post', `${R}/merges`],
  ['get', `${R}/pulls`],
  ['post', `${R}/pulls`],
  ['get', `${R}/pulls/{pull_number}`],
  ['patch', `${R}/pulls/{pull_number}`],
  ['put', `${R}/pulls/{pull_number}/merge`],
  ['get', `${R}/pulls/{pull_number}/commits`],
  ['get', `${R}/pulls/{pull_number}/files`],
  ['get', `${R}/issues`],
  ['get', `${R}/issues/{issue_number}`],
  ['patch', `${R}/issues/{issue_number}`],
  ['get', `${R}/issues/{issue_number}/labels`],
  ['post', `${R}/issues/{issue_number}/labels`],
  ['put', `${R}/issues/{issue_number}/labels`],
  ['delete', `${R}/issues/{issue_number}/labels/{name}`],
  ['get', `${R}/issues/{issue_number}/comments`],
  ['post', `${R}/issues/{issue_number}/comments`],
  ['get', `${R}/labels`],
  ['post', `${R}/labels`],
  ['get', `${R}/labels/{name}`],
  ['get', `${R}/releases`],
  ['post', `${R}/releases`],
  ['post', `${R}/releases/generate-notes`],
  ['get', `${R}/releases/latest`],
  ['get', `${R}/releases/tags/{tag}`],
  ['get', `${R}/releases/{release_id}`],
  ['patch', `${R}/releases/{release_id}`],
  ['delete', `${R}/releases/{release_id}`],
  ['post', `${R}/dispatches`],
  ['post', `${R}/actions/workflows/{workflow_id}/dispatches`],
  ['get', '/user'],
  ['get', '/rate_limit'],
  ['get', '/search/issues'],
];

/** Parameters that may contain slashes. */
const GREEDY = new Set(['path', 'ref', 'basehead', 'tag', 'name', 'branch']);

export function pathPattern(path: string): string {
  const body = path.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(
    /\{(\w+)\}/g,
    (_m, name) => (GREEDY.has(name) ? '.+' : '[^/]+'),
  );
  return `^${body}$`;
}

export async function loadSpec(cacheFile: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(cacheFile));
  } catch {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`could not download the OpenAPI description: ${res.status}`);
    const text = await res.text();
    await Deno.mkdir(cacheFile.slice(0, cacheFile.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(cacheFile, text);
    return JSON.parse(text);
  }
}
