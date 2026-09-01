import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { handleLookup } from '../../lib/http/lookupHandler';
import { createTpdbClient } from '../../lib/providers/tpdb/client';
import { createTpdbProvider, type TpdbSiteCache } from '../../lib/providers/tpdb/resolve';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { fixtureFetch } from '../support/tmdb-fixtures';
import type { Category } from '../../lib/parse/types';
import { mintApiKey } from '../../lib/auth/apiKey';
import type { PipelineDeps } from '../../lib/resolve/pipeline';
import type { ProviderCallRecord } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/** A real corpus name, anchored to a known site/date/performer pair. */
const NAME = 'SpankMonster.22.07.07.Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb';
/** Unique enough in this table to double as the cleanup prefix. */
const CLEAN_PREFIX = 'SpankMonster.22.07.07.Ruby.Redbottom';
/** The mixed-category batch below, under its own prefix so `clean` finds it. */
const MIXED_PREFIX = 'xxxmix';
const MIXED_MOVIE = `${MIXED_PREFIX}/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb`;
const MIXED_SCENE = `${MIXED_PREFIX}/${NAME}`;

const FIXTURE_SCENE = {
  id: 'xxxtest-scene-1',
  title: 'Ruby Redbottom And Octavia Red Caught in the Model House Hallway',
  date: '2022-07-07',
  // Seconds, as `scene_details.duration_seconds` stores it.
  duration: 2340,
  description: 'A fixture scene standing in for the live TPDB response.',
  site_id: 4347,
  site: { id: 4347, name: 'Spank Monster', short_name: 'spankmonster' },
  performers: [
    { id: 'xxxtest-perf-1', name: 'Ruby Redbottom', parent: { id: 'xxxtest-canon-1', name: 'Ruby Red' } },
    { id: 'xxxtest-perf-2', name: 'Octavia Red' },
  ],
};

/**
 * An in-memory site cache, kept out of `provider_sites` on purpose.
 *
 * `dbSiteCache()` -- the default -- commits a real row through this test's
 * own transaction and out the other side, since `Provider.resolve` runs
 * outside the pipeline's transactions by design. That would leave a
 * `spankmonster` row in the shared table for every other test and the live
 * smoke test to trip over, with nothing here to clean it up. This test is
 * about the pipeline wiring, not the site cache (that already has its own
 * suite in `tpdb-sites.test.ts`), so a `Map` is the right double.
 */
function memorySiteCache(): TpdbSiteCache {
  const known = new Map<string, string>();
  return {
    find: (shortName) => Promise.resolve(known.get(shortName.toLowerCase()) ?? null),
    remember: (site) => {
      known.set(site.shortName.toLowerCase(), site.providerRef);
      return Promise.resolve();
    },
  };
}

/**
 * A stub `fetch` standing in for theporndb.net's `/scenes` endpoint.
 *
 * Answers every call with the one fixture scene regardless of query shape:
 * the site cache above starts cold every run, so the provider always takes
 * the `q` text-search branch, but the stub does not hardcode that assumption.
 * Anything other than `/scenes` throws, the same "fail loud on a miss"
 * contract `fixtureFetch()` uses for TMDB.
 */
