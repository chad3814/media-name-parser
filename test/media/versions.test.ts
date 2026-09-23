import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { linkVersions, versionsOf } from '../../lib/media/versions';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => {
  if (hasDb) await closeDb();
});

async function media(tx: Tx, provider: 'tmdb' | 'tvdb'): Promise<string> {
  const r = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('tv','series','A','a', ${provider}::provider, ${`${provider}-${crypto.randomUUID()}`},
            '{}'::jsonb, now())
    RETURNING id`);
  return String(r.rows[0]?.id);
}

test('a pair is written once and found from both sides', opts, async () => {
  await withTransaction(async (tx) => {
    const x = await media(tx, 'tmdb');
    const y = await media(tx, 'tvdb');
    assert.equal(await linkVersions(tx, x, y), true);
    assert.deepEqual(await versionsOf(tx, x), [y]);
    assert.deepEqual(await versionsOf(tx, y), [x], 'visible from the far side too');
  });
});

test('the same pair offered again, in either order, writes nothing', opts, async () => {
  // The resolve path re-offers a link on every stale lookup, so this
  // happens constantly and must be silent rather than an error.
  await withTransaction(async (tx) => {
    const x = await media(tx, 'tmdb');
    const y = await media(tx, 'tvdb');
    assert.equal(await linkVersions(tx, x, y), true);
    assert.equal(await linkVersions(tx, x, y), false);
    assert.equal(await linkVersions(tx, y, x), false, 'order is not a new fact');
    const n = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media_versions WHERE a = ${x}::uuid OR b = ${x}::uuid`);
    assert.equal(n.rows[0]?.n, 1);
  });
});

test('a row is not a version of itself', opts, async () => {
  await withTransaction(async (tx) => {
    const x = await media(tx, 'tmdb');
    assert.equal(await linkVersions(tx, x, x), false, 'no row, and no constraint violation');
    assert.deepEqual(await versionsOf(tx, x), []);
  });
});

test('an unlinked row has no versions', opts, async () => {
  await withTransaction(async (tx) => {
    assert.deepEqual(await versionsOf(tx, await media(tx, 'tmdb')), []);
  });
});
