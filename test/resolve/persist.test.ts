import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { persistResolved } from '../../lib/resolve/persist';
import type { ResolvedMedia } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const SERIES: ResolvedMedia = {
  category: 'tv', kind: 'series', provider: 'tmdb', providerRef: 'tmdb:tv:t1',
  title: 'Test Show', sortTitle: 'test show', originalTitle: null,
  releaseDate: '2020-01-01', year: 2020, overview: null,
  raw: { probe: true }, people: [], parent: null,
  details: { movie: null, series: { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' }, season: null, episode: null, scene: null },
};
const SEASON: ResolvedMedia = {
  ...SERIES, kind: 'season', providerRef: 'tmdb:tv:t1:1', title: 'Season 1', sortTitle: 'season 1',
  details: { movie: null, series: null, season: { seasonNumber: 1 }, episode: null, scene: null },
  parent: SERIES,
};
const EPISODE: ResolvedMedia = {
  ...SERIES, kind: 'episode', providerRef: 'tmdb:tv:t1:1:1', title: 'Pilot', sortTitle: 'pilot',
  details: { movie: null, series: null, season: null, episode: { seasonNumber: 1, episodeNumber: 1, airDate: '2020-01-08' }, scene: null },
  parent: SEASON,
  people: [
    { providerRef: 'tmdb:person:p1', name: 'A Director', role: 'director', characterName: null, billingOrder: null, raw: {} },
    { providerRef: 'tmdb:person:p2', name: 'An Actor', role: 'performer', characterName: 'Someone', billingOrder: 0, raw: {} },
  ],
};

/** Every assertion runs inside a transaction that is then rolled back. */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('an episode writes its season and series first and returns the leaf id', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, EPISODE);
    assert.match(id, /^[0-9a-f-]{36}$/);
    const rows = await tx.execute(sql`
      SELECT id, provider_ref, kind, parent_id FROM media
       WHERE provider_ref LIKE 'tmdb:tv:t1%' ORDER BY provider_ref`);
    assert.equal(rows.rows.length, 3);
    const byRef = new Map(rows.rows.map((r) => [String(r.provider_ref), r]));
    const series = byRef.get('tmdb:tv:t1');
    const season = byRef.get('tmdb:tv:t1:1');
    const episode = byRef.get('tmdb:tv:t1:1:1');
    assert.equal(series?.parent_id, null);
    assert.equal(season?.parent_id, series?.id);
    assert.equal(episode?.parent_id, season?.id);
    assert.equal(episode?.id, id);
  });
});

test('persisting twice is idempotent rather than duplicating', opts, async () => {
  await inRollback(async (tx) => {
    const first = await persistResolved(tx, EPISODE);
    const second = await persistResolved(tx, EPISODE);
    assert.equal(first, second, 'the same providerRef must resolve to the same row');
    const count = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media WHERE provider_ref LIKE 'tmdb:tv:t1%'`);
    assert.equal(count.rows[0]?.n, 3);
  });
});

test('detail rows land in the table matching the kind', opts, async () => {
  await inRollback(async (tx) => {
    await persistResolved(tx, EPISODE);
    const ep = await tx.execute(sql`
      SELECT ed.season_number, ed.episode_number FROM episode_details ed
        JOIN media m ON m.id = ed.media_id WHERE m.provider_ref = 'tmdb:tv:t1:1:1'`);
    assert.equal(ep.rows[0]?.season_number, 1);
    assert.equal(ep.rows[0]?.episode_number, 1);
    const se = await tx.execute(sql`
      SELECT sd.season_number FROM season_details sd
        JOIN media m ON m.id = sd.media_id WHERE m.provider_ref = 'tmdb:tv:t1:1'`);
    assert.equal(se.rows[0]?.season_number, 1);
    const sr = await tx.execute(sql`
      SELECT srd.status FROM series_details srd
        JOIN media m ON m.id = srd.media_id WHERE m.provider_ref = 'tmdb:tv:t1'`);
    assert.equal(sr.rows[0]?.status, 'Ended');
  });
});

test('people are upserted and linked with their roles', opts, async () => {
  await inRollback(async (tx) => {
    await persistResolved(tx, EPISODE);
    const rows = await tx.execute(sql`
      SELECT p.name, mp.role, mp.character_name, mp.billing_order
        FROM media_people mp
        JOIN people p ON p.id = mp.person_id
        JOIN media m ON m.id = mp.media_id
       WHERE m.provider_ref = 'tmdb:tv:t1:1:1' ORDER BY p.name`);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]?.name, 'A Director');
    assert.equal(rows.rows[0]?.role, 'director');
    assert.equal(rows.rows[1]?.role, 'performer');
    assert.equal(rows.rows[1]?.character_name, 'Someone');
    assert.equal(rows.rows[1]?.billing_order, 0);
  });
});

test('the same person in two roles yields two links and one person row', opts, async () => {
  await inRollback(async (tx) => {
    await persistResolved(tx, {
      ...EPISODE,
      people: [
        { providerRef: 'tmdb:person:dual', name: 'Dual Role', role: 'director', characterName: null, billingOrder: null, raw: {} },
        { providerRef: 'tmdb:person:dual', name: 'Dual Role', role: 'writer', characterName: null, billingOrder: null, raw: {} },
      ],
    });
    const people = await tx.execute(sql`SELECT count(*)::int AS n FROM people WHERE provider_ref = 'tmdb:person:dual'`);
    assert.equal(people.rows[0]?.n, 1);
    const links = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media_people mp
        JOIN people p ON p.id = mp.person_id WHERE p.provider_ref = 'tmdb:person:dual'`);
    assert.equal(links.rows[0]?.n, 2);
  });
});

