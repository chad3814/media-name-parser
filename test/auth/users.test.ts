import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { ensureUser, findUserIdByEmail, setUserRole } from '../../lib/auth/users';
import { ADMIN_ROLE, hasRole, withRole, withoutRole } from '../../lib/auth/roles';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

async function cleanup(email: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM "user" WHERE email = ${email}`);
}

async function readRole(email: string): Promise<string | null> {
  const result = await getDb().execute(sql`SELECT role FROM "user" WHERE email = ${email}`);
  const row = result.rows[0];
  return row === undefined ? null : String(row.role);
}

test('findUserIdByEmail returns null for an unknown address', opts, async () => {
  const id = await withTransaction((tx) => findUserIdByEmail(tx, 'nobody-here@example.test'));
  assert.equal(id, null);
});

test('ensureUser creates a user with a generated id and reports it', opts, async () => {
  const email = 'users-create@example.test';
  await cleanup(email);
  const result = await withTransaction((tx) => ensureUser(tx, email));
  assert.equal(result.created, true);
  // Not the old hardcoded placeholder, and long enough to be a real uuid.
  assert.notEqual(result.id, 'local-dev');
  assert.ok(result.id.length >= 32, `id looks wrong: ${result.id.length} chars`);
  assert.equal(await readRole(email), 'user');
  await cleanup(email);
});

test('ensureUser is idempotent and returns the same id', opts, async () => {
  const email = 'users-idempotent@example.test';
  await cleanup(email);
  const first = await withTransaction((tx) => ensureUser(tx, email));
  const second = await withTransaction((tx) => ensureUser(tx, email));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  await cleanup(email);
});

test('ensureUser derives a name from the address when none is given', opts, async () => {
  const email = 'users-named@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email));
  const result = await getDb().execute(sql`SELECT name FROM "user" WHERE email = ${email}`);
  assert.equal(String(result.rows[0]?.name), 'users-named');
  await cleanup(email);
});

test('ensureUser does not overwrite the name of an existing user', opts, async () => {
  const email = 'users-keepname@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email, 'Original Name'));
  await withTransaction((tx) => ensureUser(tx, email, 'Replacement'));
  const result = await getDb().execute(sql`SELECT name FROM "user" WHERE email = ${email}`);
  assert.equal(String(result.rows[0]?.name), 'Original Name');
  await cleanup(email);
});

test('findUserIdByEmail finds a created user', opts, async () => {
  const email = 'users-find@example.test';
  await cleanup(email);
  const created = await withTransaction((tx) => ensureUser(tx, email));
  const found = await withTransaction((tx) => findUserIdByEmail(tx, email));
  assert.equal(found, created.id);
  await cleanup(email);
});

test('setUserRole writes the role and reports success', opts, async () => {
  const email = 'users-role@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email));
  const ok = await withTransaction((tx) => setUserRole(tx, email, withRole('user', ADMIN_ROLE)));
  assert.equal(ok, true);
  const role = await readRole(email);
  assert.equal(hasRole(role, ADMIN_ROLE), true);
  // The existing role survived: this is the strip-a-role bug, as an assertion.
  assert.equal(hasRole(role, 'user'), true);
  await cleanup(email);
});

test('setUserRole can take the admin role away again', opts, async () => {
  const email = 'users-demote@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email));
  await withTransaction((tx) => setUserRole(tx, email, 'support,admin'));
  await withTransaction(async (tx) => {
    const role = await readRole(email);
    return setUserRole(tx, email, withoutRole(role, ADMIN_ROLE));
  });
  assert.equal(await readRole(email), 'support');
  await cleanup(email);
});

test('setUserRole reports failure for an unknown address', opts, async () => {
  const ok = await withTransaction((tx) => setUserRole(tx, 'nobody-here@example.test', 'admin'));
  assert.equal(ok, false);
});
