/**
 * Generate sim/github/shapes.json from GitHub's OpenAPI description.
 *
 *   deno run -A sim/spec/gen_shapes.ts
 *
 * For every response of every operation the simulator implements, the file
 * records which schema the response has and, for each schema, a default value
 * for every required property. The server uses it to return complete objects:
 * handlers set the fields that carry meaning, the shape fills in the rest
 * (URL templates, counters, flags) so responses have the fields real ones have.
 */

import { cacheDir, repoRoot } from '../tools/install.ts';
import { loadSpec, pathPattern, ROUTES } from './routes.ts';

type Schema = Record<string, unknown>;

export interface Shape {
  /** Default for each required property that is not an object with its own shape. */
  defaults: Record<string, unknown>;
  /** Object-valued properties: name of the shape to complete them with. */
  props: Record<string, { shape: string; array: boolean; required: boolean; nullable: boolean }>;
}

export interface ShapesFile {
  specVersion: string;
  routes: Array<{
    method: string;
    path: string;
    pattern: string;
    responses: Record<string, { shape: string | null; array: boolean }>;
  }>;
  shapes: Record<string, Shape>;
}

const spec = await loadSpec(`${cacheDir}/spec/api.github.com.json`);
const schemas = (spec.components as { schemas: Record<string, Schema> }).schemas;
const shapes: Record<string, Shape> = {};

function deref(s: Schema): { schema: Schema; name: string | null } {
  let name: string | null = null;
  let cur = s;
  for (let i = 0; i < 10 && typeof cur.$ref === 'string'; i++) {
    name = (cur.$ref as string).split('/').pop()!;
    cur = schemas[name];
  }
  return { schema: cur, name };
}

/** Collapse allOf, and pick the first object-like alternative of oneOf/anyOf. */
function flatten(s: Schema): Schema {
  const { schema } = deref(s);
  if (Array.isArray(schema.allOf)) {
    const merged: Schema = { type: 'object', properties: {}, required: [] };
    for (const part of schema.allOf as Schema[]) {
      const f = flatten(part);
      Object.assign(merged.properties as object, f.properties ?? {});
      (merged.required as string[]).push(...((f.required as string[]) ?? []));
      if (f.nullable) merged.nullable = true;
    }
    if (schema.nullable) merged.nullable = true;
    return merged;
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      const options = (schema[key] as Schema[]).map((o) => flatten(o));
      const pick = options.find((o) => o.type === 'object' || o.properties) ?? options[0];
      return {
        ...pick,
        nullable: pick.nullable || schema.nullable || options.some((o) => o.type === 'null'),
      };
    }
  }
  return schema;
}

function isObject(s: Schema): boolean {
  return s.type === 'object' || s.properties !== undefined;
}

function scalarDefault(s: Schema): unknown {
  if (s.nullable || s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) {
    return null;
  }
  if (Array.isArray(s.enum)) return s.enum[0];
  switch (s.type) {
    case 'string':
      if (s.format === 'date-time') return '2020-01-01T00:00:00Z';
      if (s.format === 'uri') return '{base}/sim-placeholder';
      return '';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    default:
      return null;
  }
}

function shapeOf(schema: Schema, hint: string): string {
  const { name } = deref(schema);
  const key = name ?? hint;
  if (shapes[key]) return key;
  const flat = flatten(schema);
  const shape: Shape = { defaults: {}, props: {} };
  shapes[key] = shape;
  const required = new Set((flat.required as string[]) ?? []);
  for (const [prop, raw] of Object.entries((flat.properties as Record<string, Schema>) ?? {})) {
    const p = flatten(raw);
    const nullable = Boolean(p.nullable) || Boolean((raw as Schema).nullable);
    if (isObject(p)) {
      shape.props[prop] = {
        shape: shapeOf(raw, `${key}.${prop}`),
        array: false,
        required: required.has(prop),
        nullable,
      };
    } else if (p.type === 'array' && p.items && isObject(flatten(p.items as Schema))) {
      shape.props[prop] = {
        shape: shapeOf(p.items as Schema, `${key}.${prop}[]`),
        array: true,
        required: required.has(prop),
        nullable,
      };
      if (required.has(prop)) shape.defaults[prop] = nullable ? null : [];
    } else if (required.has(prop)) {
      shape.defaults[prop] = nullable ? null : scalarDefault(p);
    }
  }
  // The description sometimes requires a property it never defines; real
  // responses carry it as null.
  const defined = (flat.properties as Record<string, Schema>) ?? {};
  for (const prop of required) {
    if (!(prop in defined)) shape.defaults[prop] = null;
  }
  return key;
}

const out: ShapesFile = {
  specVersion: (spec.info as { version: string }).version,
  routes: [],
  shapes,
};
const paths = spec.paths as Record<string, Record<string, { responses: Record<string, Schema> }>>;
for (const [method, path] of ROUTES) {
  const op = paths[path]?.[method];
  if (!op) throw new Error(`${method.toUpperCase()} ${path} is not in the OpenAPI description`);
  const responses: Record<string, { shape: string | null; array: boolean }> = {};
  for (const [status, res] of Object.entries(op.responses)) {
    const resolved = typeof res.$ref === 'string'
      ? (spec.components as { responses: Record<string, Schema> }).responses[
        (res.$ref as string).split('/').pop()!
      ]
      : res;
    const media = (resolved.content as Record<string, { schema?: Schema }> | undefined)
      ?.['application/json'];
    if (!media?.schema) {
      responses[status] = { shape: null, array: false };
      continue;
    }
    const flat = flatten(media.schema);
    if (flat.type === 'array' && flat.items) {
      responses[status] = {
        shape: shapeOf(flat.items as Schema, `${method} ${path} ${status}[]`),
        array: true,
      };
    } else if (isObject(flat)) {
      responses[status] = {
        shape: shapeOf(media.schema, `${method} ${path} ${status}`),
        array: false,
      };
    } else {
      responses[status] = { shape: null, array: false };
    }
  }
  out.routes.push({ method: method.toUpperCase(), path, pattern: pathPattern(path), responses });
}

const target = `${repoRoot}/sim/github/shapes.json`;
await Deno.writeTextFile(target, JSON.stringify(out) + '\n');
console.log(
  `${target}: ${out.routes.length} operations, ${Object.keys(shapes).length} shapes, ` +
    `${(JSON.stringify(out).length / 1024).toFixed(0)} KB, from spec ${out.specVersion}`,
);
