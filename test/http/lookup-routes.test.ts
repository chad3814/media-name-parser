import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { handleLookup, handlePoll } from '../../lib/http/lookupHandler';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { fixtureFetch } from '../support/tmdb-fixtures';
import { mintApiKey } from '../../lib/auth/apiKey';
import type { PipelineDeps } from '../../lib/resolve/pipeline';
import type { ProviderCallRecord } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/**
 * Provider wiring backed by recorded fixtures rather than the live TMDB API.
 *
 * A fresh instance per call, the same shape `buildTmdbDeps()` builds per
 * request: this is what keeps these route-level tests offline while still
 * exercising `handleLookup` end to end. `fixtureFetch()` throws on a miss
 * rather than falling through to the network, so a missing recording fails
 * the test loudly instead of quietly reaching out.
 */
function testDeps(): PipelineDeps {
  let pending: ProviderCallRecord[] = [];
  const client = createTmdbClient({
    token: 'fixture',
    fetchImpl: fixtureFetch(),
    recordCall: (row) => { pending.push(row); },
    ratePerSecond: 1000,
  });
  return {
    provider: createTmdbProvider(client),
    now: () => new Date(),
    drainCalls: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

let cachedToken: string | null = null;
async function token(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-look', 'Look', 'look@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min)
      VALUES ('u-look', 'look', ${minted.tokenHash}, ${minted.prefix}, 10000)`);
  });
  cachedToken = minted.token;
  return minted.token;
}

async function post(body: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${await token()}`;
  return handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST', headers, body: JSON.stringify(body),
  }), testDeps());
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

async function clean(prefix: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
}

test('a lookup without a token is 401', opts, async () => {
  const response = await post({ category: 'movies', name: 'x.mkv' }, false);
  assert.equal(response.status, 401);
});

test('a body that is not an object is 400', opts, async () => {
  assert.equal((await post('nonsense')).status, 400);
});

test('an unknown category is 400 and says which are valid', opts, async () => {
  const response = await post({ category: 'music', name: 'x.mkv' });
  assert.equal(response.status, 400);
  const body = await json(response);
  assert.match(String(body.detail), /tv|movies|books|xxx/);
});

test('an empty name is 400', opts, async () => {
  assert.equal((await post({ category: 'movies', name: '' })).status, 400);
});

test('a batch over the cap is 400 rather than silently truncated', opts, async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({ category: 'movies', name: `x${i}.mkv` }));
  const response = await post({ items });
  assert.equal(response.status, 400);
  assert.match(String((await json(response)).detail), /100/);
});

test('a cold movie lookup resolves and returns the hydrated envelope', opts, async () => {
  await clean('rtesta');
  const response = await post({
    category: 'movies',
    name: 'rtesta/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb',
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.state, 'resolved');
  assert.equal(body.cached, false);
  assert.equal(body.partial, false);
  assert.ok(typeof body.lookupId === 'string');
  assert.ok(Number(body.confidence) >= 0.75);
  const parsed = body.parsed as { readonly kind: string; readonly title: string };
  assert.equal(parsed.kind, 'movie');
  assert.equal(parsed.title, 'Outbreak');
  const media = body.media as { readonly title: string; readonly people: readonly unknown[] };
  assert.equal(media.title, 'Outbreak');
  assert.ok(media.people.length > 0, 'the envelope embeds people');
  await clean('rtesta');
});

test('the second identical lookup is cached and still returns the media', opts, async () => {
  await clean('rtestb');
  const name = 'rtestb/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  await post({ category: 'movies', name });
  const body = await json(await post({ category: 'movies', name }));
  assert.equal(body.cached, true);
  assert.equal(body.state, 'resolved');
  const media = body.media as { readonly title: string };
  assert.equal(media.title, 'Outbreak', 'a cache hit must still hydrate the media');
  // `parsed` is null on a cache hit: nothing was parsed this time round.
  assert.equal(body.parsed, null);
  await clean('rtestb');
});

test('a refused name is 200 with a refusal, not an error status', opts, async () => {
  await clean('rtestc');
  const response = await post({ category: 'tv', name: 'rtestc/Moon Knight/.plexmatch' });
  // The request was well-formed and the answer is "this is not media". That is
  // an answer, not a client error.
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.state, 'unresolved');
  assert.match(String(body.refusal), /not a media file/);
  assert.equal(body.media, null);
  await clean('rtestc');
});

test('a batch returns one result per input, in order, each with a status', opts, async () => {
  await clean('rtestd');
  const response = await post({
    items: [
      { category: 'movies', name: 'rtestd/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb' },
      { category: 'tv', name: 'rtestd/Moon Knight/.plexmatch' },
    ],
  });
  assert.equal(response.status, 200, 'a batch is always 200; per-item status is inside');
  const body = await json(response);
  const results = body.results as readonly Record<string, unknown>[];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, 200);
  assert.equal(results[0]?.state, 'resolved');
  assert.equal(results[1]?.status, 200);
  assert.equal(results[1]?.state, 'unresolved');
  await clean('rtestd');
});

test('polling a lookup id returns the same envelope', opts, async () => {
  await clean('rteste');
  const created = await json(await post({
    category: 'movies',
    name: 'rteste/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb',
  }));
  const id = String(created.lookupId);
  const response = await handlePoll(
    new Request('https://x.test/api/v1/lookup/' + id, {
      headers: { authorization: `Bearer ${await token()}` },
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.lookupId, id);
  assert.equal(body.state, 'resolved');
  await clean('rteste');
});

test('polling an unknown lookup id is 404 and a malformed one is 400', opts, async () => {
  const headers = { authorization: `Bearer ${await token()}` };
  const unknown = await handlePoll(
    new Request('https://x.test/api/v1/lookup/x', { headers }),
    { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) },
  );
  assert.equal(unknown.status, 404);
  const malformed = await handlePoll(
    new Request('https://x.test/api/v1/lookup/x', { headers }),
    { params: Promise.resolve({ id: 'nope' }) },
  );
  assert.equal(malformed.status, 400);
});

test('a rate-limited caller gets 429 with Retry-After', opts, async () => {
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-tight', 'Tight', 'tight@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min)
      VALUES ('u-tight', 'tight', ${minted.tokenHash}, ${minted.prefix}, 1)`);
  });
  const send = (): Promise<Response> => handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ category: 'tv', name: 'rtestf/Moon Knight/.plexmatch' }),
  }), testDeps());
  await clean('rtestf');
  assert.equal((await send()).status, 200);
  const refused = await send();
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  await clean('rtestf');
});
