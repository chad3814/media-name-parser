import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { consume, pruneRateWindows } from '../../lib/auth/rateLimit';
import { mintApiKey } from '../../lib/auth/apiKey';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

async function seedKey(tx: Tx): Promise<string> {
  const minted = await mintApiKey();
  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('u-rate', 'Rate', 'rate@example.test', false)
    ON CONFLICT (id) DO NOTHING`);
  const row = await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES ('u-rate', 'rate', ${minted.tokenHash}, ${minted.prefix})
    RETURNING id`);
  return String(row.rows[0]?.id);
}

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('the first request is allowed and counted', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const verdict = await consume(tx, apiKeyId, 3);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.used, 1);
    assert.equal(verdict.limit, 3);
  });
});

test('requests are allowed up to the limit and refused after it', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await consume(tx, apiKeyId, 3));
    assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false, false]);
    assert.deepEqual(results.map((r) => r.used), [1, 2, 3, 4, 5]);
  });
});

test('a refusal carries a Retry-After inside the current minute', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    await consume(tx, apiKeyId, 1);
    const refused = await consume(tx, apiKeyId, 1);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60,
      `expected 1..60, got ${refused.retryAfterSeconds}`);
  });
});

test('two different keys do not share a budget', opts, async () => {
  await inRollback(async (tx) => {
    const a = await seedKey(tx);
    const minted = await mintApiKey();
    const rowB = await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES ('u-rate', 'rate-b', ${minted.tokenHash}, ${minted.prefix}) RETURNING id`);
    const b = String(rowB.rows[0]?.id);
    await consume(tx, a, 1);
    const refusedA = await consume(tx, a, 1);
    const allowedB = await consume(tx, b, 1);
    assert.equal(refusedA.allowed, false);
    assert.equal(allowedB.allowed, true, 'key B has its own window');
  });
});

test('a new minute is a new budget', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const noon = new Date('2026-08-27T12:00:30Z');
    const nextMinute = new Date('2026-08-27T12:01:05Z');
    await consume(tx, apiKeyId, 1, noon);
    assert.equal((await consume(tx, apiKeyId, 1, noon)).allowed, false);
    assert.equal((await consume(tx, apiKeyId, 1, nextMinute)).allowed, true);
  });
});

test('a limit of zero refuses everything', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    assert.equal((await consume(tx, apiKeyId, 0)).allowed, false);
  });
});

test('pruning removes old windows and keeps recent ones', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    await consume(tx, apiKeyId, 10, new Date('2026-08-27T09:00:00Z'));
    await consume(tx, apiKeyId, 10, new Date('2026-08-27T12:00:00Z'));
    const before = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.equal(before.rows[0]?.n, 2);
    const removed = await pruneRateWindows(tx, 2);
    assert.ok(removed >= 1, 'the 09:00 window is older than two minutes');
    const after = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.ok(Number(after.rows[0]?.n ?? 0) < 2);
  });
});
