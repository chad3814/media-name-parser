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
    assert.equal(await findMediaByExternalId(tx, { source: 'tmdb', id: '424242' }, 'movies', 'Seeded'), id);
  });
});

async function seedBoth(tx: Tx, id: string): Promise<{ film: string; series: string }> {
  const film = await seedMedia(tx, `tmdb:movie:${id}`, 'Shared Number');
  const row = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('tv', 'series', 'Quite Different', 'Quite Different', 'tmdb', ${`tmdb:tv:${id}`},
            '{}'::jsonb, now())
    RETURNING id`);
  return { film, series: String(row.rows[0]?.id) };
}

test('the declared category picks the namespace when both are stored', opts, async () => {
  // TMDB numbers films and series separately and both spaces are populated:
  // 5725 really is the film `Supervixens` and the series `Project Catwalk`. But
  // a `movies` lookup has already said which of those it means, so there is
  // nothing to decline -- declining here threw away a free answer.
  await inRollback(async (tx) => {
    const { film, series } = await seedBoth(tx, '424243');
    const id = { source: 'tmdb' as const, id: '424243' };
    assert.equal(await findMediaByExternalId(tx, id, 'movies', 'Shared Number'), film);
    assert.equal(await findMediaByExternalId(tx, id, 'tv', 'Quite Different'), series);
  });
});

test('a known namespace does not fall back to the other one', opts, async () => {
  // Only the series is stored, and the caller asked for a movie. The id names
  // a record in a namespace the caller did not ask about, so this is a miss
  // rather than a cross-namespace guess.
  await inRollback(async (tx) => {
    await tx.execute(sql`
      INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
      VALUES ('tv', 'series', 'Only A Series', 'Only A Series', 'tmdb', 'tmdb:tv:424247',
              '{}'::jsonb, now())`);
    assert.equal(
      await findMediaByExternalId(tx, { source: 'tmdb', id: '424247' }, 'movies', 'Only A Series'),
      null,
    );
  });
});

test('with no namespace, the stored title settles it -- and costs nothing', opts, async () => {
  // An `xxx` lookup naming a TMDB id: the category fixes no namespace, so the
  // id alone cannot say film or series. The stored title answers it without a
  // provider call, which is the same corroboration the provider path does one
  // network round trip later.
  await inRollback(async (tx) => {
    const { film } = await seedBoth(tx, '424248');
    assert.equal(
      await findMediaByExternalId(tx, { source: 'tmdb', id: '424248' }, 'xxx', 'Shared Number'),
      film, 'the title agrees with the film, so the film it is',
    );
    assert.equal(
      await findMediaByExternalId(tx, { source: 'tmdb', id: '424248' }, 'xxx', 'Neither Of These'),
      null, 'no stored title agrees, so nothing is claimed',
    );
  });
});

test('an imdb id is found through the side table', opts, async () => {
  await inRollback(async (tx) => {
    const id = await seedMedia(tx, 'tmdb:movie:424244');
    await rememberExternalIds(tx, id, [{ source: 'imdb', id: 'tt9999001' }]);
    assert.equal(await findMediaByExternalId(tx, { source: 'imdb', id: 'tt9999001' }, 'movies', 'Seeded'), id);
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
    assert.equal(await findMediaByExternalId(tx, { source: 'tpdb', id: 'uuid-9999002' }, 'xxx', 'A Scene'), id, 'uuid');
    assert.equal(await findMediaByExternalId(tx, { source: 'tpdb', id: '9999003' }, 'xxx', 'A Scene'), id, 'numeric');
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
    assert.equal(await findMediaByExternalId(tx, { source: 'imdb', id: 'tt9999004' }, 'movies', 'Second'), second);
  });
});

test('an unknown id is a miss, not an error', opts, async () => {
  await withTransaction(async (tx) => {
    assert.equal(await findMediaByExternalId(tx, { source: 'imdb', id: 'tt0000000' }, 'movies', 'Nothing'), null);
    // Caller-controlled text: it came out of a filename.
    assert.equal(await findMediaByExternalId(tx, { source: 'tmdb', id: "1') OR 1=1 --" }, 'movies', 'Nothing'), null);
  });
});
