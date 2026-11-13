/**
 * Check the simulated REST API against GitHub's OpenAPI description.
 *
 *   deno run -A sim/spec/conformance.ts [--verbose]
 *
 * Drives every operation the simulator implements, including its error
 * paths, and checks each response twice: the status code must be one the
 * description documents for that operation, and the body must validate
 * against the schema the description gives for that status.
 *
 * The description is downloaded once into sim/.cache/spec/.
 */

import { GitHubSim } from '../github/server.ts';
import { cacheDir } from '../tools/install.ts';
import { loadSpec, pathPattern, ROUTES } from './routes.ts';

type Schema = Record<string, unknown>;

const spec = await loadSpec(`${cacheDir}/spec/api.github.com.json`);
const components = spec.components as {
  schemas: Record<string, Schema>;
  responses: Record<string, Schema>;
};
const paths = spec.paths as Record<string, Record<string, { responses: Record<string, Schema> }>>;

// --- a JSON Schema validator for the subset OpenAPI 3.0 uses ---

function resolve(s: Schema): Schema {
  let cur = s;
  for (let i = 0; i < 10 && typeof cur.$ref === 'string'; i++) {
    const [, , kind, name] = (cur.$ref as string).split('/');
    cur = (components as unknown as Record<string, Record<string, Schema>>)[kind][name];
  }
  return cur;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function validate(schemaIn: Schema, value: unknown, at = '$'): string[] {
  const schema = resolve(schemaIn);
  if (value === null && (schema.nullable === true || schema.type === 'null')) return [];
  const errors: string[] = [];

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf as Schema[]) errors.push(...validate(part, value, at));
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(schema[key])) continue;
    const results = (schema[key] as Schema[]).map((option) => validate(option, value, at));
    if (!results.some((r) => r.length === 0)) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(`${at}: matches no ${key} alternative (closest: ${best.slice(0, 2).join('; ')})`);
    }
  }

  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) {
      errors.push(`${at}: is ${actual}, expected ${allowed.join(' or ')}`);
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (actual === 'string') {
    const text = value as string;
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(text))) {
      errors.push(`${at}: "${text}" is not a date-time`);
    }
    if (schema.format === 'uri' && !URL.canParse(text)) {
      errors.push(`${at}: "${text}" is not a URI`);
    }
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[]) ?? []) {
      if (!(key in obj)) errors.push(`${at}.${key}: required property is missing`);
    }
    const props = (schema.properties as Record<string, Schema>) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validate(sub, obj[key], `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${at}.${key}: property is not in the schema`);
      }
    }
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).slice(0, 5).forEach((item, i) => {
      errors.push(...validate(schema.items as Schema, item, `${at}[${i}]`));
    });
  }
  return errors;
}

const LINKS = new Set(['url', 'html_url', 'git_url', 'download_url', 'clone_url', 'upload_url']);

/** Paths of primary link fields that still hold the generator's placeholder. */
function placeholders(value: unknown, at = '$', depth = 0): string[] {
  if (value === null || typeof value !== 'object' || depth > 3) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 2).flatMap((v, i) => placeholders(v, `${at}[${i}]`, depth));
  }
  const out: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // People and nested repositories are identified by login and name; their links are not followed.
    if (
      ['user', 'owner', 'author', 'committer', 'merged_by', 'repo', 'archived_by'].includes(key)
    ) {
      continue;
    }
    if (typeof v === 'string' && LINKS.has(key) && v.includes('sim-placeholder')) {
      out.push(`${at}.${key}`);
    } else out.push(...placeholders(v, `${at}.${key}`, depth + 1));
  }
  return out;
}

// --- driving the simulator ---

const matchers = ROUTES.map(([method, path]) => ({
  method: method.toUpperCase(),
  path,
  regex: new RegExp(pathPattern(path)),
}));

interface Finding {
  call: string;
  status: number;
  operation: string;
  problems: string[];
}

const findings: Finding[] = [];
/** Calls answered with a generic error status the description does not list for the operation. */
const generic: string[] = [];
const exercised = new Set<string>();
let checked = 0;

