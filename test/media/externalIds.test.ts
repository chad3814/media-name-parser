import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { findMediaByExternalId, rememberExternalIds } from '../../lib/media/externalIds';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(
    withTransaction(async (tx) => { await fn(tx); throw new Error('__rollback__'); }),
    (error: unknown) => {
      if (error instanceof Error && error.message.includes('__rollback__')) return true;
      throw error;
    },
  );
}

async function seedMedia(tx: Tx, ref: string, title = 'Seeded'): Promise<string> {
  const row = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('movies', 'movie', ${title}, ${title}, 'tmdb', ${ref}, '{}'::jsonb, now())
    RETURNING id`);
  return String(row.rows[0]?.id);
}

test('a tmdb id is read from provider_ref, not duplicated', opts, async () => {
  await inRollback(async (tx) => {
    const id = await seedMedia(tx, 'tmdb:movie:424242');
    assert.equal(await findMediaByExternalId(tx, { source: 'tmdb', id: '424242' }), id);
  });
});

test('a tmdb id present in both namespaces declines rather than guessing', opts, async () => {
  // 5725 is really the film `Supervixens` and the series `Project Catwalk`.
  // With both stored, the id alone cannot say which, and a guess would be
  // reported at confidence 1 -- so it returns null and the provider path
  // corroborates instead.
  await inRollback(async (tx) => {
    await seedMedia(tx, 'tmdb:movie:424243', 'The Film');
    await tx.execute(sql`
      INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
      VALUES ('tv', 'series', 'The Series', 'The Series', 'tmdb', 'tmdb:tv:424243', '{}'::jsonb, now())`);
    assert.equal(await findMediaByExternalId(tx, { source: 'tmdb', id: '424243' }), null);
  });
});

test('an imdb id is found through the side table', opts, async () => {
  await inRollback(async (tx) => {
    const id = await seedMedia(tx, 'tmdb:movie:424244');
    await rememberExternalIds(tx, id, [{ source: 'imdb', id: 'tt9999001' }]);
    assert.equal(await findMediaByExternalId(tx, { source: 'imdb', id: 'tt9999001' }), id);
  });
});

test('a tpdb uuid is found on provider_ref, its numeric id in the side table', opts, async () => {
  // The uuid IS the provider_ref; the numeric `_id` and slug address the same
  // scene and live only in the side table, so both routes must work.
  await inRollback(async (tx) => {
    const row = await tx.execute(sql`
      INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
      VALUES ('xxx', 'scene', 'A Scene', 'A Scene', 'tpdb', 'uuid-9999002', '{}'::jsonb, now())
      RETURNING id`);
    const id = String(row.rows[0]?.id);
    await rememberExternalIds(tx, id, [{ source: 'tpdb', id: '9999003' }]);
    assert.equal(await findMediaByExternalId(tx, { source: 'tpdb', id: 'uuid-9999002' }), id, 'uuid');
    assert.equal(await findMediaByExternalId(tx, { source: 'tpdb', id: '9999003' }), id, 'numeric');
  });
});

test('an id that moved upstream repoints instead of failing', opts, async () => {
  // rememberExternalIds runs inside the resolution's transaction, so a raise
  // here would fail the whole lookup over a cache row.
  await inRollback(async (tx) => {
    const first = await seedMedia(tx, 'tmdb:movie:424245', 'First');
    const second = await seedMedia(tx, 'tmdb:movie:424246', 'Second');
    await rememberExternalIds(tx, first, [{ source: 'imdb', id: 'tt9999004' }]);
    await rememberExternalIds(tx, second, [{ source: 'imdb', id: 'tt9999004' }]);
    assert.equal(await findMediaByExternalId(tx, { source: 'imdb', id: 'tt9999004' }), second);
  });
});

test('an unknown id is a miss, not an error', opts, async () => {
  await withTransaction(async (tx) => {
    assert.equal(await findMediaByExternalId(tx, { source: 'imdb', id: 'tt0000000' }), null);
    // Caller-controlled text: it came out of a filename.
    assert.equal(await findMediaByExternalId(tx, { source: 'tmdb', id: "1') OR 1=1 --" }), null);
  });
});
