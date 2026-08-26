import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { resolveLookup } from '../../lib/resolve/pipeline';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { fixtureFetch } from '../support/tmdb-fixtures';
import type { ProviderCallRecord } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function tmdb(count?: { n: number }) {
  let pending: ProviderCallRecord[] = [];
  const client = createTmdbClient({
    token: 'fixture',
    fetchImpl: fixtureFetch(),
    recordCall: (row) => {
      pending.push(row);
      if (count !== undefined) count.n += 1;
    },
    ratePerSecond: 1000,
  });
  return {
    provider: createTmdbProvider(client),
    drainCalls: (): readonly ProviderCallRecord[] => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

const deps = (t: ReturnType<typeof tmdb>) => ({
  provider: t.provider,
  now: () => new Date(),
  drainCalls: t.drainCalls,
});

async function cleanup(prefix: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
    await tx.execute(sql`DELETE FROM parses WHERE normalized_key LIKE ${`${prefix.toLowerCase()}%`}`);
  });
}

test('a cold movie lookup resolves and stores a media id', opts, async () => {
  const name = 'ptesta/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  await cleanup('ptesta');
  const calls = { n: 0 };
  const got = await resolveLookup({ category: 'movies', name }, deps(tmdb(calls)));
  assert.equal(got.state, 'resolved', `refusal: ${got.refusal ?? 'none'}`);
  assert.equal(got.cached, false);
  assert.ok(got.mediaId !== null);
  assert.ok((got.confidence ?? 0) >= 0.75, `confidence ${got.confidence}`);
  assert.equal(got.parsed?.title, 'Outbreak');
  assert.ok(calls.n > 0, 'a cold lookup must call the provider');
  await cleanup('ptesta');
});

test('the same lookup twice makes no second provider call', opts, async () => {
  const name = 'ptestb/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  await cleanup('ptestb');
  await resolveLookup({ category: 'movies', name }, deps(tmdb()));
  const calls = { n: 0 };
  const second = await resolveLookup({ category: 'movies', name }, deps(tmdb(calls)));
  assert.equal(second.state, 'resolved');
  assert.equal(second.cached, true);
  assert.equal(calls.n, 0, 'a cache hit must not touch the provider');
  await cleanup('ptestb');
});

test('a differently spelled name adopts the sibling without calling out', opts, async () => {
  await cleanup('ptestc');
  await resolveLookup(
    { category: 'movies', name: 'ptestc/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb' },
    deps(tmdb()),
  );
  const calls = { n: 0 };
  const second = await resolveLookup(
    { category: 'movies', name: 'ptestc/Outbreak 1995 1080p BluRay REMUX AVC DTS-HD-MA 5 1-UnKn0wn.nzb' },
    deps(tmdb(calls)),
  );
  assert.equal(second.state, 'resolved');
  assert.equal(calls.n, 0, 'sibling adoption must skip the provider');
  await cleanup('ptestc');
});

test('a refused name is unresolved with a refusal and no provider call', opts, async () => {
  await cleanup('ptestd');
  const calls = { n: 0 };
  const got = await resolveLookup(
    { category: 'tv', name: 'ptestd/Moon Knight/.plexmatch' }, deps(tmdb(calls)),
  );
  assert.equal(got.state, 'unresolved');
  assert.match(got.refusal ?? '', /not a media file/);
  assert.equal(got.parsed, null);
  assert.equal(calls.n, 0);
  await cleanup('ptestd');
});

test('a name with no provider match is unresolved but keeps its parse', opts, async () => {
  await cleanup('pteste');
  const got = await resolveLookup(
    { category: 'tv', name: 'pteste/Nonexistent.Show.That.Should.Return.Nothing.99999.S01E01.1080p.WEB-DL-GRP.nzb' },
    deps(tmdb()),
  );
  assert.equal(got.state, 'unresolved');
  assert.equal(got.mediaId, null);
  assert.ok(got.parsed !== null, 'the tokens alone are a useful answer');
  await cleanup('pteste');
});

