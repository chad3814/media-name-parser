import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { findSiteId, rememberSite } from '../../lib/providers/tpdb/sites';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/** Every assertion runs inside a transaction that is then rolled back. */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('a miss returns null', opts, async () => {
  await inRollback(async (tx) => {
    const id = await findSiteId(tx, 'nosuchsite');
    assert.equal(id, null);
  });
});

test('a remembered site is found by its short name', opts, async () => {
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster' });
    const id = await findSiteId(tx, 'spankmonster');
    assert.equal(id, '42');
  });
});

test('lookup is case-insensitive: the filename spelling finds the API spelling', opts, async () => {
  await inRollback(async (tx) => {
    // The API gives the short name lowercased; the filename head is mixed case.
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster' });
    const id = await findSiteId(tx, 'SpankMonster');
    assert.equal(id, '42');
  });
});

test('rememberSite is idempotent: calling it twice does not throw and leaves one row', opts, async () => {
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster' });
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster' });
    const count = await tx.execute(sql`
      SELECT count(*)::int AS n FROM provider_sites WHERE provider = 'tpdb' AND provider_ref = '42'`);
    assert.equal(count.rows[0]?.n, 1);
  });
});

test('remembering the same site again updates its name rather than duplicating', opts, async () => {
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster' });
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster Renamed' });
    const rows = await tx.execute(sql`
      SELECT name FROM provider_sites WHERE provider = 'tpdb' AND provider_ref = '42'`);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.name, 'SpankMonster Renamed');
  });
});

test('a short name reused by a different id replaces, rather than raising', opts, async () => {
  // This test previously asserted the opposite -- that the unique constraint
  // rejects the second write. Overridden deliberately.
  //
  // `rememberSite` runs inside the resolution's own transaction on every
  // successful resolve. A throw here does not decline a cache write; it fails
  // the entire lookup, so a caller would get no metadata because a *cache*
  // hit a constraint. A cache must not take down the thing it caches.
  //
  // Rejecting is also permanently wrong if a short name genuinely moves to a
  // new site id upstream: the table would keep the stale id and raise on
  // every subsequent resolution for that site, forever.
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '42', shortName: 'reusedname', name: 'First Site' });
    await rememberSite(tx, { providerRef: '43', shortName: 'reusedname', name: 'Second Site' });
    assert.equal(await findSiteId(tx, 'reusedname'), '43');
    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n FROM provider_sites WHERE short_name = 'reusedname'`);
    assert.equal(rows.rows[0]?.n, 1);
  });
});

test('a short name that moves to a different site id replaces the old row', async () => {
  // The second unique constraint. `ON CONFLICT` can name only one, and naming
  // the primary key alone meant this case raised instead of upserting --
  // which, since rememberSite runs on every successful resolution, would have
  // failed the whole lookup rather than just declining to cache.
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '4347', shortName: 'movedsite', name: 'Moved Site' });
    await rememberSite(tx, { providerRef: '9999', shortName: 'movedsite', name: 'Moved Site' });
    const found = await findSiteId(tx, 'MovedSite');
    assert.equal(found, '9999', 'the newest id for a short name wins');
    const rows = await tx.execute(sql`
      SELECT count(*)::int AS n FROM provider_sites WHERE short_name = 'movedsite'`);
    assert.equal(rows.rows[0]?.n, 1, 'exactly one row survives per short name');
  });
});

test('a site whose parsed spelling carries punctuation still meets the API spelling', opts, async () => {
  // A real corpus name parses to the site `Passion-HD`, and the many heads
  // that span several tokens parse with spaces in them (`Naughty America`).
  // The API stores bare alphanumerics. Reads and writes both normalize, so
  // the column holds one spelling and every parsed variant finds it.
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '4348', shortName: 'Passion HD', name: 'Passion HD' });
    const stored = await tx.execute(sql`
      SELECT short_name FROM provider_sites WHERE provider = 'tpdb' AND provider_ref = '4348'`);
    assert.equal(stored.rows[0]?.short_name, 'passionhd', 'the column holds the API spelling');
    assert.equal(await findSiteId(tx, 'Passion-HD'), '4348', 'the filename spelling finds it');
    assert.equal(await findSiteId(tx, 'Passion HD'), '4348', 'so does the parsed spelling');
    assert.equal(await findSiteId(tx, 'passionhd'), '4348', 'so does the API spelling itself');
  });
});
