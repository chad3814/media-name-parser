import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { z } from 'zod';
import { createTpdbProvider, type TpdbSiteCache } from '../../lib/providers/tpdb/resolve';
import { sceneSchema } from '../../lib/providers/tpdb/schema';
import type { TpdbClient } from '../../lib/providers/tpdb/client';
import type { RememberedSite } from '../../lib/providers/tpdb/sites';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';

/** The shape the API sends, before `sceneSchema` applies its defaults. */
type SceneInput = z.input<typeof sceneSchema>;

interface Call {
  readonly path: string;
  readonly query: Record<string, string | number | undefined>;
}

/**
 * A client that answers from a scripted list of pages and records every call.
 *
 * The call sequence is part of the provider's contract -- one query for a warm
 * site, three dates before the text fallback -- so the tests below assert on
 * `calls`, not only on what came back.
 */
function stubClient(calls: Call[], pages: readonly (readonly SceneInput[])[]): TpdbClient {
  let index = 0;
  return {
    async get<T>(
      path: string,
      query: Record<string, string | number | undefined>,
      schema: { parse: (value: unknown) => T },
    ): Promise<T | null> {
      calls.push({ path, query });
      const data = pages[index] ?? [];
      index += 1;
      return schema.parse({ data, meta: { total: data.length } });
    },
  };
}

function siteCache(known: Readonly<Record<string, string>> = {}) {
  const remembered: RememberedSite[] = [];
  const cache: TpdbSiteCache = {
    find: (shortName) => Promise.resolve(known[shortName.toLowerCase()] ?? null),
    remember: (site) => {
      remembered.push(site);
      return Promise.resolve();
    },
  };
  return { cache, remembered };
}

const WARM = { spankmonster: '4347' };

const SPANKMONSTER = { id: 4347, name: 'Spank Monster', short_name: 'spankmonster' };

function scene(over: Partial<SceneInput> = {}): SceneInput {
  return {
    id: 'adf4b545-8b59-4bad-a935-4f5ec83a16db',
    title: 'Two Girl Knockout',
    date: '2022-07-07',
    duration: 2340,
    description: 'A scene description.',
    site_id: 4347,
    site: SPANKMONSTER,
    performers: [
      { id: 'credited-1', name: 'Ruby Redbottom', parent: { id: 'canonical-1', name: 'Ruby Red' } },
      { id: 'credited-2', name: 'Octavia Red' },
    ],
    ...over,
  };
}

/** Real parses, so the tests cannot drift from what the parser actually emits. */
const ANCHORED = 'SpankMonster.22.07.07.Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb';
const NEW_YEAR = 'SpankMonster.22.12.31.Ruby.Redbottom.XXX.2160p.MP4-WRB.nzb';
const LIBRARY_UNDATED = 'Scenes/SpankMonster/Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.mp4';
const BARE = 'Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb';

function parsed(name: string): ParsedVideo {
  const result = parseVideo('xxx', name);
  if (!result.ok) throw new Error(`fixture refused: ${result.refusal}`);
  return result.parsed;
}

const ctx = { signal: new AbortController().signal, lookupId: null };

test('supports only the category it can resolve', () => {
  const provider = createTpdbProvider(stubClient([], []), siteCache().cache);
  assert.equal(provider.name, 'tpdb');
  assert.equal(provider.supports('xxx'), true);
  assert.equal(provider.supports('movies'), false);
  assert.equal(provider.supports('tv'), false);
  assert.equal(provider.supports('books'), false);
});

test('a known site and an exact date is one call, and is believed most', async () => {
  // site_id plus an exact date is very nearly a primary key on this API: the
  // worked example returns exactly one row.
  const calls: Call[] = [];
  const provider = createTpdbProvider(stubClient(calls, [[scene()]]), siteCache(WARM).cache);
  const out = await provider.resolve(parsed(ANCHORED), ctx);

  assert.equal(calls.length, 1, 'a warm site costs one indexed query and nothing else');
  assert.equal(calls[0]?.path, '/scenes');
  assert.equal(calls[0]?.query.site_id, '4347');
  assert.equal(calls[0]?.query.date, '2022-07-07');
  assert.equal(calls[0]?.query.q, undefined, 'the text fallback must not run when a date hits');
  assert.equal(out?.confidence, 0.98);
});

