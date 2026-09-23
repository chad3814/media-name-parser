import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => {
  if (hasDb) await closeDb();
});

/** Two throwaway media rows under different providers, smallest id first. */
async function twoMedia(tx: Tx): Promise<readonly [string, string]> {
  const rows = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('tv','series','A','a','tmdb',${`t-${crypto.randomUUID()}`},'{}'::jsonb, now()),
           ('tv','series','A','a','tvdb',${`v-${crypto.randomUUID()}`},'{}'::jsonb, now())
    RETURNING id`);
  const ids = rows.rows.map((r) => String(r.id)).sort();
  return [ids[0] ?? '', ids[1] ?? ''];
}

/**
 * Every assertion runs inside a transaction that is then rolled back, as
 * the persist and read suites do. Committing fixtures would leave rows
 * behind for the backfill -- and every other query -- to trip over.
 */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

/**
 * Asserts a transaction is rejected by a named database constraint.
 *
 * Drizzle's own message is only "Failed query: ...", so the constraint that
 * fired is on the cause -- and naming it is the point: a test that accepted
 * any rejection would pass if the statement failed for some other reason.
 *
 * The whole transaction is the unit because a failed statement poisons it,
 * so nothing can follow the rejection inside the same one.
 */
async function rejectsWithConstraint(
  fn: (tx: Tx) => Promise<void>,
  constraint: RegExp,
): Promise<void> {
  await assert.rejects(withTransaction(fn), (error: Error & { cause?: unknown }) => {
    const cause = error.cause;
    assert.ok(cause instanceof Error, 'the driver error should be the cause');
    assert.match(cause.message, constraint);
    return true;
  });
}

test('a mirrored pair is refused, so one fact is one row', opts, async () => {
  // Without the CHECK, (x,y) and (y,x) are two rows saying the same thing
  // and every reader has to look both ways *and* dedupe.
  await rejectsWithConstraint(async (tx) => {
    const [a, b] = await twoMedia(tx);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)`);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${b}::uuid, ${a}::uuid)`);
  }, /violates check constraint "media_versions_ordered"/);
});

test('a media row takes its links with it', opts, async () => {
  await inRollback(async (tx) => {
    const [a, b] = await twoMedia(tx);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)`);
    await tx.execute(sql`DELETE FROM media WHERE id = ${a}::uuid`);
    const left = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media_versions WHERE a = ${a}::uuid OR b = ${a}::uuid`);
    assert.equal(left.rows[0]?.n, 0, 'a dangling pair would outlive the row it describes');
    assert.ok(b.length > 0);
  });
});

test('people_versions accepts a pair and refuses its mirror', opts, async () => {
  // That the table is *empty* is true today and stops being true the day
  // issue #3 fills it, so asserting that would fail for no behavioural
  // reason. What matters is that it exists and is shaped like its sibling.
  await rejectsWithConstraint(async (tx) => {
    const people = await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES ('tmdb', ${`a-${crypto.randomUUID()}`}, 'A', 'a', '{}'::jsonb, now()),
             ('tvdb', ${`b-${crypto.randomUUID()}`}, 'A', 'a', '{}'::jsonb, now())
      RETURNING id`);
    const ids = people.rows.map((r) => String(r.id)).sort();
    await tx.execute(sql`
      INSERT INTO people_versions (a, b) VALUES (${ids[0]}::uuid, ${ids[1]}::uuid)`);
    await tx.execute(sql`
      INSERT INTO people_versions (a, b) VALUES (${ids[1]}::uuid, ${ids[0]}::uuid)`);
  }, /violates check constraint "people_versions_ordered"/);
});

test('sites_versions exists, and nothing writes it yet', opts, async () => {
  await inRollback(async (tx) => {
    const rows = await tx.execute(sql`SELECT count(*)::int AS n FROM sites_versions`);
    assert.equal(rows.rows[0]?.n, 0, 'tpdb is the only provider that writes sites');
  });
});

test('sites kept its rows through the rename, each with a distinct id', opts, async () => {
  // `count(*) = count(id)` would have been true of any table state, empty
  // included -- so it would have passed had the migration dropped and
  // recreated the table, which is the outcome that had to be rejected.
  // These two assertions fail on an emptied table.
  await inRollback(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n, count(DISTINCT id)::int AS ids FROM sites`);
    assert.ok((rows.rows[0]?.n as number) > 0, 'the rename preserved the rows');
    assert.equal(rows.rows[0]?.ids, rows.rows[0]?.n, 'and gave each one its own id');
  });
});

test('a site is still unique on the keys the tpdb cache uses', opts, async () => {
  // Dropping the old composite primary key must not have taken with it the
  // uniqueness `rememberSite`'s ON CONFLICT (provider, provider_ref) needs.
  await rejectsWithConstraint(async (tx) => {
    await tx.execute(sql`
      INSERT INTO sites (provider, provider_ref, short_name, name)
      VALUES ('tpdb', 'probe-ref', 'probeshort', 'Probe')`);
    await tx.execute(sql`
      INSERT INTO sites (provider, provider_ref, short_name, name)
      VALUES ('tpdb', 'probe-ref', 'othershort', 'Other')`);
  }, /sites_provider_ref_key/);
});
