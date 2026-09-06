import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { GET as health } from '../../app/api/v1/health/route';
import { GET as media } from '../../app/api/v1/media/[id]/route';
import { mintApiKey } from '../../lib/auth/apiKey';
import { persistResolved } from '../../lib/resolve/persist';
import type { ResolvedMedia } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const MOVIE: ResolvedMedia = {
  category: 'movies', kind: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:r9',
  title: 'Route Film', sortTitle: 'route film', originalTitle: null,
  releaseDate: '2001-01-01', year: 2001, overview: null, raw: {}, people: [], parent: null, externalIds: [],
  details: { movie: { runtimeMinutes: 90, imdbId: 'tt9', tagline: null, collectionName: null }, series: null, season: null, episode: null, scene: null },
};

/** A key that really exists, plus a request carrying it. */
async function withKey(): Promise<string> {
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-route', 'Route', 'route@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES ('u-route', 'route', ${minted.tokenHash}, ${minted.prefix})`);
  });
  return minted.token;
}

function request(token: string | null, url = 'https://x.test/api/v1/media/1'): Request {
  return new Request(url, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

test('health reports ok and the migration count without needing a key', opts, async () => {
  const response = await health();
  assert.equal(response.status, 200);
  const parsed: unknown = await response.json();
  const body = parsed as { readonly status: string; readonly migrations: number };
  assert.equal(body.status, 'ok');
  assert.ok(body.migrations >= 1, 'at least one migration should be applied');
});

test('media without a bearer token is 401 and advertises the scheme', opts, async () => {
  const response = await media(request(null), { params: Promise.resolve({ id: 'x' }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
});

test('media with an unknown token is 401', opts, async () => {
  const response = await media(request('mnp_00000000_nope'), { params: Promise.resolve({ id: 'x' }) });
  assert.equal(response.status, 401);
});

test('media with a malformed uuid is 400, not a database error', opts, async () => {
  const token = await withKey();
  const response = await media(request(token), { params: Promise.resolve({ id: 'not-a-uuid' }) });
  assert.equal(response.status, 400);
});

test('media with an unknown but well-formed id is 404', opts, async () => {
  const token = await withKey();
  const response = await media(request(token), {
    params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }),
  });
  assert.equal(response.status, 404);
});

test('media returns the hydrated record for a real id', opts, async () => {
  const token = await withKey();
  const id = await withTransaction(async (tx) => persistResolved(tx, MOVIE));
  const response = await media(request(token), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  const parsed: unknown = await response.json();
  const body = parsed as { readonly media: { readonly title: string; readonly providerRef: string } };
  assert.equal(body.media.title, 'Route Film');
  assert.equal(body.media.providerRef, 'tmdb:movie:r9');
  await getDb().execute(sql`DELETE FROM media WHERE provider_ref = 'tmdb:movie:r9'`);
});
