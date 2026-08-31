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

test('the unique constraint on (provider, short_name) rejects a second provider_ref reusing it', opts, async () => {
  await inRollback(async (tx) => {
    await rememberSite(tx, { providerRef: '42', shortName: 'spankmonster', name: 'SpankMonster' });
    await assert.rejects(
      rememberSite(tx, { providerRef: '43', shortName: 'spankmonster', name: 'Different Site' }),
    );
  });
});
