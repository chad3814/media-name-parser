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

test('retryAfterSeconds reflects time remaining in the window', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);

    // At :30 seconds, exactly 30 seconds remain in the minute
    const at30 = new Date('2026-08-27T12:00:30Z');
    const refusal30 = await consume(tx, apiKeyId, 0, at30);
    assert.equal(refusal30.retryAfterSeconds, 30, 'at :30, 30 seconds remain');

    // At :00 seconds (start of minute), exactly 60 seconds remain
    const at00 = new Date('2026-08-27T12:01:00Z');
    const refusal00 = await consume(tx, apiKeyId, 0, at00);
    assert.equal(refusal00.retryAfterSeconds, 60, 'at :00, 60 seconds remain');

    // At :59 seconds, exactly 1 second remains
    const at59 = new Date('2026-08-27T12:02:59Z');
    const refusal59 = await consume(tx, apiKeyId, 0, at59);
    assert.equal(refusal59.retryAfterSeconds, 1, 'at :59, 1 second remains');
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
    const now = new Date();

    // Create windows relative to now: one older than keepWindows, one recent
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);
    const oneMinuteAgo = new Date(now.getTime() - 1 * 60 * 1000);

    // Seed both windows
    await consume(tx, apiKeyId, 10, threeMinutesAgo);
    await consume(tx, apiKeyId, 10, oneMinuteAgo);

    // Verify both are present before pruning
    const before = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.equal(before.rows[0]?.n, 2);

    // Prune keeping last 2 minutes (should remove the 3-minute-old window)
    const removed = await pruneRateWindows(tx, 2);
    assert.ok(removed >= 1, 'the 3-minute-old window should be removed');

    // Verify the recent window still exists and old one is gone
    const after = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.equal(after.rows[0]?.n, 1, 'the recent window should still be present');
  });
});

test('the default retention is the two windows the spec asks for', opts, async () => {
  // The cron calls `pruneRateWindows(tx)` with no argument, so the default is
  // the number that actually runs in production. It was 5 while the spec said
  // "older than two windows"; `consume` never reads past the current minute,
  // so the extra three were rows kept for nobody.
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const now = new Date();
    await consume(tx, apiKeyId, 10, new Date(now.getTime() - 3 * 60 * 1000));
    await consume(tx, apiKeyId, 10, now);
    const removed = await pruneRateWindows(tx);
    assert.ok(removed >= 1, 'a three-minute-old window is outside a two-window retention');
    const left = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.equal(left.rows[0]?.n, 1, 'the window in progress survives');
  });
});
