import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { handleLookup, handlePoll } from '../../lib/http/lookupHandler';
import { buildDeps } from '../../lib/http/envelope';
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
    providers: [createTmdbProvider(client)],
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

/**
 * The same wiring, with every provider request counted.
 *
 * The count is the assertion in the cooling-window test below: "no external
 * work" is not observable from the envelope -- a cooling hit and a fresh
 * attempt both answer 202 -- so the only honest check is that the fetch the
 * provider would have made never happened.
 */
function countingDeps(counter: { calls: number }): PipelineDeps {
  const inner = fixtureFetch();
  let pending: ProviderCallRecord[] = [];
  const counted = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    counter.calls += 1;
    return inner(input as Parameters<typeof fetch>[0], init);
  }) as unknown as typeof fetch;
  const client = createTmdbClient({
    token: 'fixture',
    fetchImpl: counted,
    recordCall: (row) => { pending.push(row); },
    ratePerSecond: 1000,
  });
  return {
    providers: [createTmdbProvider(client)],
    now: () => new Date(),
    drainCalls: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

/** Provider wiring whose every request fails, standing in for a blown deadline. */
function failingDeps(): PipelineDeps {
  const refuses = ((): Promise<Response> =>
    Promise.reject(new Error('the deadline tripped'))) as unknown as typeof fetch;
  const client = createTmdbClient({ token: 'fixture', fetchImpl: refuses, ratePerSecond: 1000 });
  return { providers: [createTmdbProvider(client)], now: () => new Date() };
}

async function post(body: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${await token()}`;
  return handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST', headers, body: JSON.stringify(body),
  }), () => testDeps());
}

/**
 * A POST whose post-response continuation is captured instead of handed to
 * `waitUntil`.
 *
 * Outside a Vercel invocation `waitUntil` has nothing to register with and
 * drops the promise, which leaves a detached continuation writing to the
 * database after the test that started it has finished. Capturing it is what
 * makes "the continuation settled its job" assertable at all.
 */
async function postDeferred(
  body: unknown, makeDeps: () => PipelineDeps, deferred: Promise<void>[],
): Promise<Response> {
  return handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
  }), makeDeps, { defer: (promise) => { deferred.push(promise); } });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

async function clean(prefix: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM lookup_jobs WHERE lookup_id IN (
      SELECT id FROM lookups WHERE name LIKE ${`${prefix}%`})`);
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

test('a name that is only whitespace is 400, not an empty stored name', opts, async () => {
  // The schema trims before it checks the length. Reversed, `min(1)` would see
  // the untrimmed string, accept it, and store a name of nothing.
  assert.equal((await post({ category: 'movies', name: '   ' })).status, 400);
});

test('a padded name is stored without its padding', opts, async () => {
  await clean('rtestw');
  const bare = 'rtestw/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  const response = await post({ category: 'movies', name: `${bare} ` });
  assert.equal(response.status, 200, 'a trailing space is not a bad request');
  // The parse already tolerates the padding; this is about what got written.
  // An untrimmed name here means two rows for one release, since the two
  // spellings share a normalized key but conflict on (category, name).
  const rows = await getDb().execute(sql`
    SELECT name FROM lookups WHERE name LIKE 'rtestw%'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(String(rows.rows[0]?.name), bare);
  await clean('rtestw');
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
  // `parsed` is present on a cache hit too. The spec says the poll endpoint
  // returns "the same envelope", and a consumer aggregating a parse rate over
  // responses would otherwise score every cached row as unparsed.
  const parsed = body.parsed as { readonly kind: string; readonly title: string } | null;
  assert.notEqual(parsed, null, 'a cache hit must still carry the stored parse');
  assert.equal(parsed?.kind, 'movie');
  assert.equal(parsed?.title, 'Outbreak', 'and it must be the same parse the cold lookup returned');
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

test('a batch item that blows its deadline leaves a durable job and reports 202', opts, async () => {
  // The spec's Batch form says misses are enqueued. Without it an item that
  // blew its deadline came back pending with no job row, so it was only ever
  // retried if somebody asked again twelve hours later -- on the endpoint the
  // corpus runner uses, where dropped work is least likely to be noticed.
  await clean('rtestbatchq');
  const good = 'rtestbatchq/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  const missing = 'rtestbatchq/Some.Film.Nobody.Recorded.2019.1080p.BluRay-GRP.nzb';

  const body = await json(await post({
    items: [
      { category: 'movies', name: good },
      { category: 'movies', name: missing },
    ],
  }));
  const results = body.results as readonly Record<string, unknown>[];
  assert.equal(results.length, 2);

  assert.equal(results[0]?.state, 'resolved');
  assert.equal(results[0]?.status, 200, 'a resolved item is 200');

  assert.equal(results[1]?.state, 'pending');
  assert.equal(results[1]?.status, 202, 'an item still resolving is 202, not a constant 200');

  const jobs = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs
     WHERE lookup_id = ${String(results[1]?.lookupId)}::uuid`);
  assert.equal(jobs.rows[0]?.n, 1, 'the partial batch item must leave a durable job');

  const noJobForResolved = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs
     WHERE lookup_id = ${String(results[0]?.lookupId)}::uuid`);
  assert.equal(noJobForResolved.rows[0]?.n, 0, 'a resolved item must not be queued');

  await getDb().execute(sql`
    DELETE FROM lookup_jobs WHERE lookup_id = ${String(results[1]?.lookupId)}::uuid`);
  await clean('rtestbatchq');
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
  }), () => testDeps());
  await clean('rtestf');
  assert.equal((await send()).status, 200);
  const refused = await send();
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  await clean('rtestf');
});

test('a deps factory that throws is a 503 problem response, not a crash', opts, async () => {
  // A synthetic throw, standing in for any failure the factory can raise. The
  // production case -- a missing TMDB credential reaching
  // `buildDeps('movies')` -> `tmdbTokenFromEnv()` -- is covered on the real
  // path by the test below; this one pins the handler's own behaviour, that a
  // throw after auth and validation have succeeded becomes the same 503
  // problem+json shape as any other failure inside the pipeline rather than
  // an uncaught exception.
  const response = await handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
    body: JSON.stringify({ category: 'movies', name: 'x.mkv' }),
  }), () => { throw new Error('no token configured'); });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
});

const tmdbConfigured = ((process.env.TMDB_READ_ACCESS_TOKEN ?? process.env.TMDB_API_KEY) ?? '').length > 0;

test('a missing credential for the requested category is a 503 on the real path', opts, async () => {
  // The real `buildDeps`, not a synthetic factory. It used to catch the throw
  // from `tmdbTokenFromEnv()` and simply omit the provider, so a `movies`
  // lookup on a deployment with no TMDB key took the pipeline's "no provider
  // supports movies" branch: `unresolved` written with a fresh
  // `last_attempt_at`, and every request for the next twelve hours answered
  // 202 with `partial: true`, no refusal and nothing logged. A server that
  // cannot serve the category has to say so.
  const saved = {
    read: process.env.TMDB_READ_ACCESS_TOKEN,
    key: process.env.TMDB_API_KEY,
  };
  delete process.env.TMDB_READ_ACCESS_TOKEN;
  delete process.env.TMDB_API_KEY;
  try {
    const response = await handleLookup(new Request('https://x.test/api/v1/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        category: 'movies',
        name: 'rtestcred/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb',
      }),
    }), buildDeps);
    assert.equal(response.status, 503, 'a movies lookup with no TMDB credential must refuse');
    assert.equal(response.headers.get('content-type'), 'application/problem+json');
  } finally {
    if (saved.read !== undefined) process.env.TMDB_READ_ACCESS_TOKEN = saved.read;
    if (saved.key !== undefined) process.env.TMDB_API_KEY = saved.key;
  }
  // Nothing was attempted, so nothing should have been recorded either.
  const rows = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookups WHERE name LIKE 'rtestcred%'`);
  assert.equal(rows.rows[0]?.n, 0, 'a refused lookup must not leave a cooling row behind');
});

