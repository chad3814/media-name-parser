import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, advisoryLock, closeDb } from '../../lib/db/client';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => {
  if (hasDb) await closeDb();
});

test('a transaction commits and returns its value', opts, async () => {
  const got = await withTransaction(async (tx) => {
    const r = await tx.execute(sql`SELECT 1 AS ok`);
    return r.rows[0];
  });
  assert.deepEqual(got, { ok: 1 });
});

test('a throwing transaction rolls back', opts, async () => {
  await assert.rejects(
    withTransaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO parses (category, normalized_key, tokens, parser_version)
        VALUES ('tv', 'rollback-probe', '{}'::jsonb, 1)`);
      throw new Error('boom');
    }),
    /boom/,
  );
  const rows = await getDb().execute(
    sql`SELECT 1 FROM parses WHERE normalized_key = 'rollback-probe'`,
  );
  assert.equal(rows.rows.length, 0, 'the insert should have been rolled back');
});

test('FOR UPDATE SKIP LOCKED runs inside a transaction', opts, async () => {
  const rows = await withTransaction(async (tx) => {
    const r = await tx.execute(sql`
      SELECT id FROM lookup_jobs WHERE state = 'pending'
      FOR UPDATE SKIP LOCKED LIMIT 5`);
    return r.rows;
  });
  assert.ok(Array.isArray(rows));
});

test('the advisory lock genuinely serializes two transactions', opts, async () => {
  const order: string[] = [];
  const key = 'tv:serialize-probe';
  const holder = withTransaction(async (tx) => {
    await advisoryLock(tx, key);
    order.push('A-acquired');
    await tx.execute(sql`SELECT pg_sleep(0.3)`);
    order.push('A-done');
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const waiter = withTransaction(async (tx) => {
    await advisoryLock(tx, key);
    order.push('B-acquired');
  });
  await Promise.all([holder, waiter]);
  assert.deepEqual(order, ['A-acquired', 'A-done', 'B-acquired']);
});