test('a miss on the exact date tries the day before, then the day after', async () => {
  // Filenames are sometimes a day out either way. dateOperation was tested
  // live with >=, <=, gte, greater and after and returned nothing for every
  // one of them, so there is no range query and three exact queries are the
  // mechanism.
  const calls: Call[] = [];
  const provider = createTpdbProvider(
    stubClient(calls, [[], [], [scene({ date: '2022-07-08' })]]), siteCache(WARM).cache,
  );
  const out = await provider.resolve(parsed(ANCHORED), ctx);

  assert.deepEqual(
    calls.map((call) => call.query.date),
    ['2022-07-07', '2022-07-06', '2022-07-08'],
    'exact first, then a day back, then a day forward',
  );
  assert.equal(calls.length, 3, 'a hit on the third date stops before the text fallback');
  assert.equal(out?.confidence, 0.90, 'a day out is believed less than an exact hit');
});

test('the day either side is computed in UTC, so it crosses a year end correctly', async () => {
  // `new Date('2022-12-31')` is midnight UTC, but a local-timezone setDate
  // lands on the wrong day west of Greenwich -- silently, and only for some
  // deployments.
  const calls: Call[] = [];
  const provider = createTpdbProvider(stubClient(calls, [[], [], []]), siteCache(WARM).cache);
  await provider.resolve(parsed(NEW_YEAR), ctx);

  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.query.date),
    ['2022-12-31', '2022-12-30', '2023-01-01'],
  );
});

test('an unknown site falls back to a q search and scores below the floor', async () => {
  // Below CONFIDENCE_FLOOR on purpose: a text search with nothing
  // corroborating it is a suggestion, and belongs in the admin browser's low
  // band until a human pins it.
  const calls: Call[] = [];
  const provider = createTpdbProvider(
    stubClient(calls, [[scene(), scene({ id: 'other', title: 'Something Else' })]]),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(BARE), ctx);

  assert.equal(calls.length, 1, 'no site and no date skips straight to the text search');
  assert.equal(calls[0]?.query.q, 'Ruby Redbottom And Octavia Red');
  assert.equal(calls[0]?.query.site_id, undefined);
  assert.equal(out?.confidence, 0.60, 'several uncorroborated results is the weakest band');
  assert.ok((out?.confidence ?? 1) < 0.75);
});

test('a single uncorroborated q result is still below the floor', async () => {
  const provider = createTpdbProvider(
    stubClient([], [[scene({ site: null, site_id: null })]]), siteCache().cache,
  );
  const out = await provider.resolve(parsed(BARE), ctx);
  assert.equal(out?.confidence, 0.70);
  assert.ok((out?.confidence ?? 1) < 0.75);
});

test('a q result whose site matches the parsed site clears the floor', async () => {
  // The site is parsed but not yet cached, so steps 1-3 are skipped for want
  // of a site_id. The returned short_name corroborates the search from
  // outside it, which is what earns the band above the floor.
  const calls: Call[] = [];
  const cache = siteCache();
  const provider = createTpdbProvider(
    stubClient(calls, [[scene({ id: 'wrong-site', site: { id: 9, name: 'Elsewhere', short_name: 'elsewhere' } }), scene()]]),
    cache.cache,
  );
  const out = await provider.resolve(parsed(ANCHORED), ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query.q, 'SpankMonster Ruby Redbottom And Octavia Red');
  assert.equal(out?.confidence, 0.85);
  assert.equal(out?.media.providerRef, 'adf4b545-8b59-4bad-a935-4f5ec83a16db',
    'the corroborated result wins over the first one returned');
});