test('a movie writes movie_details and no parent', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, {
      category: 'movies', kind: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:t9',
      title: 'Test Film', sortTitle: 'test film', originalTitle: null,
      releaseDate: '1999-01-01', year: 1999, overview: null, raw: {}, people: [], parent: null,
      details: { movie: { runtimeMinutes: 100, imdbId: 'tt1', tagline: null, collectionName: null }, series: null, season: null, episode: null, scene: null },
    });
    const row = await tx.execute(sql`SELECT parent_id FROM media WHERE id = ${id}::uuid`);
    assert.equal(row.rows[0]?.parent_id, null);
    const md = await tx.execute(sql`SELECT imdb_id FROM movie_details WHERE media_id = ${id}::uuid`);
    assert.equal(md.rows[0]?.imdb_id, 'tt1');
  });
});

test('a scene writes scene_details, its performers, and no parent', opts, async () => {
  // The fifth detail table, and the only one reached through the xxx slice.
  // It was covered end to end through the route but never directly here, so
  // the mapping from `details.scene` to the columns was only ever asserted
  // once, at the far end of a pipeline.
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, {
      category: 'xxx', kind: 'scene', provider: 'tpdb', providerRef: 'tpdb:scene:t7',
      title: 'Two Girl Knockout', sortTitle: 'two girl knockout', originalTitle: null,
      releaseDate: '2022-07-07', year: 2022, overview: 'A scene.', raw: { probe: true },
      parent: null,
      details: {
        movie: null, series: null, season: null, episode: null,
        scene: { siteName: 'Spank Monster', siteRef: '4347', durationSeconds: 2340, releasedOn: '2022-07-07' },
      },
      people: [
        { providerRef: 'tpdb:person:t7a', name: 'Ruby Redbottom', role: 'performer', characterName: null, billingOrder: 0, raw: {} },
        { providerRef: 'tpdb:person:t7b', name: 'Octavia Red', role: 'performer', characterName: null, billingOrder: 1, raw: {} },
      ],
    });

    const media = await tx.execute(sql`
      SELECT kind, category, parent_id FROM media WHERE id = ${id}::uuid`);
    assert.equal(media.rows[0]?.kind, 'scene');
    assert.equal(media.rows[0]?.category, 'xxx');
    assert.equal(media.rows[0]?.parent_id, null, 'a scene has no ancestors');

    const details = await tx.execute(sql`
      SELECT site_name, duration_seconds, released_on FROM scene_details WHERE media_id = ${id}::uuid`);
    assert.equal(details.rows[0]?.site_name, 'Spank Monster');
    assert.equal(Number(details.rows[0]?.duration_seconds), 2340, 'seconds, not minutes');
    assert.match(String(details.rows[0]?.released_on), /^2022-07-07/);

    const links = await tx.execute(sql`
      SELECT p.name, mp.role, mp.billing_order FROM media_people mp
        JOIN people p ON p.id = mp.person_id
       WHERE mp.media_id = ${id}::uuid ORDER BY mp.billing_order`);
    assert.equal(links.rows.length, 2);
    assert.deepEqual(links.rows.map((r) => r.role), ['performer', 'performer']);
    assert.deepEqual(links.rows.map((r) => r.name), ['Ruby Redbottom', 'Octavia Red']);

    // No other detail table may have been written for this row.
    const strays = await tx.execute(sql`
      SELECT (SELECT count(*)::int FROM movie_details WHERE media_id = ${id}::uuid)
           + (SELECT count(*)::int FROM series_details WHERE media_id = ${id}::uuid)
           + (SELECT count(*)::int FROM season_details WHERE media_id = ${id}::uuid)
           + (SELECT count(*)::int FROM episode_details WHERE media_id = ${id}::uuid) AS n`);
    assert.equal(strays.rows[0]?.n, 0, 'the detail row lands only in the table matching the kind');
  });
});
