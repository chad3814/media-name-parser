import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { readMediaTree } from '../../lib/media/read';
import { persistResolved } from '../../lib/resolve/persist';
import type { ResolvedMedia } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const SERIES: ResolvedMedia = {
  category: 'tv', kind: 'series', provider: 'tmdb', providerRef: 'tmdb:tv:r1',
  title: 'Read Show', sortTitle: 'read show', originalTitle: null,
  releaseDate: '2020-01-01', year: 2020, overview: 'A show.',
  raw: {}, people: [], parent: null,
  details: { movie: null, series: { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' }, season: null, episode: null, scene: null },
};
const SEASON: ResolvedMedia = {
  ...SERIES, kind: 'season', providerRef: 'tmdb:tv:r1:2', title: 'Season 2', sortTitle: 'season 2',
  details: { movie: null, series: null, season: { seasonNumber: 2 }, episode: null, scene: null }, parent: SERIES,
};
const EPISODE: ResolvedMedia = {
  ...SERIES, kind: 'episode', providerRef: 'tmdb:tv:r1:2:4', title: 'Down', sortTitle: 'down',
  // The brief's fixture omits this override, leaving releaseDate at the
  // series' 2020-01-01 while the test below asserts the episode's air date
  // (2020-03-01). Adding it here so the media row matches what the test --
  // and persistResolved's actual column -- expect.
  releaseDate: '2020-03-01',
  details: { movie: null, series: null, season: null, episode: { seasonNumber: 2, episodeNumber: 4, airDate: '2020-03-01' }, scene: null },
  parent: SEASON,
  people: [
    { providerRef: 'tmdb:person:r1', name: 'Reed Director', role: 'director', characterName: null, billingOrder: null, raw: {} },
    { providerRef: 'tmdb:person:r2', name: 'Reed Actor', role: 'performer', characterName: 'Clerk', billingOrder: 2, raw: {} },
    { providerRef: 'tmdb:person:r3', name: 'Reed Lead', role: 'performer', characterName: 'Lead', billingOrder: 0, raw: {} },
  ],
};

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('an episode hydrates with its parents nearest-first and its people', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, EPISODE);
    const view = await readMediaTree(tx, id);
    assert.ok(view !== null);
    assert.equal(view.kind, 'episode');
    assert.equal(view.title, 'Down');
    assert.equal(view.providerRef, 'tmdb:tv:r1:2:4');
    assert.equal(view.releaseDate, '2020-03-01');
    assert.deepEqual(view.details, { seasonNumber: 2, episodeNumber: 4, airDate: '2020-03-01' });

    assert.equal(view.parents.length, 2, 'season then series');
    assert.equal(view.parents[0]?.kind, 'season');
    assert.equal(view.parents[1]?.kind, 'series');
    assert.equal(view.parents[1]?.title, 'Read Show');

    // Performers ordered by billing, crew after. Lead (0) before Clerk (2).
    const performers = view.people.filter((p) => p.role === 'performer').map((p) => p.name);
    assert.deepEqual(performers, ['Reed Lead', 'Reed Actor']);
    assert.ok(view.people.some((p) => p.role === 'director' && p.name === 'Reed Director'));
  });
});

test('a series hydrates with no parents and its own details', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, SERIES);
    const view = await readMediaTree(tx, id);
    assert.ok(view !== null);
    assert.deepEqual(view.parents, []);
    assert.deepEqual(view.details, { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' });
  });
});

test('an unknown id is null, not an error', opts, async () => {
  await inRollback(async (tx) => {
    assert.equal(await readMediaTree(tx, '00000000-0000-0000-0000-000000000000'), null);
  });
});

/**
 * Wraps a transaction so calls to `execute` are counted, without touching
 * production code. `readMediaTree` only ever calls `tx.execute`, so
 * intercepting that one method is enough to pin "three queries regardless of
 * depth" as an actual, checked commitment -- a per-level `parent_id` loop
 * would call `execute` once per ancestor on top of the base three, and this
 * makes that show up as a failing assertion instead of a passing one.
 */
