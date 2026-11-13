/**
 * Complete REST responses to the shape GitHub's OpenAPI description requires.
 *
 * shapes.json is generated from that description (sim/spec/gen_shapes.ts).
 * Handlers return the fields that carry meaning; this fills every other
 * required property with a typed default, so clients see objects with the
 * same set of fields real responses have.
 */

import file from './shapes.json' with { type: 'json' };
import type { ShapesFile } from '../spec/gen_shapes.ts';

const data = file as unknown as ShapesFile;
const routes = data.routes.map((r) => ({ ...r, regex: new RegExp(r.pattern) }));

export const specVersion = data.specVersion;

function substitute(value: unknown, base: string): unknown {
  return typeof value === 'string' ? value.replace('{base}', base) : value;
}

export function complete(shapeName: string, value: unknown, base: string, depth = 0): unknown {
  const shape = data.shapes[shapeName];
  if (!shape || value === null || typeof value !== 'object' || Array.isArray(value) || depth > 8) {
    return value;
  }
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, def] of Object.entries(shape.defaults)) {
    if (out[key] === undefined) out[key] = substitute(def, base);
  }
  for (const [key, p] of Object.entries(shape.props)) {
    const v = out[key];
    if (v === undefined) {
      if (!p.required) continue;
      out[key] = p.nullable ? null : p.array ? [] : complete(p.shape, {}, base, depth + 1);
    } else if (Array.isArray(v)) {
      out[key] = v.map((item) => complete(p.shape, item, base, depth + 1));
    } else if (v !== null && typeof v === 'object') {
      out[key] = complete(p.shape, v, base, depth + 1);
    }
  }
  return out;
}

/** The operation in the OpenAPI description that a request maps to, if any. */
export function operationFor(
  method: string,
  path: string,
): { path: string; responses: Record<string, { shape: string | null; array: boolean }> } | null {
  for (const r of routes) {
    if (r.method === method && r.regex.test(path)) return r;
  }
  return null;
}

/** Complete a response body for the operation and status it belongs to. */
export function completeResponse(
  method: string,
  path: string,
  status: number,
  body: unknown,
  base: string,
): unknown {
  const op = operationFor(method, path);
  const res = op?.responses[String(status)];
  if (!res?.shape) return body;
  if (res.array && Array.isArray(body)) return body.map((item) => complete(res.shape!, item, base));
  return complete(res.shape, body, base);
}