test('the resolved media is a scene with its details and performers', async () => {
  const provider = createTpdbProvider(
    stubClient([], [[scene({ duration: 2340 })]]), siteCache(WARM).cache,
  );
  const out = await provider.resolve(parsed(ANCHORED), ctx);
  const media = out?.media;

  assert.equal(media?.kind, 'scene');
  assert.equal(media?.category, 'xxx');
  assert.equal(media?.provider, 'tpdb');
  assert.equal(media?.parent, null, 'a scene has no ancestors');
  assert.equal(media?.title, 'Two Girl Knockout');
  assert.equal(media?.releaseDate, '2022-07-07');
  assert.equal(media?.year, 2022);
  assert.equal(media?.details.movie, null);
  assert.equal(media?.details.episode, null);
  assert.equal(media?.details.scene?.durationSeconds, 2340, 'duration is seconds, not minutes');
  assert.equal(media?.details.scene?.siteName, 'Spank Monster');
  assert.equal(media?.details.scene?.releasedOn, '2022-07-07');
  assert.equal(media?.people.length, 2);
  assert.ok(media?.people.every((person) => person.role === 'performer'));
  assert.deepEqual(media?.people.map((person) => person.name), ['Ruby Redbottom', 'Octavia Red']);
  assert.deepEqual(
    media?.people.map((person) => person.providerRef),
    ['canonical-1', 'credited-2'],
    'the canonical parent id is preferred, falling back to the credited one',
  );
});

test('a resolved scene remembers its site, lowercased, for next time', async () => {
  // This is what makes the second lookup for a site one call instead of four.
  const cache = siteCache();
  const provider = createTpdbProvider(
    stubClient([], [[scene({ site: { id: 4347, name: 'Spank Monster', short_name: 'SpankMonster' } })]]),
    cache.cache,
  );
  await provider.resolve(parsed(ANCHORED), ctx);

  assert.deepEqual(cache.remembered, [
    { providerRef: '4347', shortName: 'spankmonster', name: 'Spank Monster' },
  ]);
});

test('a scene resolved through a warm site refreshes the cache too', async () => {
  const cache = siteCache(WARM);
  const provider = createTpdbProvider(stubClient([], [[scene()]]), cache.cache);
  await provider.resolve(parsed(ANCHORED), ctx);
  assert.equal(cache.remembered[0]?.providerRef, '4347');
});

test('a scene with no site is resolved without touching the site cache', async () => {
  const cache = siteCache();
  const provider = createTpdbProvider(
    stubClient([], [[scene({ site: null, site_id: null })]]), cache.cache,
  );
  const out = await provider.resolve(parsed(BARE), ctx);
  assert.ok(out !== null);
  assert.deepEqual(cache.remembered, []);
  assert.equal(out.media.details.scene?.siteName, null);
});

test('a parse with no date skips the three date queries and makes one call', async () => {
  // The site comes from the parent directory and is already cached, but with
  // no date there is nothing for steps 1-3 to ask. A step whose inputs are
  // absent is skipped, not failed.
  const calls: Call[] = [];
  const provider = createTpdbProvider(stubClient(calls, [[scene()]]), siteCache(WARM).cache);
  const out = await provider.resolve(parsed(LIBRARY_UNDATED), ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query.date, undefined);
  assert.equal(calls[0]?.query.q, 'SpankMonster Ruby Redbottom And Octavia Red');
  assert.equal(out?.confidence, 0.85);
});

test('nothing matched returns null rather than a low-confidence guess', async () => {
  const calls: Call[] = [];
  const provider = createTpdbProvider(stubClient(calls, []), siteCache(WARM).cache);
  const out = await provider.resolve(parsed(ANCHORED), ctx);

  assert.equal(out, null, 'the pipeline records null as unresolved, which is the honest answer');
  assert.equal(calls.length, 4, 'three dates and then the text fallback, and no more');
});
