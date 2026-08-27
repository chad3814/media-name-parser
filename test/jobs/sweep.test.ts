import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { claimDue, enqueue, settle } from '../../lib/jobs/queue';
import { sweep } from '../../lib/jobs/sweep';
import { JOB_MAX_ATTEMPTS } from '../../lib/jobs/backoff';

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

test('sweep runs a due job and reports what it did', opts, async () => {
  await clean('jtesth');
  // A real, resolvable name so the sweep can finish it.
  await pendingLookup('jtesth/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const { fixtureFetch } = await import('../support/tmdb-fixtures');
  const report = await sweep({
    fetchImpl: fixtureFetch(),
    workerId: 'test-worker',
    now: () => new Date(),
  }, { limit: 25 });
  assert.ok(report.claimed >= 1, `expected to claim at least one, got ${report.claimed}`);
  assert.ok(report.done + report.retried + report.abandoned === report.claimed);
  await clean('jtesth');
});

test('sweep with nothing due is a no-op that does not throw', opts, async () => {
  const { fixtureFetch } = await import('../support/tmdb-fixtures');
  const report = await sweep({
    fetchImpl: fixtureFetch(), workerId: 'test-worker', now: () => new Date(),
  }, { limit: 0 });
  assert.equal(report.claimed, 0);
});