function tpdbFixtureFetch(): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname !== '/scenes') {
      throw new Error(`no TPDB fixture stubbed for ${url.pathname}`);
    }
    return new Response(JSON.stringify({ data: [FIXTURE_SCENE], meta: { total: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return impl as unknown as typeof fetch;
}

/**
 * Provider wiring for one category, the same shape and signature
 * `buildDeps(category)` has: only the provider that category needs, built
 * when it is asked for.
 *
 * `xxx` is served by the TPDB stub above and everything else by the recorded
 * TMDB fixtures, which is what makes a batch mixing categories testable here.
 */
function testDeps(category: Category = 'xxx'): PipelineDeps {
  let pending: ProviderCallRecord[] = [];
  const recordCall = (row: ProviderCallRecord): void => { pending.push(row); };
  const providers = category === 'xxx'
    ? [createTpdbProvider(createTpdbClient({
      token: 'fixture', fetchImpl: tpdbFixtureFetch(), recordCall, ratePerSecond: 1000,
    }), memorySiteCache())]
    : [createTmdbProvider(createTmdbClient({
      token: 'fixture', fetchImpl: fixtureFetch(), recordCall, ratePerSecond: 1000,
    }))];
  return {
    providers,
    now: () => new Date(),
    drainCalls: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

let cachedToken: string | null = null;
async function token(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-xxxlook', 'XxxLook', 'xxxlook@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min)
      VALUES ('u-xxxlook', 'xxxlook', ${minted.tokenHash}, ${minted.prefix}, 10000)`);
  });
  cachedToken = minted.token;
  return minted.token;
}

async function post(body: unknown): Promise<Response> {
  return handleLookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
  }), testDeps);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

/**
 * Removes everything these tests write, media included.
 *
 * The lookup rows were cleaned from the start; the `media`, `scene_details`,
 * `people` and `media_people` rows the fixture scene creates were not, so
 * every run left them behind for the next one and for the admin browser's own
 * tests to count. `scene_details` and `media_people` are `ON DELETE CASCADE`
 * from `media`, so deleting the media row takes them; `people` is referenced
 * rather than owned and needs its own delete. Both are keyed on the
 * `xxxtest-` refs this file invents, so nothing real can match.
 */
async function clean(): Promise<void> {
  for (const prefix of [CLEAN_PREFIX, MIXED_PREFIX]) {
    await getDb().execute(sql`
      DELETE FROM lookup_jobs WHERE lookup_id IN (
        SELECT id FROM lookups WHERE name LIKE ${`${prefix}%`})`);
    await getDb().execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
    await getDb().execute(sql`DELETE FROM parses WHERE normalized_key LIKE ${`${prefix.toLowerCase()}%`}`);
  }
  // Cascades to scene_details and media_people.
  await getDb().execute(sql`
    DELETE FROM media WHERE provider = 'tpdb' AND provider_ref LIKE 'xxxtest-%'`);
  await getDb().execute(sql`
    DELETE FROM people WHERE provider = 'tpdb' AND provider_ref LIKE 'xxxtest-%'`);
}

test('a cold xxx lookup resolves against TPDB end to end', opts, async () => {
  await clean();

  const response = await post({ category: 'xxx', name: NAME });
  assert.equal(response.status, 200);
  const body = await json(response);

  assert.equal(body.state, 'resolved');
  assert.equal(body.cached, false);
  assert.ok(Number(body.confidence) >= 0.75, `confidence ${String(body.confidence)} must clear the floor`);

  const media = body.media as {
    readonly id: string;
    readonly kind: string;
    readonly people: readonly { readonly name: string; readonly role: string }[];
    readonly details: Readonly<Record<string, unknown>>;
  };
  assert.equal(media.kind, 'scene');
  assert.ok(media.people.length >= 2, 'the envelope embeds the scene\'s performers');
  assert.ok(
    media.people.every((p) => p.role === 'performer'),
    'every embedded person on a scene is a performer',
  );
  const names = media.people.map((p) => p.name).sort();
  assert.deepEqual(names, ['Octavia Red', 'Ruby Redbottom']);

  // The envelope flattens `scene_details` camelCase; confirmed against the
  // table itself below too.
  assert.equal(media.details.durationSeconds, 2340);

  // A second, identical lookup must be served from the cache rather than
  // hitting the provider again.
  const second = await json(await post({ category: 'xxx', name: NAME }));
  assert.equal(second.cached, true);
  assert.equal(second.state, 'resolved');
  const secondMedia = second.media as { readonly kind: string };
  assert.equal(secondMedia.kind, 'scene', 'a cache hit must still hydrate the media');

  // `scene_details.duration_seconds` directly, not just through the envelope --
  // the whole point of Task 8's persist wiring.
  const mediaId = media.id;
  const row = await getDb().execute(sql`
    SELECT duration_seconds, site_name FROM scene_details WHERE media_id = ${mediaId}::uuid`);
  assert.equal(Number(row.rows[0]?.duration_seconds), 2340, 'stored in seconds, not minutes');
  assert.equal(row.rows[0]?.site_name, 'Spank Monster');

  await clean();
});

test('a batch mixing categories routes each item to its own provider', opts, async () => {
  // The stated risk of turning `PipelineDeps.provider` into `providers`: one
  // request, two categories, and the provider chosen per item rather than per
  // request. Each category's wiring is built separately here, so an item
  // reaching the wrong one would fail loudly -- the TMDB fixture fetch throws
  // on an unrecorded path and the TPDB stub throws on anything but `/scenes`.
  await clean();

  const response = await post({
    items: [
      { category: 'movies', name: MIXED_MOVIE },
      { category: 'xxx', name: MIXED_SCENE },
    ],
  });
  assert.equal(response.status, 200, 'a batch is always 200; per-item status is inside');
  const results = (await json(response)).results as readonly Record<string, unknown>[];

  assert.equal(results.length, 2);
  assert.equal(results[0]?.state, 'resolved');
  assert.equal(results[1]?.state, 'resolved');
  const movie = results[0]?.media as { readonly kind: string; readonly provider?: string };
  const scene = results[1]?.media as { readonly kind: string };
  assert.equal(movie.kind, 'movie', 'the movies item went to TMDB');
  assert.equal(scene.kind, 'scene', 'the xxx item went to TPDB, in the same request');

  await clean();
});
