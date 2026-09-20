import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createTvdbClient, TvdbAuthFailed, tvdbKeyFromEnv } from '../../lib/providers/tvdb/client';
import type { ProviderCallRecord } from '../../lib/providers/types';

const ctx = { signal: new AbortController().signal, lookupId: null };
const bodySchema = z.object({ data: z.object({ id: z.number() }) });

/** A JWT-shaped string. Only the payload is ever decoded. */
function jwt(expSecondsFromNow: number): string {
  const payload = Buffer
    .from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }))
    .toString('base64url');
  return `header.${payload}.signature`;
}

interface Call { readonly url: string; readonly method: string; readonly auth: string | null }

function fakeFetch(calls: Call[], handler: (url: string) => Response): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    return handler(url);
  }) as typeof fetch;
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('the first call logs in, and the second reuses the token', async () => {
  const calls: Call[] = [];
  const token = jwt(3600);
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch(calls, (url) => (url.endsWith('/login')
      ? ok({ data: { token } })
      : ok({ data: { id: 1 } }))),
  });

  await client.get('/series/1', {}, bodySchema, ctx);
  await client.get('/series/2', {}, bodySchema, ctx);

  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'POST /v4/login', 'GET /v4/series/1', 'GET /v4/series/2',
  ], 'one login, then both requests');
  assert.equal(calls[1]?.auth, `Bearer ${token}`);
});

test('the credential never reaches a recorded call', async () => {
  const rows: ProviderCallRecord[] = [];
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    recordCall: (row) => rows.push(row),
    fetchImpl: fakeFetch([], (url) => (url.endsWith('/login')
      ? ok({ data: { token: jwt(3600) } })
      : ok({ data: { id: 1 } }))),
  });
  await client.get('/series/1', { season: 2 }, bodySchema, ctx);

  assert.equal(rows.length, 1, 'the login is infrastructure, not a lookup to report');
  assert.equal(rows[0]?.provider, 'tvdb');
  assert.equal(rows[0]?.endpoint, '/series/1', 'the path, never the query or the URL');
  const serialised = JSON.stringify(rows);
  assert.ok(!serialised.includes('secret-key'), 'no api key anywhere in the record');
  assert.ok(!serialised.includes('Bearer'), 'no token anywhere in the record');
});

test('a 401 on a data call logs in again and retries once', async () => {
  const calls: Call[] = [];
  let served401 = false;
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch(calls, (url) => {
      if (url.endsWith('/login')) return ok({ data: { token: jwt(3600) } });
      if (!served401) { served401 = true; return new Response('', { status: 401 }); }
      return ok({ data: { id: 7 } });
    }),
  });

  const out = await client.get('/series/1', {}, bodySchema, ctx);
  assert.deepEqual(out, { data: { id: 7 } });
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), [
    '/v4/login', '/v4/series/1', '/v4/login', '/v4/series/1',
  ], 'a stale token is refreshed and the call repeated exactly once');
});

test('a second 401 after a fresh token is a credential failure', async () => {
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch([], (url) => (url.endsWith('/login')
      ? ok({ data: { token: jwt(3600) } })
      : new Response('', { status: 401 }))),
  });
  await assert.rejects(
    () => client.get('/series/1', {}, bodySchema, ctx),
    (error: Error) => error instanceof TvdbAuthFailed,
  );
});

test('a rejected login is a credential failure, not a generic error', async () => {
  // `ProviderAuthFailed` is what tells the sweeper this is terminal rather
  // than a slow network worth retrying six times.
  const client = createTvdbClient({
    apiKey: 'wrong',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch([], () => new Response('', { status: 401 })),
  });
  await assert.rejects(
    () => client.get('/series/1', {}, bodySchema, ctx),
    (error: Error) => error instanceof TvdbAuthFailed,
  );
});

test('404 is absence, not failure', async () => {
  const client = createTvdbClient({
    apiKey: 'k',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch([], (url) => (url.endsWith('/login')
      ? ok({ data: { token: jwt(3600) } })
      : new Response('', { status: 404 }))),
  });
  assert.equal(await client.get('/series/999999', {}, bodySchema, ctx), null);
});

test('an expired cached token is replaced before the call', async () => {
  const calls: Call[] = [];
  let issued = 0;
  const client = createTvdbClient({
    apiKey: 'k',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch(calls, (url) => {
      if (url.endsWith('/login')) {
        issued += 1;
        return ok({ data: { token: jwt(issued === 1 ? -10 : 3600) } });
      }
      return ok({ data: { id: 1 } });
    }),
  });
  await client.get('/series/1', {}, bodySchema, ctx);
  await client.get('/series/2', {}, bodySchema, ctx);
  assert.equal(issued, 2, 'the already-expired token is not reused');
});

test('two concurrent first calls share one login', async () => {
  // A cold instance resolving two lookups at once would otherwise exchange
  // the key twice, and the second token would replace the first mid-use.
  let logins = 0;
  const client = createTvdbClient({
    apiKey: 'k',
    ratePerSecond: 1000,
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/login')) {
        logins += 1;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return ok({ data: { token: jwt(3600) } });
      }
      return ok({ data: { id: 1 } });
    }) as typeof fetch,
  });
  await Promise.all([
    client.get('/series/1', {}, bodySchema, ctx),
    client.get('/series/2', {}, bodySchema, ctx),
  ]);
  assert.equal(logins, 1);
});

test('the env reader refuses an unset key rather than calling with an empty one', () => {
  const before = process.env.TVDB_API_KEY;
  delete process.env.TVDB_API_KEY;
  try {
    assert.throws(() => tvdbKeyFromEnv(), /TVDB_API_KEY/);
  } finally {
    if (before !== undefined) process.env.TVDB_API_KEY = before;
  }
});