test('a credential missing for one category does not strand the other', opts, async () => {
  // The reason the wiring is per category and built on demand. Neither call
  // touches the network: `buildDeps` only constructs a client.
  if (!tmdbConfigured) return;
  const saved = process.env.TPDB_API_KEY;
  delete process.env.TPDB_API_KEY;
  try {
    assert.throws(() => buildDeps('xxx'), /TPDB_API_KEY/,
      'the category whose credential is missing throws');
    const movies = buildDeps('movies');
    assert.equal(movies.providers.length, 1, 'the other category is still served');
    assert.equal(movies.providers[0]?.name, 'tmdb');
  } finally {
    if (saved !== undefined) process.env.TPDB_API_KEY = saved;
  }
});

test('an unauthenticated request is 401 and never calls the deps factory', opts, async () => {
  let invoked = false;
  const response = await handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'movies', name: 'x.mkv' }),
  }), () => { invoked = true; throw new Error('must not run'); });
  assert.equal(response.status, 401);
  assert.equal(invoked, false, 'authentication must be checked before the deps factory runs');
});

test('a partial lookup enqueues a durable job', opts, async () => {
  await clean('rtestg');
  // A name with no recorded fixture blows the provider call, which the
  // pipeline reports as pending -- the same shape a real timeout produces.
  const deferred: Promise<void>[] = [];
  const response = await postDeferred({
    category: 'movies',
    name: 'rtestg/Some.Film.Nobody.Recorded.2019.1080p.BluRay-GRP.nzb',
  }, () => testDeps(), deferred);
  const body = await json(response);
  assert.equal(body.state, 'pending');
  assert.equal(body.partial, true);
  assert.equal(response.status, 202);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  const jobs = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs
     WHERE lookup_id = ${String(body.lookupId)}::uuid`);
  assert.equal(jobs.rows[0]?.n, 1, 'a partial result must leave a durable job behind');
  // The continuation is awaited rather than abandoned: it fails too (still no
  // fixture), so the durable row survives, which is the point of writing it
  // before the continuation starts.
  await Promise.all(deferred);
  const after = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs
     WHERE lookup_id = ${String(body.lookupId)}::uuid`);
  assert.equal(after.rows[0]?.n, 1, 'a continuation that did not finish leaves the job alone');
  await clean('rtestg');
});