function countingTx(tx: Tx, calls: { count: number }): Tx {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (...args: Parameters<Tx['execute']>) => {
          calls.count += 1;
          return target.execute(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * The static text of a drizzle `sql` template, with the bound parameters
 * elided. Enough to see which columns a query asks for, which is the one thing
 * the test below is about.
 */
function staticText(query: SQL): string {
  return query.queryChunks
    .map((chunk) => (chunk instanceof StringChunk ? chunk.value.join('') : ' ? '))
    .join('');
}

/** Like `countingTx`, but keeps the statements so they can be inspected. */
function capturingTx(tx: Tx, statements: string[]): Tx {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (...args: Parameters<Tx['execute']>) => {
          const [query] = args;
          if (query instanceof SQL) statements.push(staticText(query));
          return target.execute(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

test('hydration never selects the raw provider payload', opts, async () => {
  // `media.raw` is the whole provider response: recorded season payloads run
  // 348-388 KB. `readMediaTree` runs on every lookup response, cache hits
  // included, so an ancestry CTE selecting `m.*` moved roughly half a megabyte
  // per cached episode out of Neon purely to throw it away -- and tens of
  // megabytes for a 100-item batch. Nine scalar columns are all anything below
  // reads. Asserted against the statement text because the cost is invisible
  // from the returned value: `m.*` and an enumerated list build the identical
  // `MediaView`.
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, EPISODE);
    const statements: string[] = [];
    const view = await readMediaTree(capturingTx(tx, statements), id);
    assert.ok(view !== null);
    assert.equal(view.parents.length, 2, 'still the full ancestry');
    const ancestry = statements[0] ?? '';
    assert.doesNotMatch(ancestry, /\bm\.\*|\bp\.\*/,
      'the ancestry CTE must enumerate its columns, not take every column of media');
    assert.doesNotMatch(ancestry, /\braw\b/,
      'and must not fetch raw or raw_fetched_at, which nothing in MediaView reads');
  });
});

test('hydration costs a bounded number of queries regardless of depth', opts, async () => {
  // The claim is not just "an episode's ancestry resolves" (the first test
  // already covers that) but that the query count does not grow with depth.
  // A loop over parent_id would pass a bare parents.length assertion just as
  // well as the recursive CTE does, so this counts `tx.execute` calls
  // directly and checks the same count for zero ancestors and for two.
  await inRollback(async (tx) => {
    const episodeId = await persistResolved(tx, EPISODE);
    const seriesId = await persistResolved(tx, SERIES);

    const episodeCalls = { count: 0 };
    const episodeView = await readMediaTree(countingTx(tx, episodeCalls), episodeId);
    assert.ok(episodeView !== null);
    assert.equal(episodeView.parents.length, 2, 'season then series');
    assert.equal(episodeCalls.count, 3, 'ancestry + details + people, however deep');

    const seriesCalls = { count: 0 };
    const seriesView = await readMediaTree(countingTx(tx, seriesCalls), seriesId);
    assert.ok(seriesView !== null);
    assert.equal(seriesView.parents.length, 0);
    assert.equal(seriesCalls.count, 3, 'the same three queries with no ancestors at all');
  });
});

test('a scene carries the provider ids for its site and its performers', opts, async () => {
  // The scene's own id has always been on the node as `providerRef`. These two
  // were not, and without them a caller holding our answer cannot ask the
  // provider anything further about the site or the people in it.
  await inRollback(async (tx) => {
    const media = await tx.execute(sql`
      INSERT INTO media (category, kind, title, sort_title, provider, provider_ref,
                         raw, raw_fetched_at)
      VALUES ('xxx', 'scene', 'Ids Scene', 'Ids Scene', 'tpdb', 'tpdb-scene-ids',
              '{}'::jsonb, now())
      RETURNING id`);
    const mediaId = String(media.rows[0]?.id);
    await tx.execute(sql`
      INSERT INTO scene_details (media_id, site_name, site_ref, duration_seconds, released_on)
      VALUES (${mediaId}::uuid, 'Ids Site', '4242', 1800, '2026-09-01')`);
    const person = await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES ('tpdb', 'tpdb-person-ids', 'Ids Performer', 'Ids Performer', '{}'::jsonb, now())
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO media_people (media_id, person_id, role, billing_order)
      VALUES (${mediaId}::uuid, ${String(person.rows[0]?.id)}::uuid, 'performer', 0)`);

    const view = await readMediaTree(tx, mediaId);
    assert.equal(view?.providerRef, 'tpdb-scene-ids', 'the scene id');
    assert.equal(view?.details.siteRef, '4242', 'the site id, beside its display name');
    assert.equal(view?.details.siteName, 'Ids Site');
    assert.equal(view?.people[0]?.providerRef, 'tpdb-person-ids', 'the performer id');
    assert.equal(view?.people[0]?.name, 'Ids Performer');
  });
});
