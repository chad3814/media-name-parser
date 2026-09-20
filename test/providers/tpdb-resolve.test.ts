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

/** A leaf site under a brand, as RK Prime sits under Reality Kings. */
const REALITY_KINGS = { id: 20, name: 'Reality Kings', short_name: 'realitykings' };
const RKPRIME = {
  id: 26, name: 'RK Prime', short_name: 'rkprime',
  parent: REALITY_KINGS, network: REALITY_KINGS,
};

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
  // The corroborating row also carries the parsed date, so it earns the date
  // band rather than the bare site one -- the same two fields `byDate` asks
  // for, checked on the row instead. `a parse with no date at all is scored
  // exactly as before` pins the site-only band.
  assert.equal(out?.confidence, 0.98);
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
  // Three dates, then the text fallback spelled every way worth trying. This
  // name has no digits, so the three re-spellings collapse onto the parsed
  // one and only the term ladder adds calls: 6 rather than the 4 this cost
  // before the ladder existed. The extra two are paid only by a name that
  // finds nothing at all -- a name that hits still costs exactly one text
  // call -- and buying them is what takes a corpus sample from 20/30 to
  // 24/30.
  assert.deepEqual(
    calls.map((call) => call.query.q),
    [
      undefined, undefined, undefined,
      'SpankMonster Ruby Redbottom And Octavia Red',
      'SpankMonster Ruby Redbottom Octavia Red',
      'SpankMonster Ruby Redbottom And Octavia',
      'SpankMonster Ruby Redbottom',
    ],
    'three dates, the full text query, the conjunction dropped, then the ladder',
  );
});

test('among same-site results the closest title wins, not the first returned', async () => {
  // The site narrows the candidates; it does not choose among them. Scoring
  // the first same-site row 0.85 puts it above the floor, so the pipeline
  // writes it as `resolved` -- with the title never consulted. This path runs
  // on the first lookup for every distinct site, which is exactly where a
  // wrong answer gets cached.
  const provider = createTpdbProvider(
    stubClient([], [[
      scene({ id: 'same-site-first', title: 'An Entirely Different Scene' }),
      scene({ id: 'same-site-better', title: 'Ruby Redbottom And Octavia Red' }),
    ]]),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(ANCHORED), ctx);

  // Both rows carry the parsed date, so the date narrows nothing here and
  // the title is still what separates them -- which is the point of the test.
  assert.equal(out?.confidence, 0.98);
  assert.equal(out?.media.providerRef, 'same-site-better',
    'the best title among the corroborated rows, not the first one the API listed');
});

test('a site match with no title to compare does not clear the floor', async () => {
  // A real corpus name: 29 of them parse to a site and a date with an empty
  // title, so `q` degenerates to the site name alone and every scene that
  // site ever published corroborates equally. That is a site match, not a
  // scene match, and 0.85 would persist an arbitrary row as `resolved`.
  const EMPTY_TITLE = 'Luna.Angel.26.08.16.XXX.2160p.nzb';
  const lunaAngel = { id: 51, name: 'Luna Angel', short_name: 'lunaangel' };
  const calls: Call[] = [];
  const provider = createTpdbProvider(
    stubClient(calls, [[scene({ id: 'any-luna-scene', title: 'Some Other Day', site: lunaAngel })]]),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(EMPTY_TITLE), ctx);

  assert.equal(parsed(EMPTY_TITLE).kind === 'scene' ? parsed(EMPTY_TITLE).title : 'x', '',
    'the fixture is only meaningful while this name still parses to an empty title');
  assert.equal(calls[0]?.query.q, 'Luna Angel', 'nothing but the site is left to search on');
  assert.ok((out?.confidence ?? 1) < 0.75,
    `a site match alone must stay under the floor, got ${String(out?.confidence)}`);
  assert.equal(out?.confidence, 0.70, 'a single uncorroborated result is the band it lands in');
});

