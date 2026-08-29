import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { ensureUser } from '../../lib/auth/users';
import { verifyApiKey } from '../../lib/auth/apiKey';
import { listKeys, createKey, revokeKey } from '../../lib/keys/manage';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

const OWNER = 'keys-owner@example.test';
const OTHER = 'keys-other@example.test';

after(async () => { if (hasDb) await closeDb(); });

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const email of [OWNER, OTHER]) {
    await db.execute(sql`DELETE FROM "user" WHERE email = ${email}`);
  }
}

async function idFor(email: string): Promise<string> {
  return withTransaction(async (tx) => (await ensureUser(tx, email)).id);
}

test('a new user has no keys', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    assert.deepEqual(await withTransaction((tx) => listKeys(tx, id)), []);
  } finally {
    await cleanup();
  }
});

test('createKey returns a working token and a row without the hash', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const made = await withTransaction((tx) => createKey(tx, id, 'laptop'));
    assert.ok(made.token.startsWith('mnp_'), 'the token should carry the greppable marker');
    assert.equal(made.row.label, 'laptop');
    assert.ok(made.row.prefix.length > 0);
    // The row must not carry the secret or its hash in any field.
    const serialised = JSON.stringify(made.row);
    assert.equal(serialised.includes(made.token), false, 'the row echoed the token');
    assert.ok(!('tokenHash' in made.row), 'the row must not expose the hash');

    const caller = await withTransaction((tx) => verifyApiKey(tx, made.token));
    assert.ok(caller !== null, 'the minted token should authenticate');
    assert.equal(caller.userId, id);
  } finally {
    await cleanup();
  }
});

test('listKeys shows only the caller own keys', opts, async () => {
  // Two users, deliberately: a query that forgot `user_id` would pass with one.
  await cleanup();
  try {
    const owner = await idFor(OWNER);
    const other = await idFor(OTHER);
    await withTransaction((tx) => createKey(tx, owner, 'mine'));
    await withTransaction((tx) => createKey(tx, other, 'theirs'));

    const mine = await withTransaction((tx) => listKeys(tx, owner));
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.label, 'mine');
  } finally {
    await cleanup();
  }
});

test('revokeKey stops the token working', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const made = await withTransaction((tx) => createKey(tx, id, 'doomed'));
    assert.ok(await withTransaction((tx) => verifyApiKey(tx, made.token)) !== null);

    assert.equal(await withTransaction((tx) => revokeKey(tx, id, made.row.id)), true);
    assert.equal(await withTransaction((tx) => verifyApiKey(tx, made.token)), null);

    // The row survives as a record, marked revoked.
    const rows = await withTransaction((tx) => listKeys(tx, id));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]?.revokedAt !== null, 'the row should be marked revoked, not deleted');
  } finally {
    await cleanup();
  }
});

test('one user cannot revoke another user key', opts, async () => {
  // The security property of this task, as an assertion.
  await cleanup();
  try {
    const owner = await idFor(OWNER);
    const other = await idFor(OTHER);
    const made = await withTransaction((tx) => createKey(tx, owner, 'mine'));

    assert.equal(await withTransaction((tx) => revokeKey(tx, other, made.row.id)), false);
    // And it still works, which is the part that matters.
    assert.ok(await withTransaction((tx) => verifyApiKey(tx, made.token)) !== null);
  } finally {
    await cleanup();
  }
});

test('revoking twice is not an error the second time', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const made = await withTransaction((tx) => createKey(tx, id, 'twice'));
    assert.equal(await withTransaction((tx) => revokeKey(tx, id, made.row.id)), true);
    // Already revoked: reports false rather than throwing, so a double-click
    // in the UI is not an error page.
    assert.equal(await withTransaction((tx) => revokeKey(tx, id, made.row.id)), false);
  } finally {
    await cleanup();
  }
});

test('revoking an unknown id reports false', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const absent = '00000000-0000-0000-0000-000000000000';
    assert.equal(await withTransaction((tx) => revokeKey(tx, id, absent)), false);
  } finally {
    await cleanup();
  }
});
