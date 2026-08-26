import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createTmdbClient, TmdbAuthFailed, TmdbRateLimited,
} from '../../lib/providers/tmdb/client';
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
  return createTmdbClient({
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
  assert.ok(!call.url.includes('api_key'), 'no api_key query parameter');
});

test('undefined query values are omitted rather than sent as the string undefined', async () => {
  const { fetchImpl, calls } = stub(() => Response.json({ id: 1, title: 'x' }));
  await client(fetchImpl)
    .get('/search/movie', { query: 'Outbreak', primary_release_year: undefined }, schema, ctx);
  const url = calls[0]?.url ?? '';
  assert.ok(url.includes('query=Outbreak'));
  assert.ok(!url.includes('primary_release_year'), url);
});

test('a 404 is null, not an error', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 404 }));
  assert.equal(await client(fetchImpl).get('/movie/0', {}, schema, ctx), null);
});

test('a 401 throws TmdbAuthFailed, which is not retryable', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 401 }));
  await assert.rejects(client(fetchImpl).get('/movie/1', {}, schema, ctx), TmdbAuthFailed);
});

test('a 429 throws TmdbRateLimited and carries Retry-After when present', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 429, headers: { 'retry-after': '7' } }));
  await assert.rejects(
    client(fetchImpl).get('/movie/1', {}, schema, ctx),
    (e: unknown) => e instanceof TmdbRateLimited && e.retryAfterSeconds === 7,
  );
});

test('a malformed payload is a validation error, not a silent pass-through', async () => {
  const { fetchImpl } = stub(() => Response.json({ id: 'not-a-number' }));
  await assert.rejects(client(fetchImpl).get('/movie/1', {}, schema, ctx));
});

test('every call is recorded with a path and status but never the token', async () => {
  const rows: ProviderCallRecord[] = [];
  const { fetchImpl } = stub(() => Response.json({ id: 1, title: 'x' }));
  await client(fetchImpl, (r) => rows.push(r))
    .get('/search/movie', { query: 'Outbreak' }, schema, ctx);
  assert.equal(rows.length, 1);
  const row = JSON.stringify(rows[0]);
  assert.ok(row.includes('/search/movie'), row);
  assert.ok(row.includes('200'), row);
  assert.ok(!row.includes('test-token'), 'the token leaked into provider_calls');
  assert.ok(!row.includes('Outbreak'), 'query values should stay out of the log too');
});

test('an aborted signal rejects before the request is made', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = stub(() => Response.json({ id: 1, title: 'x' }));
  await assert.rejects(
    client(fetchImpl).get('/movie/1', {}, schema, { signal: controller.signal, lookupId: null }),
  );
  assert.equal(calls.length, 0, 'no request should be issued once aborted');
});
