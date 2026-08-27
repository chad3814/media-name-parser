import { test, after } from 'node:test';
import assert from 'node:assert/strict';
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
  details: { movie: null, series: { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' }, season: null, episode: null },
};
const SEASON: ResolvedMedia = {
  ...SERIES, kind: 'season', providerRef: 'tmdb:tv:r1:2', title: 'Season 2', sortTitle: 'season 2',
  details: { movie: null, series: null, season: { seasonNumber: 2 }, episode: null }, parent: SERIES,
};
const EPISODE: ResolvedMedia = {
  ...SERIES, kind: 'episode', providerRef: 'tmdb:tv:r1:2:4', title: 'Down', sortTitle: 'down',
  // The brief's fixture omits this override, leaving releaseDate at the
  // series' 2020-01-01 while the test below asserts the episode's air date
  // (2020-03-01). Adding it here so the media row matches what the test --
  // and persistResolved's actual column -- expect.
  releaseDate: '2020-03-01',
  details: { movie: null, series: null, season: null, episode: { seasonNumber: 2, episodeNumber: 4, airDate: '2020-03-01' } },
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
