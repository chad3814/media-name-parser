import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { claimDue, enqueue, settle } from '../../lib/jobs/queue';
import { sweep } from '../../lib/jobs/sweep';
import { JOB_LEASE_MS, JOB_MAX_ATTEMPTS } from '../../lib/jobs/backoff';
import { resolveLookup } from '../../lib/resolve/pipeline';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { fixtureFetch } from '../support/tmdb-fixtures';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/** A lookup row in `pending`, plus its job. Returns the lookup id. */
async function pendingLookup(name: string): Promise<string> {
  return withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO parses (category, normalized_key, tokens, parser_version)
      VALUES ('movies', ${name.toLowerCase()}, '{}'::jsonb, 1)
      ON CONFLICT (category, normalized_key) DO NOTHING`);
    const row = await tx.execute(sql`
      INSERT INTO lookups (category, name, normalized_key, state, last_attempt_at)
      VALUES ('movies', ${name}, ${name.toLowerCase()}, 'pending', now())
      ON CONFLICT (category, name) DO UPDATE SET state = 'pending'
      RETURNING id`);
    const id = String(row.rows[0]?.id);
    await enqueue(tx, id);
    return id;
  });
}

async function clean(prefix: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM lookup_jobs WHERE lookup_id IN (SELECT id FROM lookups WHERE name LIKE ${`${prefix}%`})`);
  await getDb().execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
  await getDb().execute(sql`DELETE FROM parses WHERE normalized_key LIKE ${`${prefix.toLowerCase()}%`}`);
}

test('enqueue is idempotent on lookup_id', opts, async () => {
  await clean('jtesta');
  const id = await pendingLookup('jtesta/x.mkv');
  await withTransaction(async (tx) => { await enqueue(tx, id); await enqueue(tx, id); });
  const count = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(count.rows[0]?.n, 1);
  await clean('jtesta');
});

test('claiming marks running, increments attempts, and returns the lookup', opts, async () => {
  await clean('jtestb');
  await pendingLookup('jtestb/x.mkv');
  const claimed = await withTransaction(async (tx) => claimDue(tx, 10, 'worker-1'));
  const mine = claimed.filter((j) => j.name.startsWith('jtestb'));
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.attempts, 1);
  assert.equal(mine[0]?.category, 'movies');
  await clean('jtestb');
});

test('a claimed job is not claimed again by a second sweep', opts, async () => {
  await clean('jtestc');
  await pendingLookup('jtestc/x.mkv');
  await withTransaction(async (tx) => claimDue(tx, 10, 'worker-1'));
  const second = await withTransaction(async (tx) => claimDue(tx, 10, 'worker-2'));
  assert.equal(second.filter((j) => j.name.startsWith('jtestc')).length, 0,
    'a running job is no longer pending');
  await clean('jtestc');
});

test('settling done deletes the row', opts, async () => {
  await clean('jtestd');
  const id = await pendingLookup('jtestd/x.mkv');
  const claimed = await withTransaction(async (tx) => claimDue(tx, 50, 'w'));
  const job = claimed.find((j) => j.lookupId === id);
  assert.ok(job !== undefined);
  await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'done' }));
  const left = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(left.rows[0]?.n, 0);
  await clean('jtestd');
});

test('settling retry reschedules into the future and records the error', opts, async () => {
  await clean('jteste');
  const id = await pendingLookup('jteste/x.mkv');
  const claimed = await withTransaction(async (tx) => claimDue(tx, 50, 'w'));
  const job = claimed.find((j) => j.lookupId === id);
  assert.ok(job !== undefined);
  await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'retry', error: 'tmdb 500' }));
  const row = await getDb().execute(sql`
    SELECT state, last_error, next_attempt_at > now() AS future
      FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(row.rows[0]?.state, 'pending');
  assert.equal(row.rows[0]?.last_error, 'tmdb 500');
  assert.equal(row.rows[0]?.future, true, 'a retry must not be immediately due again');
  await clean('jteste');
});

test('a job out of attempts is abandoned rather than retried forever', opts, async () => {
  await clean('jtestf');
  const id = await pendingLookup('jtestf/x.mkv');
  await getDb().execute(sql`
    UPDATE lookup_jobs SET attempts = ${JOB_MAX_ATTEMPTS} WHERE lookup_id = ${id}::uuid`);
  const jobRow = await getDb().execute(sql`
    SELECT id FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  const jobId = String(jobRow.rows[0]?.id);
  await withTransaction(async (tx) => settle(tx, jobId, { kind: 'retry', error: 'still failing' }));
  const row = await getDb().execute(sql`SELECT state, last_error FROM lookup_jobs WHERE id = ${jobId}::uuid`);
  assert.equal(row.rows[0]?.state, 'abandoned');
  assert.match(String(row.rows[0]?.last_error), /gave up after/);
  await clean('jtestf');
});