const sim = await GitHubSim.start();
const model = sim.model;
const repo = await model.createRepo('acme', 'widget');
const pat = model.mintToken('pat', model.user('maintainer'));
const readOnly = model.mintToken('actions', model.user('github-actions[bot]', 'Bot'), {
  contents: 'read',
});
const R = '/repos/acme/widget';

async function call(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = pat.value,
): Promise<{ status: number; json: Record<string, unknown> & unknown[] }> {
  const res = await fetch(sim.url + path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  const pathname = path.split('?')[0];
  const op = matchers.find((m) => m.method === method && m.regex.test(pathname));
  const label = `${method} ${path}`;
  checked++;
  if (!op) {
    findings.push({
      call: label,
      status: res.status,
      operation: '-',
      problems: ['no such operation in the route table'],
    });
    return { status: res.status, json };
  }
  exercised.add(`${op.method} ${op.path}`);
  const responses = paths[op.path][op.method.toLowerCase()].responses;
  const problems: string[] = [];
  let documented = responses[String(res.status)];
  if (!documented) {
    // The description does not list the generic authentication and not-found
    // errors on every operation; the API returns them everywhere.
    if ([401, 403, 404].includes(res.status)) generic.push(`${label} -> ${res.status}`);
    else {
      problems.push(
        `status ${res.status} is not documented (documented: ${Object.keys(responses).join(', ')})`,
      );
    }
  } else {
    if (typeof documented.$ref === 'string') {
      documented = components.responses[(documented.$ref as string).split('/').pop()!];
    }
    const schema = (documented.content as Record<string, { schema?: Schema }> | undefined)
      ?.['application/json']?.schema;
    if (schema) problems.push(...validate(schema, json));
    else if (json !== null && res.status < 400) {
      problems.push('a body was returned where none is documented');
    }
  }
  // Schema-valid is not enough: the links clients follow must be real, not filled-in defaults.
  for (const where of placeholders(json)) {
    problems.push(`${where}: is a placeholder, not a real link`);
  }
  if (problems.length > 0) {
    findings.push({
      call: label,
      status: res.status,
      operation: `${op.method} ${op.path}`,
      problems,
    });
  }
  return { status: res.status, json };
}

// Seed: two commits on main, a branch ahead of main, a lightweight and an annotated tag.
const who = { name: 'maintainer', email: 'm@example.com' };
const blobA = await repo.git.writeBlob(new TextEncoder().encode('{"version":"1.0.0"}\n'));
const tree1 = await repo.git.writeTree(null, [{
  path: 'package.json',
  mode: '100644',
  sha: blobA,
}]);
const c1 = await repo.git.writeCommit(tree1, [], 'feat: initial', who);
const blobB = await repo.git.writeBlob(new TextEncoder().encode('readme\n'));
const tree2 = await repo.git.writeTree(tree1, [{
  path: 'docs/README.md',
  mode: '100644',
  sha: blobB,
}]);
const c2 = await repo.git.writeCommit(tree2, [c1], 'docs: readme', who);
await repo.git.updateRef('refs/heads/main', c2);
const tree3 = await repo.git.writeTree(tree2, [{
  path: 'feature.txt',
  mode: '100644',
  sha: blobB,
}]);
const c3 = await repo.git.writeCommit(tree3, [c2], 'feat: feature', who);
await repo.git.updateRef('refs/heads/topic', c3);
await repo.git.updateRef('refs/heads/other', c3);
await repo.git.updateRef('refs/tags/v0.8.0', c1);
const tagObject = await repo.git.writeTag('v0.9.0', c1, 'commit', 'Release v0.9.0', who);
await repo.git.updateRef('refs/tags/v0.9.0', tagObject);

try {
  await call('GET', R);
  await call('GET', '/repos/acme/missing');
  await call('GET', `${R}/contents/package.json`);
  await call('GET', `${R}/contents/docs`);
  await call('GET', `${R}/contents/missing.txt`);
  await call('PUT', `${R}/contents/new.txt`, {
    message: 'chore: add file',
    content: btoa('hello\n'),
  });
  await call('PUT', `${R}/contents/new.txt`, {
    message: 'x',
    content: btoa('x'),
    sha: 'f'.repeat(40),
  });

  const blob = await call('POST', `${R}/git/blobs`, { content: 'text', encoding: 'utf-8' });
  await call('GET', `${R}/git/blobs/${blob.json.sha}`);
  await call('GET', `${R}/git/blobs/${'0'.repeat(40)}`);
  const main = (await call('GET', `${R}/git/ref/heads/main`)).json as unknown as {
    object: { sha: string };
  };
  const head = main.object.sha;
  const commitJson = await call('GET', `${R}/git/commits/${head}`);
  const baseTree = (commitJson.json.tree as { sha: string }).sha;
  const tree = await call('POST', `${R}/git/trees`, {
    base_tree: baseTree,
    tree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: blob.json.sha }],
  });
  await call('GET', `${R}/git/trees/${tree.json.sha}`);
  await call('GET', `${R}/git/trees/main?recursive=1`);
  const commit = await call('POST', `${R}/git/commits`, {
    message: 'chore: api commit',
    tree: tree.json.sha,
    parents: [head],
  });
  await call('POST', `${R}/git/commits`, { message: 'bad', tree: '0'.repeat(40), parents: [head] });
  const tag = await call('POST', `${R}/git/tags`, {
    tag: 'v1.0.0',
    message: 'Release',
    object: commit.json.sha,
    type: 'commit',
  });
  await call('GET', `${R}/git/tags/${tag.json.sha}`);
  await call('GET', `${R}/git/ref/tags/v0.9.0`);
  await call('GET', `${R}/git/ref/tags/nope`);
  await call('GET', `${R}/git/matching-refs/tags/v0`);
  await call('POST', `${R}/git/refs`, { ref: 'refs/tags/v1.0.0', sha: tag.json.sha });
  await call('POST', `${R}/git/refs`, { ref: 'refs/tags/v1.0.0', sha: tag.json.sha });
  await call('POST', `${R}/git/refs`, { ref: 'refs/heads/api-branch', sha: commit.json.sha });
  await call('PATCH', `${R}/git/refs/heads/api-branch`, { sha: c1 });
  await call('PATCH', `${R}/git/refs/heads/api-branch`, { sha: c1, force: true });
  await call('PATCH', `${R}/git/refs/heads/nope`, { sha: c1 });
  await call('DELETE', `${R}/git/refs/heads/api-branch`);
  await call('DELETE', `${R}/git/refs/heads/api-branch`);
  await call('POST', `${R}/git/refs`, { ref: 'refs/heads/x', sha: c1 }, null);
  await call('POST', `${R}/git/refs`, { ref: 'refs/heads/x', sha: c1 }, readOnly.value);

  await call('GET', `${R}/branches`);
  await call('GET', `${R}/branches/main`);
  await call('GET', `${R}/branches/nope`);
  await call('GET', `${R}/commits`);
  await call('GET', `${R}/commits/main`);
  await call('GET', `${R}/commits/${c3}/pulls`);
  await call('GET', `${R}/tags`);
  await call('GET', `${R}/compare/main...topic`);
  await call('GET', `${R}/compare/main...nope`);

  const pr = await call('POST', `${R}/pulls`, {
    title: 'Feature',
    head: 'topic',
    base: 'main',
    body: 'text',
  });
  await call('POST', `${R}/pulls`, { title: 'Feature', head: 'topic', base: 'main' });
  await call('POST', `${R}/pulls`, { title: 'Feature', head: 'nope', base: 'main' });
  await call(
    'POST',
    `${R}/pulls`,
    { title: 'Feature', head: 'other', base: 'main' },
    readOnly.value,
  );
  const n = pr.json.number;
  await call('GET', `${R}/pulls`);
  await call('GET', `${R}/pulls?state=all&head=acme:topic`);
  await call('GET', `${R}/pulls/${n}`);
  await call('GET', `${R}/pulls/999`);
  await call('PATCH', `${R}/pulls/${n}`, { title: 'Feature, reworded', body: 'new text' });
  await call('GET', `${R}/pulls/${n}/commits`);
  await call('GET', `${R}/pulls/${n}/files`);
  await call('GET', `${R}/commits/${c3}/pulls`);

  await call('GET', `${R}/issues`);
  await call('GET', `${R}/issues/${n}`);
  await call('PATCH', `${R}/issues/${n}`, { labels: ['bug'] });
  await call('GET', `${R}/issues/${n}/labels`);
  await call('POST', `${R}/issues/${n}/labels`, { labels: ['release'] });
  await call('PUT', `${R}/issues/${n}/labels`, { labels: ['release', 'bug'] });
  await call('DELETE', `${R}/issues/${n}/labels/bug`);
  await call('DELETE', `${R}/issues/${n}/labels/nope`);
  await call('POST', `${R}/issues/${n}/comments`, { body: 'a comment' });
  await call('GET', `${R}/issues/${n}/comments`);
  await call('GET', `${R}/labels`);
  await call('POST', `${R}/labels`, { name: 'new-label', color: 'ff0000' });
  await call('POST', `${R}/labels`, { name: 'new-label' });
  await call('GET', `${R}/labels/new-label`);
  await call('GET', `${R}/labels/nope`);
  await call('GET', `/search/issues?q=${encodeURIComponent('repo:acme/widget is:pr Feature')}`);

  await call('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'squash', sha: '0'.repeat(40) });
  await call('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'squash' });
  await call('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'squash' });
  await call('PUT', `${R}/pulls/999/merge`, {});
  await call('GET', `${R}/pulls/${n}`);
  await call('GET', `${R}/pulls?state=closed`);
  await call('POST', `${R}/merges`, { base: 'main', head: 'other' });
  await call('POST', `${R}/merges`, { base: 'main', head: 'other' });
  await call('POST', `${R}/merges`, { base: 'main', head: 'nope' });

  const release = await call('POST', `${R}/releases`, {
    tag_name: 'v1.0.0',
    name: 'v1.0.0',
    body: 'notes',
  });
  await call('POST', `${R}/releases`, { tag_name: 'v1.0.0' });
  await call('POST', `${R}/releases`, { tag_name: 'v1.1.0', draft: true });
  await call('POST', `${R}/releases`, { tag_name: 'v2.0.0', target_commitish: 'nope' });
  await call('GET', `${R}/releases`);
  await call('GET', `${R}/releases/latest`);
  await call('GET', `${R}/releases/tags/v1.0.0`);
  await call('GET', `${R}/releases/tags/v1.1.0`);
  await call('GET', `${R}/releases/${release.json.id}`);
  await call('GET', `${R}/releases/1`);
  await call('PATCH', `${R}/releases/${release.json.id}`, { body: 'better notes' });
  await call('POST', `${R}/releases/generate-notes`, {
    tag_name: 'v1.0.0',
    previous_tag_name: 'v0.9.0',
  });
  await call('DELETE', `${R}/releases/${release.json.id}`);
  await call('DELETE', `${R}/releases/${release.json.id}`);

  await call('POST', `${R}/dispatches`, { event_type: 'ping' });
  await call('POST', `${R}/actions/workflows/release.yml/dispatches`, { ref: 'main' });
  await call('GET', '/user');
  await call('GET', '/rate_limit');
} finally {
  await sim.close();
}

// --- report ---

const verbose = Deno.args.includes('--verbose');
const notExercised = ROUTES.map(([m, p]) => `${m.toUpperCase()} ${p}`).filter((r) =>
  !exercised.has(r)
);
const info = spec.info as { version: string };
console.log(`GitHub OpenAPI description ${info.version}`);
console.log(`${checked} calls checked across ${exercised.size} of ${ROUTES.length} operations`);
if (notExercised.length > 0) console.log(`Not exercised: ${notExercised.join(', ')}`);
if (generic.length > 0) {
  console.log(
    `${generic.length} generic 401/403/404 answers on operations where the description does not list them` +
      (verbose ? `:\n  ${generic.join('\n  ')}` : ''),
  );
}
if (findings.length === 0) {
  console.log('All status codes are documented and all bodies validate.');
} else {
  console.log(`${findings.length} call(s) with problems:\n`);
  for (const f of findings) {
    console.log(`${f.call} -> ${f.status}   [${f.operation}]`);
    const shown = verbose ? f.problems : f.problems.slice(0, 6);
    for (const p of shown) console.log(`    ${p}`);
    if (shown.length < f.problems.length) {
      console.log(`    ... ${f.problems.length - shown.length} more`);
    }
  }
  Deno.exit(1);
}
