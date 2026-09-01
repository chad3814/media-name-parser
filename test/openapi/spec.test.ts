import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSpec } from '../../lib/openapi/spec';
import { BATCH_CAP } from '../../lib/http/lookupHandler';
import { GET as specRoute } from '../../app/api/openapi.json/route';
import type { LookupEnvelope } from '../../lib/http/envelope';

/** Narrowing helper: the spec is a plain JSON tree, walked structurally. */
function obj(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(typeof value === 'object' && value !== null, 'expected an object');
  return value as Readonly<Record<string, unknown>>;
}

const spec = buildSpec();
const paths = obj(spec.paths);

/** Every `route.ts` under `app/api/v1`, as the OpenAPI path it serves. */
async function v1Routes(): Promise<readonly { path: string; source: string }[]> {
  const root = 'app/api/v1';
  const found: { path: string; source: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (entry.name !== 'route.ts') return;
      const rel = dir.slice('app'.length);
      found.push({
        // `[id]` is Next's dynamic segment; `{id}` is OpenAPI's.
        path: rel.replaceAll('[', '{').replaceAll(']', '}'),
        source: await readFile(full, 'utf8'),
      });
    }));
  };
  await walk(root);
  return found;
}

/** A route is this application's own if it authenticates a signed-in human. */
function isSessionAuthenticated(source: string): boolean {
  return /requireAdmin|requireUser|sessionGate/.test(source);
}

test('every key-authenticated v1 route is described', async () => {
  // The pin that matters. A new route under /api/v1 that takes an API key is a
  // new part of the public contract, and adding one without documenting it is
  // the failure this test exists to catch -- the spec is hand-assembled, so
  // nothing else would notice.
  const routes = await v1Routes();
  assert.ok(routes.length >= 5, `expected to find the v1 routes, found ${routes.length}`);
  const undocumented = routes
    .filter((route) => !isSessionAuthenticated(route.source))
    .map((route) => route.path)
    .filter((path) => !(path in paths));
  assert.deepEqual(undocumented, [],
    `these v1 routes take an API key but are absent from the spec: ${undocumented.join(', ')}`);
});

test('the routes left out are left out for being session-authenticated', async () => {
  // The other half of the test above: if `/api/v1/admin/whoami` ever stopped
  // using a session, the filter would quietly start demanding it be
  // documented, or -- worse -- keep excusing a route that now takes a key.
  const routes = await v1Routes();
  const excluded = routes.filter((route) => isSessionAuthenticated(route.source));
  assert.deepEqual(excluded.map((route) => route.path), ['/api/v1/admin/whoami']);
  for (const route of excluded) {
    assert.ok(!(route.path in paths), `${route.path} is session-authenticated and must not be described`);
  }
});

test('the request body is derived from the live zod schema, not copied', () => {
  const schemas = obj(obj(spec.components).schemas);
  const single = obj(schemas.LookupRequest);
  const properties = obj(single.properties);
  // `minLength` exists only because the schema says `.min(1)`; a hand-written
  // copy would not have grown it.
  assert.equal(obj(properties.name).minLength, 1);
  assert.deepEqual(obj(properties.category).enum, ['tv', 'movies', 'books', 'xxx']);

  const items = obj(obj(obj(schemas.LookupBatchRequest).properties).items);
  assert.equal(items.maxItems, BATCH_CAP,
    'the documented batch cap must come from BATCH_CAP, not a literal');
  assert.equal(items.minItems, 1);
});

test('the documented envelope names every field the type carries', () => {
  // Typed, so adding a field to LookupEnvelope makes this literal fail to
  // compile until it is listed here, and then fail this assertion until it is
  // documented. That chain is what stops the response schema drifting.
  const sample: LookupEnvelope = {
    lookupId: 'id', state: 'resolved', partial: false, cached: false,
    confidence: null, refusal: null, parsed: null, media: null, suggestions: null,
  };
  const documented = obj(obj(obj(spec.components).schemas).LookupEnvelope);
  assert.deepEqual(
    [...(documented.required as readonly string[])].sort(),
    Object.keys(sample).sort(),
  );
});

test('every $ref resolves to a component that exists', () => {
  const schemas = obj(obj(spec.components).schemas);
  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') refs.push(child);
      else walk(child);
    }
  };
  walk(spec);
  assert.ok(refs.length > 0, 'the spec should use refs');
  for (const ref of refs) {
    const name = ref.replace('#/components/schemas/', '');
    assert.ok(name in schemas, `${ref} points at a component that does not exist`);
  }
});

test('every operation requires the API key, except the liveness probe', () => {
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(obj(item))) {
      const security = obj(operation).security;
      if (path === '/api/v1/health') {
        assert.deepEqual(security, [], 'health must stay callable without a key');
      } else {
        assert.equal(security, undefined,
          `${method.toUpperCase()} ${path} should inherit the document's security, not override it`);
      }
    }
  }
  // Inheriting means the document-level requirement has to actually be there.
  assert.deepEqual(spec.security, [{ apiKey: [] }]);
});

test('the spec route serves JSON and needs no credential', async () => {
  const response = specRoute();
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /application\/json/);
  const body = obj(await response.json());
  assert.equal(body.openapi, '3.1.0');
  assert.ok('paths' in body);
});