test('a multi-token site finds its cached row: the API spells it without punctuation', async () => {
  // A real corpus name. `parseScene` gives the site as the filename spells it
  // (`Passion-HD`, and with a space for the many heads that span tokens);
  // theporndb.net stores `short_name: "passionhd"`. Lowercasing alone never
  // met, so the cache never hit, the three date queries were skipped, and all
  // 271 corpus names with a spaced site -- every one of them dated -- stayed
  // unresolved forever, since `rememberSite` wrote the API's spelling back.
  const PASSION_HD =
    'Passion-HD.25.10.15.Daisy.Pheonix.Mutual.Massage.XXX.2160p.MP4-WRB.nzb';
  const calls: Call[] = [];
  const provider = createTpdbProvider(
    stubClient(calls, [[scene({
      id: 'passionhd-scene',
      title: 'Daisy Pheonix Mutual Massage',
      date: '2025-10-15',
      site: { id: 4348, name: 'Passion HD', short_name: 'passionhd' },
    })]]),
    // Keyed exactly as the API spells it, which is what the table holds.
    siteCache({ passionhd: '4348' }).cache,
  );
  const out = await provider.resolve(parsed(PASSION_HD), ctx);

  assert.equal(calls.length, 1, 'a warm site is one indexed query, not a text search');
  assert.equal(calls[0]?.query.site_id, '4348');
  assert.equal(calls[0]?.query.date, '2025-10-15');
  assert.equal(calls[0]?.query.q, undefined);
  assert.equal(out?.confidence, 0.98, 'site id plus an exact date is the top band');
});

test('a failed cache write is logged, not fatal to the resolution it caches', async () => {
  // `remember` is awaited before the outcome is returned, so a throw used to
  // propagate into the pipeline, which threw away the scene it had already
  // fetched, wrote `pending`, and left the sweeper to repeat all four provider
  // calls and meet the same failing write again. A cache must not be able to
  // fail the thing it caches.
  const provider = createTpdbProvider(stubClient([], [[scene()]]), {
    find: () => Promise.resolve('4347'),
    remember: () => Promise.reject(new Error('duplicate key value violates unique constraint')),
  });
  const out = await provider.resolve(parsed(ANCHORED), ctx);

  assert.equal(out?.confidence, 0.98, 'the resolution survives its own cache write');
  assert.equal(out?.media.providerRef, 'adf4b545-8b59-4bad-a935-4f5ec83a16db');
});

test('a filename naming the brand above the site still resolves, one band lower', async () => {
  // `site_id` does not traverse the hierarchy -- querying Reality Kings (20)
  // returns zero scenes, while RK Prime (26) returns thousands -- so a
  // brand-named filename can only ever arrive here, through the text search.
  // Before this band the correct scene was found and then discarded at 0.70
  // for failing to match a leaf name it was never going to match.
  const calls: Call[] = [];
  const client = stubClient(calls, [[scene({ site: RKPRIME, title: 'Hooking Up' })]]);
  const out = await createTpdbProvider(client, siteCache().cache)
    .resolve(parsed('RealityKings.26.07.13.Hooking.Up.XXX.1080p.nzb'), ctx);

  assert.equal(out?.confidence, 0.80, 'a brand match clears the floor but is not a leaf match');
  assert.ok((out?.confidence ?? 0) >= 0.75, 'and it must clear the floor, or the scene is lost');
  assert.equal(out?.media.title, 'Hooking Up');
});

test('the network corroborates even when the parent is absent', async () => {
  // A site can carry a network with no parent -- `manyvidspuretaboopov` does.
  // Reading only `parent` would drop those.
  const site = { id: 26, name: 'RK Prime', short_name: 'rkprime', network: REALITY_KINGS };
  const out = await createTpdbProvider(
    stubClient([], [[scene({ site, title: 'Hooking Up' })]]), siteCache().cache,
  ).resolve(parsed('RealityKings.26.07.13.Hooking.Up.XXX.1080p.nzb'), ctx);
  assert.equal(out?.confidence, 0.80);
});