test('a repeat request inside the cooling window does no external work', opts, async () => {
  await clean('rtesth');
  const name = 'rtesth/Some.Film.Nobody.Recorded.2019.1080p.BluRay-GRP.nzb';
  const counter = { calls: 0 };
  const deferred: Promise<void>[] = [];

  const first = await postDeferred({ category: 'movies', name }, () => countingDeps(counter), deferred);
  assert.equal(first.status, 202);
  const firstBody = await json(first);
  assert.equal(firstBody.cached, false, 'the first request really did attempt it');
  await Promise.all(deferred);
  assert.ok(counter.calls > 0, 'and really did reach the provider');

  const lookupId = String(firstBody.lookupId);
  const before = await getDb().execute(sql`
    SELECT id, next_attempt_at FROM lookup_jobs WHERE lookup_id = ${lookupId}::uuid`);
  assert.equal(before.rows.length, 1);
  const attempted = counter.calls;
  deferred.length = 0;

  // Second request, one moment later: inside the 12-hour cooling window. The
  // spec's step 4 says this returns current data with `partial: true` and does
  // "no external work"; success criterion 2 says zero provider calls. Acting
  // on `partial` without checking `cached` did the opposite -- it re-enqueued,
  // resetting next_attempt_at to now and defeating the backoff for a client
  // retrying in a loop, and fired a second continuation that called out again.
  const second = await postDeferred({ category: 'movies', name }, () => countingDeps(counter), deferred);
  assert.equal(second.status, 202);
  const secondBody = await json(second);
  assert.equal(secondBody.cached, true);
  assert.equal(secondBody.partial, true);
  assert.equal(secondBody.lookupId, lookupId);
  assert.equal(counter.calls, attempted, 'a cooling-window repeat makes zero provider calls');
  assert.equal(deferred.length, 0, 'and starts no continuation');

  const after = await getDb().execute(sql`
    SELECT id, next_attempt_at FROM lookup_jobs WHERE lookup_id = ${lookupId}::uuid`);
  assert.equal(after.rows.length, 1, 'no second job row');
  assert.equal(String(after.rows[0]?.id), String(before.rows[0]?.id));
  assert.equal(String(after.rows[0]?.next_attempt_at), String(before.rows[0]?.next_attempt_at),
    'and the schedule the backoff depends on is not reset');

  await clean('rtesth');
});

test('a continuation that finishes the lookup deletes its own job row', opts, async () => {
  await clean('rtesti');
  const name = 'rtesti/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  // The in-request attempt fails and the continuation succeeds: exactly the
  // happy path of a blown deadline, which `waitUntil` usually finishes inside
  // the same invocation. `makeDeps` is called once for the request and once
  // for the continuation, so the attempt counter is the seam.
  let attempt = 0;
  const makeDeps = (): PipelineDeps => {
    attempt += 1;
    return attempt === 1 ? failingDeps() : testDeps();
  };
  const deferred: Promise<void>[] = [];
  const response = await postDeferred({ category: 'movies', name }, makeDeps, deferred);
  assert.equal(response.status, 202);
  const body = await json(response);
  assert.equal(body.partial, true);
  const lookupId = String(body.lookupId);
  assert.equal(deferred.length, 1, 'the attempt that failed owns the continuation');

  const queued = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${lookupId}::uuid`);
  assert.equal(queued.rows[0]?.n, 1, 'the durable row is written before the continuation runs');

  await Promise.all(deferred);

  const left = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${lookupId}::uuid`);
  assert.equal(left.rows[0]?.n, 0,
    'a continuation that resolved the lookup must delete its job, or the next cron '
    + 'minute re-runs the whole resolution and can overwrite the answer with nulls');
  const row = await getDb().execute(sql`SELECT state FROM lookups WHERE id = ${lookupId}::uuid`);
  assert.equal(row.rows[0]?.state, 'resolved');

  await clean('rtesti');
});