test('an unresolved row inside the cooling window is not retried', opts, async () => {
  const name = 'ptestf/Nonexistent.Show.That.Should.Return.Nothing.99999.S01E01.1080p.WEB-DL-GRP.nzb';
  await cleanup('ptestf');
  await resolveLookup({ category: 'tv', name }, deps(tmdb()));
  const calls = { n: 0 };
  const second = await resolveLookup({ category: 'tv', name }, deps(tmdb(calls)));
  assert.equal(second.state, 'unresolved');
  assert.equal(calls.n, 0, 'the 12-hour rule must suppress the retry');
  await cleanup('ptestf');
});

test('an episode stores its season and series too', opts, async () => {
  const name = 'ptestg/Moon Knight/Season 1/Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux.mkv';
  await cleanup('ptestg');
  const got = await resolveLookup({ category: 'tv', name }, deps(tmdb()));
  assert.equal(got.state, 'resolved', `confidence ${got.confidence}`);
  const rows = await getDb().execute(sql`
    SELECT kind FROM media WHERE provider_ref LIKE 'tmdb:tv:92749%'`);
  const kinds = new Set(rows.rows.map((r) => String(r.kind)));
  assert.ok(kinds.has('series'), 'the series should be stored');
  assert.ok(kinds.has('season'), 'the season should be stored');
  assert.ok(kinds.has('episode'), 'the episode should be stored');
  await cleanup('ptestg');
});

test('provider calls are recorded, not silently dropped', opts, async () => {
  const name = 'ptesti/Interstellar.2014.1080p.BluRay.x264-GRP.nzb';
  await cleanup('ptesti');
  const before = await getDb().execute(sql`SELECT count(*)::int AS n FROM provider_calls`);
  await resolveLookup({ category: 'movies', name }, deps(tmdb()));
  const after = await getDb().execute(sql`SELECT count(*)::int AS n FROM provider_calls`);
  assert.ok(
    Number(after.rows[0]?.n ?? 0) > Number(before.rows[0]?.n ?? 0),
    'provider_calls must gain rows; if not, drainCalls is not wired up',
  );
  await cleanup('ptesti');
});

/**
 * A provider that never answers until the signal says stop.
 *
 * A fixture-backed provider is far too fast to blow a deadline -- the files are
 * already on disk -- so testing the deadline against it would only prove that
 * `setTimeout` loses a race. This stub is the deadline's actual subject.
 */
function hangingProvider() {
  return {
    provider: {
      name: 'tmdb' as const,
      supports: (): boolean => true,
      resolve: (_parsed: unknown, ctx: { readonly signal: AbortSignal }): Promise<never> =>
        new Promise((_resolve, reject) => {
          if (ctx.signal.aborted) { reject(new Error('aborted')); return; }
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    },
    drainCalls: (): readonly ProviderCallRecord[] => [],
  };
}

test('a blown deadline returns partial with the parse intact', opts, async () => {
  const name = 'ptesth/Interstellar.2014.1080p.BluRay.x264-GRP.nzb';
  await cleanup('ptesth');
  const got = await resolveLookup(
    { category: 'movies', name },
    deps(hangingProvider() as unknown as ReturnType<typeof tmdb>),
    { deadlineMs: 60 },
  );
  assert.equal(got.partial, true);
  assert.equal(got.state, 'pending');
  assert.ok(got.parsed !== null, 'the parse survives a blown deadline');
  assert.equal(got.mediaId, null);
  await cleanup('ptesth');
});

test('a caller signal that is already aborted is honoured, not ignored', opts, async () => {
  const name = 'ptestj/Interstellar.2014.1080p.BluRay.x264-GRP.nzb';
  await cleanup('ptestj');
  const controller = new AbortController();
  controller.abort();
  const got = await resolveLookup(
    { category: 'movies', name },
    deps(hangingProvider() as unknown as ReturnType<typeof tmdb>),
    { deadlineMs: 30_000, signal: controller.signal },
  );
  // Without the pre-check in the pipeline this hangs until the 30s deadline,
  // because an already-aborted signal emits no further abort event.
  assert.equal(got.partial, true);
  assert.equal(got.state, 'pending');
  await cleanup('ptestj');
});