test('naming the exact site keeps the stronger band, brand or no brand', async () => {
  // The brand check runs only after the leaf check fails. If it ran first, or
  // instead, every RK Prime filename would quietly drop from 0.85 to 0.80.
  const out = await createTpdbProvider(
    stubClient([], [[scene({ site: RKPRIME, title: 'Hooking Up' })]]), siteCache().cache,
  ).resolve(parsed('RKPrime.26.07.13.Hooking.Up.XXX.1080p.nzb'), ctx);
  assert.equal(out?.confidence, 0.85, 'a leaf match must not be demoted by the brand fallback');
});

test('a tpdb id names the scene outright, with no search at all', async () => {
  // `/scenes/{id}` accepts the numeric `_id`, the uuid and the slug -- all
  // three verified against the live API -- so the filename's form is passed
  // through as written rather than normalised into one of them.
  const calls: Call[] = [];
  const client = {
    get: async <T>(path: string, query: Record<string, string | number | undefined>,
      schema: { parse: (v: unknown) => T }): Promise<T | null> => {
      calls.push({ path, query });
      return schema.parse({ data: scene({ title: 'Named By Id' }) });
    },
  } as unknown as TpdbClient;
  const out = await createTpdbProvider(client, siteCache().cache)
    .resolve(parsed('Whatever.Name {tpdb-2012507}.mp4'), ctx);

  assert.equal(out?.confidence, 1, 'an id is an assertion, not a match');
  assert.equal(out?.media.title, 'Named By Id');
  assert.deepEqual(calls.map((c) => c.path), ['/scenes/2012507'],
    'exactly one call, and no /scenes search');
});

test('an id belonging to another provider is ignored, not guessed at', async () => {
  // A `{tmdb-}` token on an xxx name names a record in a catalogue this
  // provider does not serve. It falls through to the ordinary strategy.
  const calls: Call[] = [];
  const client = stubClient(calls, [[scene({ date: '2022-07-07' })]]);
  const out = await createTpdbProvider(client, siteCache(WARM).cache)
    .resolve(parsed('SpankMonster.22.07.07.Ruby.Redbottom {tmdb-603}.mp4'), ctx);
  assert.ok(calls.every((c) => c.path === '/scenes'), `no id fetch: ${calls.map((c) => c.path).join(',')}`);
  assert.equal(out?.confidence, 0.98, 'the normal site-and-date path ran');
});

/**
 * A client that answers by query rather than by call order, so a test can say
 * "only this spelling is indexed" -- which is precisely the condition the
 * variant ladder exists to survive.
 */
function spellingClient(calls: Call[], indexed: Readonly<Record<string, readonly SceneInput[]>>): TpdbClient {
  return {
    async get<T>(
      path: string,
      query: Record<string, string | number | undefined>,
      schema: { parse: (value: unknown) => T },
    ): Promise<T | null> {
      calls.push({ path, query });
      const data = indexed[String(query.q ?? '')] ?? [];
      return schema.parse({ data, meta: { total: data.length } });
    },
  };
}

/** The reported failure: a catalogue code the filename glues and TPDB spaces. */
const GLUED_CODE =
  'Merry.Christmas.EMILY.PINK.Alicia.Trece.AND.Valentina.Milan.celebrate.Christmas.with.6.studs.with.huge.cocks.PD.LTP145.1080p';
const GLUED_CODE_TITLE =
  'Merry Christmas. Emily Pink. Alicia Trece and Valentina Milan Celebrate. Christmas with 6 Studs with Huge Cocks. Pd. Ltp 145';

/** The inverse: a title the filename spaces and TPDB glues. */
const SPACED_NUMBER = 'TeensWantOrgies.19.07.26.Kelly.Kline.2.chicks.and.a.cock.1080p';

