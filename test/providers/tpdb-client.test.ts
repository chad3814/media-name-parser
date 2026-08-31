import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createTpdbClient, TpdbAuthFailed, tpdbTokenFromEnv,
} from '../../lib/providers/tpdb/client';
import { sceneListSchema } from '../../lib/providers/tpdb/schema';
import type { ProviderCallRecord } from '../../lib/providers/types';

const schema = z.object({ id: z.number(), title: z.string() });

function stub(handler: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler();
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch, onCall?: (row: ProviderCallRecord) => void) {
  return createTpdbClient({
    token: 'test-token',
    fetchImpl,
    recordCall: onCall ?? ((): void => {}),
    ratePerSecond: 1000,
  });
}

const ctx = { signal: new AbortController().signal, lookupId: null };

test('the bearer token goes in the Authorization header, never the query', async () => {
  const { fetchImpl, calls } = stub(() => Response.json({ id: 1, title: 'x' }));
  await client(fetchImpl).get('/movie/1', {}, schema, ctx);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer test-token');
  assert.ok(!call.url.includes('test-token'), 'the token must not appear in the URL');
});

test('a 404 is null, not an error', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 404 }));
  assert.equal(await client(fetchImpl).get('/scenes/0', {}, schema, ctx), null);
});

test('a 401 throws TpdbAuthFailed, which is not retryable', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 401 }));
  await assert.rejects(client(fetchImpl).get('/scenes', {}, schema, ctx), TpdbAuthFailed);
});

test('a valid scene list body parses', async () => {
  const body = {
    data: [{
      id: 'adf4b545-8b59-4bad-a935-4f5ec83a16db',
      title: 'A Scene',
      date: '2024-01-01',
      duration: 2340,
      description: 'overview text',
      site_id: 1,
      site: { id: 1, name: 'SpankMonster', short_name: 'spankmonster' },
      performers: [{ id: 'p1', name: 'Ruby Redbottom', parent: { id: 'pp1', name: 'Ruby' } }],
    }],
    meta: { total: 1 },
  };
  const { fetchImpl } = stub(() => Response.json(body));
  const result = await client(fetchImpl).get('/scenes', {}, sceneListSchema, ctx);
  assert.equal(result?.data[0]?.title, 'A Scene');
  assert.equal(result?.data[0]?.performers[0]?.name, 'Ruby Redbottom');
});

test('a body with unknown extra fields still parses', async () => {
  const body = {
    data: [{
      id: 'x',
      title: 'A Scene',
      extra_field_from_the_future: 'ignore me',
      performers: [{ id: 'p1', name: 'A', extra: true }],
    }],
    extra_top_level: 'ignore me too',
  };
  const { fetchImpl } = stub(() => Response.json(body));
  const result = await client(fetchImpl).get('/scenes', {}, sceneListSchema, ctx);
  assert.equal(result?.data[0]?.title, 'A Scene');
});

test('recordCall receives the path, status, and a duration but never the token', async () => {
  const rows: ProviderCallRecord[] = [];
  const { fetchImpl } = stub(() => Response.json({ data: [] }));
  await client(fetchImpl, (r) => rows.push(r))
    .get('/scenes', { q: 'SpankMonster Ruby Redbottom' }, sceneListSchema, ctx);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.endpoint, '/scenes');
  assert.equal(row.status, 200);
  assert.equal(typeof row.durationMs, 'number');
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes('test-token'), 'the token leaked into provider_calls');
  assert.ok(!serialized.includes('SpankMonster Ruby Redbottom'), 'query values should stay out of the log too');
});

test('the recorded call never carries the credential', async () => {
  const rows: ProviderCallRecord[] = [];
  const client2 = createTpdbClient({
    token: 'sekrit-token-value',
    recordCall: (r) => rows.push(r),
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  });
  await client2.get('/scenes', { q: 'x' }, sceneListSchema, ctx);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0]).includes('sekrit-token-value'),
    'a provider_calls row must never be able to leak the key');
});

test('an aborted signal rejects before the request is made', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = stub(() => Response.json({ data: [] }));
  await assert.rejects(
    client(fetchImpl).get('/scenes', {}, sceneListSchema, { signal: controller.signal, lookupId: null }),
  );
  assert.equal(calls.length, 0, 'no request should be issued once aborted');
});

test('tpdbTokenFromEnv throws a clear message when the variable is absent', () => {
  const saved = process.env.TPDB_API_KEY;
  delete process.env.TPDB_API_KEY;
  try {
    assert.throws(() => tpdbTokenFromEnv(), /TPDB_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.TPDB_API_KEY = saved;
  }
});

test('tpdbTokenFromEnv returns the value when set', () => {
  const saved = process.env.TPDB_API_KEY;
  process.env.TPDB_API_KEY = 'a-value';
  try {
    assert.equal(tpdbTokenFromEnv(), 'a-value');
  } finally {
    if (saved === undefined) delete process.env.TPDB_API_KEY;
    else process.env.TPDB_API_KEY = saved;
  }
});