test('settling abandon is terminal and keeps the row for a human to see', opts, async () => {
  await clean('jtestg');
  const id = await pendingLookup('jtestg/x.mkv');
  const jobRow = await getDb().execute(sql`SELECT id FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  const jobId = String(jobRow.rows[0]?.id);
  await withTransaction(async (tx) => settle(tx, jobId, { kind: 'abandon', error: 'bad credential' }));
  const row = await getDb().execute(sql`SELECT state, last_error FROM lookup_jobs WHERE id = ${jobId}::uuid`);
  assert.equal(row.rows[0]?.state, 'abandoned');
  assert.equal(row.rows[0]?.last_error, 'bad credential');
  await clean('jtestg');
});

test('reviving an abandoned job resets its attempt budget', opts, async () => {
  // Without the reset the revived job spends one attempt, trips the
  // max-attempts guard immediately and is abandoned again -- so the sweeper
  // safety net stays permanently dead for that lookup while the request path
  // keeps retrying it every twelve hours.
  await clean('jtestrevive');
  const id = await pendingLookup('jtestrevive/x.mkv');
  await getDb().execute(sql`
    UPDATE lookup_jobs SET state = 'abandoned', attempts = ${JOB_MAX_ATTEMPTS},
           last_error = 'gave up earlier'
     WHERE lookup_id = ${id}::uuid`);

  await withTransaction(async (tx) => { await enqueue(tx, id); });

  const row = await getDb().execute(sql`
    SELECT state, attempts, last_error FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(row.rows[0]?.state, 'pending');
  assert.equal(row.rows[0]?.attempts, 0, 'the attempt budget must be restored');
  assert.equal(row.rows[0]?.last_error, null, 'and the stale error cleared');
  await clean('jtestrevive');
});

test('re-enqueueing a job that is still pending keeps its attempt count', opts, async () => {
  // The reset is scoped to revival. An ordinary re-enqueue must not hand a
  // repeatedly-failing job a fresh budget, or backoff never converges.
  await clean('jtestkeep');
  const id = await pendingLookup('jtestkeep/x.mkv');
  await getDb().execute(sql`
    UPDATE lookup_jobs SET attempts = 3 WHERE lookup_id = ${id}::uuid`);

  await withTransaction(async (tx) => { await enqueue(tx, id); });

  const row = await getDb().execute(sql`
    SELECT attempts FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(row.rows[0]?.attempts, 3);
  await clean('jtestkeep');
});

test('sweep runs a due job and reports what it did', opts, async () => {
  await clean('jtesth');
  // A real, resolvable name so the sweep can finish it -- and this test
  // checks that it actually did, not just that some three-way count of
  // done/retried/abandoned adds up to claimed. That weaker check is true by
  // construction for any correct branch and cannot distinguish "the job
  // resolved" from "the job was retried without ever reaching the
  // provider", which is exactly the shape of the bug this test exists to
  // catch (a `force`-less retry gets `cooling` from the freshness check and
  // is booked as a retry having never called out).
  const id = await pendingLookup('jtesth/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const report = await sweep({
    fetchImpl: fixtureFetch(),
    workerId: 'test-worker',
    now: () => new Date(),
  }, { limit: 25 });
  assert.ok(report.claimed >= 1, `expected to claim at least one, got ${report.claimed}`);
  assert.ok(report.done + report.retried + report.abandoned === report.claimed);
  assert.ok(report.done >= 1, `the resolvable fixture job must actually resolve, got done=${report.done}`);
  const row = await getDb().execute(sql`SELECT state FROM lookups WHERE id = ${id}::uuid`);
  assert.equal(row.rows[0]?.state, 'resolved',
    'the sweep must actually reach the provider and resolve the lookup, not just retry it');
  await clean('jtesth');
});

test('resolveLookup with force reaches the provider despite a fresh last_attempt_at, unlike a plain retry', opts, async () => {
  await clean('jtesti');
  const name = 'jtesti/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  // `pendingLookup` writes `state = 'pending'` with `last_attempt_at = now()`
  // -- exactly the row a blown-deadline write or a previous sweep retry
  // leaves behind, and exactly the row `decide()` calls `cooling` for.
  const id = await pendingLookup(name);
  const client = createTmdbClient({ token: 'fixture', fetchImpl: fixtureFetch(), ratePerSecond: 1000 });
  const deps = { providers: [createTmdbProvider(client)], now: () => new Date() };

  // Without force: inside the cooling window, so the stale row is served
  // and the provider is never called.
  const cooling = await resolveLookup({ category: 'movies', name }, deps);
  assert.equal(cooling.cached, true, 'a fresh last_attempt_at must be served from cache, not retried');
  assert.equal(cooling.state, 'pending');

  // With force: the freshness check is skipped and the provider is actually
  // reached, resolving the same row this time.
  const forced = await resolveLookup({ category: 'movies', name }, deps, { force: true });
  assert.equal(forced.cached, false, 'force must bypass the cache and call the provider');
  assert.equal(forced.state, 'resolved');
  assert.equal(forced.lookupId, id);

  await clean('jtesti');
});

test('a job stranded in running past its lease is reclaimed', opts, async () => {
  await clean('jtestj');
  const id = await pendingLookup('jtestj/x.mkv');
  // Exactly the row a platform timeout between claim and settle leaves behind:
  // `running`, with a lease nobody is holding. Nothing clears `state` except
  // `settle`, so before `claimDue` read `locked_at` this row was invisible to
  // every future sweep -- permanently, not just for a while.
  await getDb().execute(sql`
    UPDATE lookup_jobs
       SET state = 'running', locked_by = 'dead-worker',
           locked_at = now() - (${JOB_LEASE_MS * 2} * interval '1 millisecond')
     WHERE lookup_id = ${id}::uuid`);
  const claimed = await withTransaction(async (tx) => claimDue(tx, 50, 'worker-2'));
  assert.equal(claimed.filter((j) => j.lookupId === id).length, 1,
    'a running job whose lease has expired must be claimable again');
  await clean('jtestj');
});

test('a sweep does not re-resolve a lookup that is already resolved', opts, async () => {
  await clean('jtestk');
  // A resolved lookup above the floor that still has a job row: exactly what a
  // continuation which finished the lookup but never settled its job leaves
  // behind. Re-resolving it spends a provider call to overwrite a good answer
  // with the same value -- or, if that retry blows its own deadline, with nulls.
  const name = 'jtestk/x.mkv';
  const id = await withTransaction(async (tx) => {
    const mediaRow = await tx.execute(sql`
      INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
      VALUES ('movies', 'movie', 'Jtestk', 'jtestk', 'tmdb', 'tmdb:movie:jtestk', '{}'::jsonb, now())
      ON CONFLICT (provider, provider_ref) DO UPDATE SET title = excluded.title
      RETURNING id`);
    const mediaId = String(mediaRow.rows[0]?.id);
    await tx.execute(sql`
      INSERT INTO parses (category, normalized_key, tokens, parser_version)
      VALUES ('movies', ${name.toLowerCase()}, '{}'::jsonb, 1)
      ON CONFLICT (category, normalized_key) DO NOTHING`);
    const row = await tx.execute(sql`
      INSERT INTO lookups (category, name, normalized_key, media_id, confidence, state,
                           last_attempt_at, resolved_at)
      VALUES ('movies', ${name}, ${name.toLowerCase()}, ${mediaId}::uuid, 0.95, 'resolved',
              now(), now())
      RETURNING id`);
    const lookupId = String(row.rows[0]?.id);
    await enqueue(tx, lookupId);
    return lookupId;
  });
  const before = await getDb().execute(sql`
    SELECT last_attempt_at, hit_count FROM lookups WHERE id = ${id}::uuid`);

  // A fetch that refuses to be called: any provider call for this job fails
  // the assertions below rather than quietly succeeding from a fixture.
  const forbidden = ((): Promise<Response> => {
    throw new Error('the sweep must not call the provider for a resolved lookup');
  }) as unknown as typeof fetch;
  const report = await sweep({
    fetchImpl: forbidden, workerId: 'test-worker', now: () => new Date(),
  }, { limit: 25 });

  assert.ok(report.done >= 1, `the resolved job must be settled done, got done=${report.done}`);
  const left = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(left.rows[0]?.n, 0, 'settling done deletes the job row');
  const after = await getDb().execute(sql`
    SELECT state, last_attempt_at, hit_count FROM lookups WHERE id = ${id}::uuid`);
  assert.equal(after.rows[0]?.state, 'resolved');
  assert.equal(String(after.rows[0]?.last_attempt_at), String(before.rows[0]?.last_attempt_at),
    'nothing was re-attempted, so last_attempt_at cannot have moved');
  // The sweeper stopped before the pipeline, not inside it. Reaching the
  // pipeline at all would serve the row from cache and count a cache hit, and
  // a sweeper visit is not a hit -- nobody asked for this lookup.
  assert.equal(Number(after.rows[0]?.hit_count), Number(before.rows[0]?.hit_count),
    'a job settled without work must not be recorded as a cache hit');
  const calls = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM provider_calls WHERE lookup_id = ${id}::uuid`);
  assert.equal(calls.rows[0]?.n, 0, 'zero provider calls for an already-resolved lookup');

  await clean('jtestk');
  await getDb().execute(sql`DELETE FROM media WHERE provider_ref = 'tmdb:movie:jtestk'`);
});

test('a provider auth failure abandons the job on the first attempt', opts, async () => {
  await clean('jtestl');
  const id = await pendingLookup('jtestl/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  // 401 is the one provider outcome the spec calls terminal: "the job goes to
  // abandoned with last_error set, so the sweeper does not grind against a bad
  // key". The pipeline catches the TmdbAuthFailed and reports `pending`, so the
  // only way the sweeper can know is the `terminal` flag on the result.
  const rejecting = ((): Promise<Response> => Promise.resolve(new Response(
    JSON.stringify({ status_message: 'Invalid API key' }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  ))) as unknown as typeof fetch;
  await sweep({ fetchImpl: rejecting, workerId: 'test-worker', now: () => new Date() }, { limit: 25 });
  const row = await getDb().execute(sql`
    SELECT state, attempts, last_error FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(row.rows[0]?.state, 'abandoned', 'a rejected credential is not retryable');
  assert.equal(row.rows[0]?.attempts, 1, 'abandoned on the first attempt, not after six');
  assert.match(String(row.rows[0]?.last_error), /credential/i);
  await clean('jtestl');
});

test('one job whose resolution throws does not strand the jobs claimed alongside it', opts, async () => {
  await clean('jtestm');
  const first = await pendingLookup('jtestm/a.1999.1080p.BluRay-GRP.nzb');
  const second = await pendingLookup('jtestm/b.1999.1080p.BluRay-GRP.nzb');
  // With no TMDB credential in the environment, `tmdbTokenFromEnv()` throws
  // for every job. It used to be called in the sweep loop but outside the try,
  // so the first throw aborted the whole sweep and left every row claimed in
  // that invocation stranded in `running`. Both env vars are removed and
  // restored here; neither value is ever read or printed.
  const saved = {
    readAccess: process.env.TMDB_READ_ACCESS_TOKEN,
    apiKey: process.env.TMDB_API_KEY,
  };
  delete process.env.TMDB_READ_ACCESS_TOKEN;
  delete process.env.TMDB_API_KEY;
  try {
    await sweep({ workerId: 'test-worker', now: () => new Date() }, { limit: 25 });
  } finally {
    if (saved.readAccess !== undefined) process.env.TMDB_READ_ACCESS_TOKEN = saved.readAccess;
    if (saved.apiKey !== undefined) process.env.TMDB_API_KEY = saved.apiKey;
  }
  const rows = await getDb().execute(sql`
    SELECT lookup_id, state, attempts, last_error FROM lookup_jobs
     WHERE lookup_id IN (${first}::uuid, ${second}::uuid)`);
  assert.equal(rows.rows.length, 2);
  for (const row of rows.rows) {
    assert.equal(row.state, 'pending',
      'every claimed job must be settled, not left holding a lease nobody owns');
    assert.equal(Number(row.attempts), 1);
    assert.match(String(row.last_error), /TMDB_READ_ACCESS_TOKEN/);
  }
  await clean('jtestm');
});

test('the sweep prunes provider_calls past the retention window', opts, async () => {
  const clear = async (): Promise<void> => {
    await getDb().execute(sql`DELETE FROM provider_calls WHERE endpoint LIKE '/jtestn/%'`);
  };
  await clear();
  await getDb().execute(sql`
    INSERT INTO provider_calls (provider, endpoint, status, duration_ms, created_at)
    VALUES ('tmdb', '/jtestn/old', 200, 1, now() - interval '31 days'),
           ('tmdb', '/jtestn/new', 200, 1, now())`);
  // `limit: 0` claims nothing: the prune is the whole subject of this test, and
  // the spec puts the 30-day `provider_calls` retention on the same cron.
  const report = await sweep({
    fetchImpl: fixtureFetch(), workerId: 'test-worker', now: () => new Date(),
  }, { limit: 0 });
  assert.ok(report.prunedProviderCalls >= 1, 'the old row is pruned and counted');
  const left = await getDb().execute(sql`
    SELECT endpoint FROM provider_calls WHERE endpoint LIKE '/jtestn/%'`);
  assert.deepEqual(left.rows.map((r) => String(r.endpoint)), ['/jtestn/new'],
    'a row inside the window survives');
  await clear();
});

test('sweep with nothing due is a no-op that does not throw', opts, async () => {
  const report = await sweep({
    fetchImpl: fixtureFetch(), workerId: 'test-worker', now: () => new Date(),
  }, { limit: 0 });
  assert.equal(report.claimed, 0);
});
