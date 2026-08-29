import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import {
  mintApiKey, hashToken, parseBearer, verifyApiKey, touchApiKey,
} from '../../lib/auth/apiKey';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

test('parseBearer accepts exactly the shapes it should', () => {
  assert.equal(parseBearer('Bearer abc'), 'abc');
  assert.equal(parseBearer('bearer abc'), 'abc', 'the scheme is case-insensitive');
  assert.equal(parseBearer('Bearer   abc  '), 'abc', 'surrounding space is trimmed');
  assert.equal(parseBearer(null), null);
  assert.equal(parseBearer(''), null);
  assert.equal(parseBearer('abc'), null, 'a bare token is not a bearer header');
  assert.equal(parseBearer('Basic abc'), null, 'only the Bearer scheme');
  assert.equal(parseBearer('Bearer '), null, 'an empty token is not a token');
});

test('a minted token has the documented shape and a matching hash', async () => {
  const minted = await mintApiKey();
  assert.match(minted.token, /^mnp_[0-9a-f]{8}_[0-9a-f]{48}$/);
  assert.equal(minted.prefix.length, 8);
  assert.ok(minted.token.includes(minted.prefix), 'the prefix must be readable from the token');
  assert.equal(minted.tokenHash, await hashToken(minted.token));
  assert.match(minted.tokenHash, /^[0-9a-f]{64}$/, 'sha-256 hex');
});

test('two minted tokens differ', async () => {
  const a = await mintApiKey();
  const b = await mintApiKey();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.tokenHash, b.tokenHash);
});

test('hashing is stable and sensitive to a single character', async () => {
  assert.equal(await hashToken('mnp_x_y'), await hashToken('mnp_x_y'));
  assert.notEqual(await hashToken('mnp_x_y'), await hashToken('mnp_x_z'));
});

/** Creates a user and a key inside a transaction the caller will roll back. */
async function seed(tx: Tx, over: {
  readonly revoked?: boolean;
  readonly limit?: number;
  readonly banned?: boolean;
  readonly banExpires?: Date | null;
} = {}) {
  const minted = await mintApiKey();
  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified, banned, ban_expires)
    VALUES ('u-probe', 'Probe', 'probe@example.test', false,
            ${over.banned === true}, ${over.banExpires ?? null})
    ON CONFLICT (id) DO NOTHING`);
  const row = await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min, revoked_at)
    VALUES ('u-probe', 'probe', ${minted.tokenHash}, ${minted.prefix},
            ${over.limit ?? 60}, ${over.revoked === true ? sql`now()` : sql`NULL`})
    RETURNING id`);
  return { minted, apiKeyId: String(row.rows[0]?.id) };
}

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('a valid token resolves to its caller', opts, async () => {
  await inRollback(async (tx) => {
    const { minted, apiKeyId } = await seed(tx, { limit: 42 });
    const caller = await verifyApiKey(tx, minted.token);
    assert.ok(caller !== null);
    assert.equal(caller.apiKeyId, apiKeyId);
    assert.equal(caller.userId, 'u-probe');
    assert.equal(caller.rateLimitPerMin, 42);
  });
});

test('an unknown token resolves to null', opts, async () => {
  await inRollback(async (tx) => {
    await seed(tx);
    assert.equal(await verifyApiKey(tx, 'mnp_00000000_deadbeef'), null);
  });
});

test('a revoked token resolves to null even though its hash still matches', opts, async () => {
  await inRollback(async (tx) => {
    const { minted } = await seed(tx, { revoked: true });
    assert.equal(await verifyApiKey(tx, minted.token), null);
  });
});

test('touchApiKey records last_used_at without changing anything else', opts, async () => {
  await inRollback(async (tx) => {
    const { minted, apiKeyId } = await seed(tx);
    await touchApiKey(tx, apiKeyId);
    const row = await tx.execute(sql`
      SELECT last_used_at, revoked_at, rate_limit_per_min FROM api_keys WHERE id = ${apiKeyId}::uuid`);
    assert.ok(row.rows[0]?.last_used_at !== null, 'last_used_at should be set');
    assert.equal(row.rows[0]?.revoked_at, null);
    assert.equal(row.rows[0]?.rate_limit_per_min, 60);
    // And the key still verifies afterwards.
    assert.ok(await verifyApiKey(tx, minted.token) !== null);
  });
});

test('a key belonging to a banned user does not authenticate', opts, async () => {
  await inRollback(async (tx) => {
    const { minted } = await seed(tx, { banned: true, banExpires: null });
    assert.equal(await verifyApiKey(tx, minted.token), null);
  });
});

test('a key whose owner\'s ban has expired still authenticates', opts, async () => {
  await inRollback(async (tx) => {
    const { minted } = await seed(tx, { banned: true, banExpires: new Date(Date.now() - 60_000) });
    assert.ok(await verifyApiKey(tx, minted.token) !== null, 'an expired ban must not apply');
  });
});

test('an unbanned owner is unaffected by the join', opts, async () => {
  await inRollback(async (tx) => {
    const { minted } = await seed(tx, { banned: false });
    assert.ok(await verifyApiKey(tx, minted.token) !== null);
  });
});
