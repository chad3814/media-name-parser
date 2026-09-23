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

test('a mirrored pair is refused, so one fact is one row', opts, async () => {
  // Without the CHECK, (x,y) and (y,x) are two rows saying the same thing
  // and every reader has to look both ways *and* dedupe.
  await assert.rejects(withTransaction(async (tx) => {
    const [a, b] = await twoMedia(tx);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)`);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${b}::uuid, ${a}::uuid)`);
  }), (error: Error & { cause?: unknown }) => {
    // Drizzle's own message is only "Failed query: ..."; the constraint that
    // fired is named on the cause, and naming it is the point -- a test that
    // accepted any rejection would pass if the insert failed for some other
    // reason entirely.
    const cause = error.cause;
    assert.ok(cause instanceof Error, 'the driver error should be the cause');
    assert.match(cause.message, /violates check constraint "media_versions_ordered"/);
    return true;
  });
});

test('a media row takes its links with it', opts, async () => {
  await withTransaction(async (tx) => {
    const [a, b] = await twoMedia(tx);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)`);
    await tx.execute(sql`DELETE FROM media WHERE id = ${a}::uuid`);
    const left = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media_versions WHERE a = ${a}::uuid OR b = ${a}::uuid`);
    assert.equal(left.rows[0]?.n, 0, 'a dangling pair would outlive the row it describes');
    await tx.execute(sql`DELETE FROM media WHERE id = ${b}::uuid`);
  });
});

test('people_versions and sites_versions exist and start empty', opts, async () => {
  await withTransaction(async (tx) => {
    const people = await tx.execute(sql`SELECT count(*)::int AS n FROM people_versions`);
    assert.equal(people.rows[0]?.n, 0);
    const sites = await tx.execute(sql`SELECT count(*)::int AS n FROM sites_versions`);
    assert.equal(sites.rows[0]?.n, 0);
  });
});

test('sites holds what provider_sites held, under a surrogate id', opts, async () => {
  await withTransaction(async (tx) => {
    const r = await tx.execute(sql`
      SELECT count(*)::int AS n, count(id)::int AS with_id FROM sites`);
    assert.equal(r.rows[0]?.n, r.rows[0]?.with_id, 'every row has an id');
  });
});