test('a q that matches nothing is retried with the digit boundary split apart', async () => {
  // TPDB's `q` is a strict AND over whole terms -- verified live, a single
  // unindexed term returns zero rows -- and it does no prefix matching. The
  // filename's `LTP145` is `Ltp 145` upstream, so the one call the provider
  // used to make found nothing at all for a name that is otherwise the exact
  // title.
  const calls: Call[] = [];
  const asParsed = 'Merry Christmas EMILY PINK Alicia Trece AND Valentina Milan celebrate Christmas with 6 studs with huge cocks PD LTP145';
  const respelled = asParsed.replace('LTP145', 'LTP 145');
  const provider = createTpdbProvider(
    spellingClient(calls, {
      [respelled]: [scene({ title: GLUED_CODE_TITLE, site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(GLUED_CODE), ctx);

  // This title also carries an `AND`, so the safe term-dropping variant runs
  // between the two. It still finds nothing here: the record spells the
  // conjunction out, so dropping it changes nothing that mattered, and
  // `LTP145` is still the term the index does not hold.
  assert.deepEqual(
    calls.map((c) => c.query.q),
    [asParsed, asParsed.replace(' AND ', ' '), respelled],
    'as parsed, the conjunction dropped, then the split spelling',
  );
  assert.equal(out?.media.title, GLUED_CODE_TITLE);
});

test('a q that matches nothing is retried with a spaced number glued on', async () => {
  // The inverse spelling disagreement: the filename has `2.chicks` and the
  // scene is titled `2Chicks and a Cock`. The two glue directions are
  // separate variants on purpose -- applying both at once fuses
  // `Kline 2 chicks` into `Kline2chicks`, which matches nothing either.
  const calls: Call[] = [];
  const glued = 'TeensWantOrgies Kelly Kline 2chicks and a cock';
  const provider = createTpdbProvider(
    spellingClient(calls, {
      [glued]: [scene({ title: '2Chicks and a Cock', date: '2019-07-26',
        site: { id: 77, name: 'Teens Want Orgies', short_name: 'teenswantorgies' } })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(SPACED_NUMBER), ctx);

  assert.ok(calls.some((c) => c.query.q === glued), 'the glued spelling is tried');
  assert.ok(calls.every((c) => c.query.q !== 'TeensWantOrgies Kelly Kline2chicks and a cock'),
    'the two glue directions are never applied together');
  assert.equal(out?.media.title, '2Chicks and a Cock');
  assert.equal(out?.confidence, 0.98,
    'the site and the parsed date both corroborate it from outside the search');
});

test('a q no respelling rescues drops trailing terms until something answers', async () => {
  // Fewer terms can only widen a strict AND, so the ladder is the general
  // fallback for a term TPDB simply does not index.
  const calls: Call[] = [];
  const provider = createTpdbProvider(
    spellingClient(calls, {
      'Ruby Redbottom And': [scene({ site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(BARE), ctx);

  assert.ok(calls.length > 1, 'the first spelling found nothing and the ladder ran');
  assert.equal(calls[calls.length - 1]?.query.q, 'Ruby Redbottom And');
  assert.equal(out?.media.title, 'Two Girl Knockout');
});

test('a near-exact long title clears the floor with no site to corroborate it', async () => {
  // The reported failure resolved its search and was still recorded
  // `unresolved`: with `site` null the two corroborated bands are skipped and
  // the ceiling was TEXT_SINGLE, under the floor. A 0.99 similarity across
  // 118 characters is evidence about identity in its own right -- stronger,
  // not weaker, than a six-character site name agreeing.
  const provider = createTpdbProvider(
    spellingClient([], {
      'Merry Christmas EMILY PINK Alicia Trece AND Valentina Milan celebrate Christmas with 6 studs with huge cocks PD LTP 145':
        [scene({ title: GLUED_CODE_TITLE, site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(GLUED_CODE), ctx);

  assert.equal(out?.confidence, 0.85);
  assert.ok((out?.confidence ?? 0) >= 0.75, 'this is the band that makes it resolved');
});

test('a short title matching exactly does not earn the near-exact band', async () => {
  // `Anal` is an exact match against a great many scenes, so an exact match
  // on a short title says nothing about identity. The length guard is what
  // keeps the band honest; 36.6% of corpus titles fall under it.
  const provider = createTpdbProvider(
    spellingClient([], { Anal: [scene({ title: 'Anal', site: null, site_id: null })] }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed('Anal.mp4'), ctx);

  assert.equal(out?.confidence, 0.70, 'still the uncorroborated single-result band');
  assert.ok((out?.confidence ?? 1) < 0.75);
});

/**
 * Two scenes of one performer on one site, told apart only by their date --
 * the shape that resolved both filenames onto a single scene.
 */
const LHB = { id: 6883, name: 'Love Her Boobs', short_name: 'loveherboobs' };
const LHB_18 = scene({
  id: 'lhb-18', title: 'JOI Boob Tease With Gigi Lysette', date: '2026-06-18',
  site_id: 6883, site: LHB,
});
const LHB_29 = scene({
  id: 'lhb-29', title: 'Making Her Feel Special', date: '2026-06-29',
  site_id: 6883, site: LHB,
});

test('a cold site uses the parsed date to choose among the rows it got back', async () => {
  // Both scenes come back from the one text search, and the parsed title is
  // just the performer's name, so title similarity prefers the longer title
  // containing it (0.375) over the right scene (0.261) -- for both
  // filenames. The date is in the parse and on every row, and was discarded.
  const provider = createTpdbProvider(
    spellingClient([], { 'LoveHerBoobs Gigi Lysette': [LHB_18, LHB_29] }),
    siteCache().cache,
  );

  const later = await provider.resolve(parsed('LoveHerBoobs.26.06.29.Gigi.Lysette.2160p'), ctx);
  assert.equal(later?.media.title, 'Making Her Feel Special');
  assert.equal(later?.media.releaseDate, '2026-06-29');

  const earlier = await provider.resolve(parsed('LoveHerBoobs.26.06.18.Gigi.Lysette.2160p'), ctx);
  assert.equal(earlier?.media.title, 'JOI Boob Tease With Gigi Lysette');
  assert.equal(earlier?.media.releaseDate, '2026-06-18');
});

test('a site and an exact date agreeing on the row earns the same band as querying them', async () => {
  // `byDate` earns 0.98 because site_id plus an exact date is nearly a
  // primary key. Checking those same two fields on a row the text search
  // returned is the same assertion, so it is the same band -- a cold site
  // now scores what a warm one would.
  const provider = createTpdbProvider(
    spellingClient([], { 'LoveHerBoobs Gigi Lysette': [LHB_18, LHB_29] }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed('LoveHerBoobs.26.06.29.Gigi.Lysette.2160p'), ctx);
  assert.equal(out?.confidence, 0.98);
});

test('a date a day out on the row earns the day-out band, not the exact one', async () => {
  const provider = createTpdbProvider(
    spellingClient([], { 'LoveHerBoobs Gigi Lysette': [LHB_18] }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed('LoveHerBoobs.26.06.19.Gigi.Lysette.2160p'), ctx);
  assert.equal(out?.confidence, 0.90);
  assert.equal(out?.media.title, 'JOI Boob Tease With Gigi Lysette');
});

test('a contradicted date with a title that carries itself keeps the site band', async () => {
  // Measured: dates can be a couple of days out and still be the same scene.
  // This one is two days out with a 0.83 title similarity -- demoting it
  // would turn a correct resolution into a suggestion.
  const provider = createTpdbProvider(
    spellingClient([], {
      'SweetieFox Passionate Spider Woman vs Anal Fuck Lover Black Spider Girl': [
        scene({
          title: 'Passionate Spider Woman vs Anal Fuck Lover Black Spider-Girl',
          date: '2023-06-16', site_id: 91, site: { id: 91, name: 'Sweetie Fox', short_name: 'sweetiefox' },
        }),
      ],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(
    parsed('SweetieFox.23.06.18.Passionate.Spider.Woman.vs.Anal.Fuck.Lover.Black.Spider.Girl.2160p'), ctx,
  );
  assert.equal(out?.confidence, 0.85, 'the title alone is enough to keep the site band');
});

test('a contradicted date with a weak title drops below the floor', async () => {
  // A year out, and the parsed title is only the performer's name, so
  // nothing corroborates the row: 0.85 here is a confidently wrong answer
  // recorded as `resolved`, which is worse than a suggestion.
  const provider = createTpdbProvider(
    spellingClient([], {
      'Milflicious London River': [
        scene({
          title: 'Naughty Games W/ My Stepmom London River', date: '2025-09-04',
          site_id: 55, site: { id: 55, name: 'Milflicious', short_name: 'milflicious' },
        }),
      ],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed('Milflicious.26.08.20.London.River.2160p'), ctx);
  assert.ok((out?.confidence ?? 1) < 0.75,
    `a contradicted date and a weak title is a suggestion, got ${out?.confidence}`);
});

test('a parse with no date at all is scored exactly as before', async () => {
  // The demotion keys off a date the filename actually asserted. A name that
  // never named one cannot have it contradicted.
  const provider = createTpdbProvider(
    spellingClient([], { 'SpankMonster Ruby Redbottom And Octavia Red': [scene()] }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(LIBRARY_UNDATED), ctx);
  assert.equal(out?.confidence, 0.85);
});

/** The reported failure: the filename spells `and` where the record has `&`. */
const AMPERSAND =
  'Emily.Pink.and.Kaira.Love.ATOGM.DAP.Rough.Gapes.Pee.Drink.Cum.in.Mouth.Swallow.GIO2248.2160p';
const AMPERSAND_TITLE =
  'The Dark Room Wet #2 Wet, 6On2 Emily Pink & Kaira Love , Atogm, Dap, Rough, Gapes, '
  + 'Pee Drink, Cum in Mouth, Swallow Gio2248';

test('a q that matches nothing is retried without the conjunction', async () => {
  // `and` is an ordinary indexed term on this API, not a stopword -- verified
  // live, a query carrying it against a record spelling it `&` returns zero
  // rows. It is a whole term in 16.2% of corpus titles, and on a 30-name
  // sample of those only 7 matched as parsed while 20 more came back the
  // moment it was dropped, most of them a single row.
  const calls: Call[] = [];
  const asParsed = 'Emily Pink and Kaira Love ATOGM DAP Rough Gapes Pee Drink Cum in Mouth Swallow GIO2248';
  const dropped = asParsed.replace(' and ', ' ');
  const provider = createTpdbProvider(
    spellingClient(calls, {
      [dropped]: [scene({ title: AMPERSAND_TITLE, date: null, site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(AMPERSAND), ctx);

  assert.deepEqual(calls.map((c) => c.query.q), [asParsed, dropped],
    'as parsed first, then the same query without the conjunction');
  assert.equal(out?.media.title, AMPERSAND_TITLE);
});

test('the conjunction retry is tried before the digit respellings', async () => {
  // Dropping a term can only widen a strict AND, so it can never lose a
  // result the parsed spelling would have found. Re-spelling a digit
  // boundary is a guess and can miss, so the safe variant goes first -- and
  // for this name the split spelling actively breaks `GIO2248`, which the
  // record writes glued.
  const calls: Call[] = [];
  const provider = createTpdbProvider(spellingClient(calls, {}), siteCache().cache);
  await provider.resolve(parsed(AMPERSAND), ctx);

  const queries = calls.map((c) => String(c.query.q));
  const withoutAnd = queries.findIndex((q) => !q.includes(' and ') && q.includes('GIO2248'));
  const split = queries.findIndex((q) => q.includes('GIO 2248'));
  assert.ok(withoutAnd !== -1, `the conjunction variant ran: ${queries.join(' | ')}`);
  assert.ok(split !== -1, 'the split variant still runs');
  assert.ok(withoutAnd < split, 'the term-dropping variant comes before the respellings');
});

test('a title that is nothing but a conjunction does not search for an empty string', async () => {
  const calls: Call[] = [];
  const provider = createTpdbProvider(spellingClient(calls, {}), siteCache().cache);
  await provider.resolve(parsed('And.mp4'), ctx);
  assert.ok(calls.every((c) => String(c.query.q).length > 0),
    `no empty query: ${JSON.stringify(calls.map((c) => c.query.q))}`);
});

test('a title whose terms the record covers clears the floor without a site', async () => {
  // The reported name is a truncation of the record's title: the record
  // carries a `The Dark Room Wet #2 Wet, 6On2` prefix the filename never
  // had. Levenshtein charges for those 30 missing characters and scores the
  // pair 0.70, under the near-exact threshold, so a single unambiguous match
  // was offered as a suggestion. Term coverage reads the same pair at 0.94.
  const provider = createTpdbProvider(
    spellingClient([], {
      'Emily Pink Kaira Love ATOGM DAP Rough Gapes Pee Drink Cum in Mouth Swallow GIO2248':
        [scene({ title: AMPERSAND_TITLE, date: null, site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(AMPERSAND), ctx);
  assert.equal(out?.media.title, AMPERSAND_TITLE);
  assert.equal(out?.confidence, 0.80);
  assert.ok((out?.confidence ?? 0) >= 0.75, 'this is the band that makes it resolved');
});

test('coverage reads a record title the filename wraps in site and performer names', async () => {
  // The commoner direction: the filename adds a site and a performer the
  // record's title does not carry, so the record is the *shorter* side.
  // Measured on a corpus sample, every below-floor single-row result was
  // correct and four of six ran this way round.
  const provider = createTpdbProvider(
    spellingClient([], {
      'Brazzers Lia Lin Giving Her All She Can Handle':
        [scene({ title: 'Giving Her All She Can Handle', date: null, site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed('Brazzers.Lia.Lin.Giving.Her.All.She.Can.Handle.2160p'), ctx);
  assert.equal(out?.confidence, 0.80);
});

test('a near-exact title still earns the stronger band, not the coverage one', async () => {
  const provider = createTpdbProvider(
    spellingClient([], {
      'Merry Christmas EMILY PINK Alicia Trece Valentina Milan celebrate Christmas with 6 studs with huge cocks PD LTP145':
        [scene({ title: GLUED_CODE_TITLE, date: null, site: null, site_id: null })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(GLUED_CODE), ctx);
  assert.equal(out?.confidence, 0.85, 'near-exact outranks merely covered');
});

test('a short title the record happens to contain does not earn the coverage band', async () => {
  // `London River` is covered completely by `Naughty Games W/ My Stepmom
  // London River`, and that pair is a wrong match a year apart. The length
  // floor is the only thing standing between coverage and a confident
  // mistake on every performer-name-only filename.
  const provider = createTpdbProvider(
    spellingClient([], {
      'London River': [scene({
        title: 'Naughty Games W/ My Stepmom London River', date: null, site: null, site_id: null,
      })],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed('London.River.2160p'), ctx);
  assert.equal(out?.confidence, 0.70, 'still the uncorroborated single-result band');
  assert.ok((out?.confidence ?? 1) < 0.75);
});

test('a record sharing only a couple of words does not earn the coverage band', async () => {
  // The wrong suggestion the ladder used to offer for the reported name:
  // it shares `and`, `love` and `gapes` and nothing else, reading 0.19.
  const provider = createTpdbProvider(
    spellingClient([], {
      'Emily Pink Kaira Love ATOGM DAP Rough Gapes Pee Drink Cum in Mouth Swallow GIO2248': [
        scene({
          title: 'Only Gapes Compilation #1 with Jolee Love, Anna De Ville, Alicia Trece, '
            + 'Monika Fox and Other 22 Girl. 60+ Gapes Clips Xf 254',
          date: null, site: null, site_id: null,
        }),
      ],
    }),
    siteCache().cache,
  );
  const out = await provider.resolve(parsed(AMPERSAND), ctx);
  assert.ok((out?.confidence ?? 1) < 0.75, `sharing three words is not a match, got ${out?.confidence}`);
});
