import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { handleLookup } from '../../lib/http/lookupHandler';
import { createTpdbClient } from '../../lib/providers/tpdb/client';
import { createTpdbProvider } from '../../lib/providers/tpdb/resolve';
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
 * A stub `fetch` standing in for theporndb.net's `/scenes` endpoint.
 *
 * Answers every call with the one fixture scene regardless of query shape --
 * `site_id`+`date` if the site cache happens to already be warm from a prior
 * run of this suite (or the live smoke test), `q` if it is cold -- so the
 * test is not coupled to which branch the provider takes. Anything other
 * than `/scenes` throws, the same "fail loud on a miss" contract
 * `fixtureFetch()` uses for TMDB.
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

/** Provider wiring backed by the stub above, the same shape `buildDeps()` builds. */
function testDeps(): PipelineDeps {
  let pending: ProviderCallRecord[] = [];
  const client = createTpdbClient({
    token: 'fixture',
    fetchImpl: tpdbFixtureFetch(),
    recordCall: (row) => { pending.push(row); },
    ratePerSecond: 1000,
  });
  return {
    providers: [createTpdbProvider(client)],
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
  }), () => testDeps());
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

async function clean(): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM lookup_jobs WHERE lookup_id IN (
      SELECT id FROM lookups WHERE name LIKE ${`${CLEAN_PREFIX}%`})`);
  await getDb().execute(sql`DELETE FROM lookups WHERE name LIKE ${`${CLEAN_PREFIX}%`}`);
  await getDb().execute(sql`DELETE FROM parses WHERE normalized_key LIKE ${`${CLEAN_PREFIX.toLowerCase()}%`}`);
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
