import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../lib/db/client';
import { getCurrentUser, requireUser, requireAdmin } from '../../lib/auth/session';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { signIn, deleteUser as cleanup, setRole } from '../helpers/signIn';

const run = promisify(execFile);

/** Sets `banned`/`banExpires` directly, mirroring the admin plugin's ban-user route. */
async function ban(email: string, banExpires: Date | null): Promise<void> {
  await getDb().execute(sql`
    UPDATE "user" SET banned = true, ban_expires = ${banExpires} WHERE email = ${email}`);
}

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

test('no cookie means no current user', opts, async () => {
  assert.equal(await getCurrentUser(new Headers()), null);
});

test('a signed-in user is returned with their email and no admin role', opts, async () => {
  const email = 'sess-plain@example.test';
  await cleanup(email);
  const user = await getCurrentUser(await signIn(email));
  assert.ok(user !== null);
  assert.equal(user.email, email);
  assert.equal(user.isAdmin, false);
  // A magic-link user starts on the column default.
  assert.deepEqual(user.roles, ['user']);
  await cleanup(email);
});

test('requireUser refuses a cookie-less request with 401 and the scheme', opts, async () => {
  const guard = await requireUser(new Headers());
  assert.equal(guard.ok, false);
  if (guard.ok) throw new Error('unreachable');
  assert.equal(guard.response.status, 401);
  assert.equal(guard.response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(guard.response.headers.get('content-type'), 'application/problem+json');
});

test('requireUser admits a signed-in user', opts, async () => {
  const email = 'sess-admit@example.test';
  await cleanup(email);
  const guard = await requireUser(await signIn(email));
  assert.equal(guard.ok, true);
  if (!guard.ok) throw new Error('unreachable');
  assert.equal(guard.user.email, email);
  await cleanup(email);
});

test('requireAdmin refuses a signed-in non-admin with 403, not 401', opts, async () => {
  // 401 would say "authenticate"; they already did. 403 is the truth.
  const email = 'sess-nonadmin@example.test';
  await cleanup(email);
  const guard = await requireAdmin(await signIn(email));
  assert.equal(guard.ok, false);
  if (guard.ok) throw new Error('unreachable');
  assert.equal(guard.response.status, 403);
  await cleanup(email);
});

test('requireAdmin admits an admin', opts, async () => {
  const email = 'sess-admin@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, ADMIN_ROLE);
  const guard = await requireAdmin(headers);
  assert.equal(guard.ok, true);
  if (!guard.ok) throw new Error('unreachable');
  assert.equal(guard.user.isAdmin, true);
  await cleanup(email);
});

test('requireAdmin admits a user with several comma-separated roles', opts, async () => {
  const email = 'sess-multi@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, 'support,admin');
  const guard = await requireAdmin(headers);
  assert.equal(guard.ok, true);
  if (!guard.ok) throw new Error('unreachable');
  assert.deepEqual([...guard.user.roles].sort(), ['admin', 'support']);
  await cleanup(email);
});

test('a role that merely contains the word admin is not admin', opts, async () => {
  const email = 'sess-nearly@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, 'administrator-readonly');
  const guard = await requireAdmin(headers);
  assert.equal(guard.ok, false);
  await cleanup(email);
});

test('a banned user is not returned, even with a live session', opts, async () => {
  const email = 'sess-banned@example.test';
  await cleanup(email);
  try {
    const headers = await signIn(email);
    await ban(email, null);
    assert.equal(await getCurrentUser(headers), null);
  } finally {
    await cleanup(email);
  }
});

test('a banned admin cannot pass requireAdmin', opts, async () => {
  const email = 'sess-banned-admin@example.test';
  await cleanup(email);
  try {
    const headers = await signIn(email);
    await setRole(email, ADMIN_ROLE);
    await ban(email, null);
    const guard = await requireAdmin(headers);
    assert.equal(guard.ok, false);
    if (guard.ok) throw new Error('unreachable');
    // No current user at all, so requireUser's 401, not requireAdmin's 403.
    assert.equal(guard.response.status, 401);
  } finally {
    await cleanup(email);
  }
});

test('a ban whose banExpires is in the past does not apply', opts, async () => {
  const email = 'sess-ban-expired@example.test';
  await cleanup(email);
  try {
    const headers = await signIn(email);
    await ban(email, new Date(Date.now() - 60_000));
    const user = await getCurrentUser(headers);
    assert.ok(user !== null);
    assert.equal(user.email, email);
  } finally {
    await cleanup(email);
  }
});

test('requireAdmin returns 503 when reading the session throws', async () => {
  // Not gated on `opts`/DATABASE_URL: deleting BETTER_AUTH_SECRET makes
  // getAuth() throw before any database call is reached, in a child process
  // so this suite's own environment (which has the secret) is untouched.
  //
  // This pins the precondition the admin layout's third branch depends on --
  // that requireAdmin really does produce a 503 Guard rather than throwing --
  // and nothing more. It does not cover the rendered "Temporarily
  // unavailable" markup: AdminLayout and AdminPage are async Server
  // Components, and `headers()` throws outside a request scope, so even
  // calling them directly here would not reach the branch under test through
  // the real render path.
  const env = { ...process.env };
  delete env.BETTER_AUTH_SECRET;
  const script = [
    "import { requireAdmin } from './lib/auth/session.ts';",
    'const guard = await requireAdmin(new Headers());',
    'const body = guard.ok ? null : await guard.response.json();',
    'process.stdout.write(JSON.stringify({',
    '  ok: guard.ok,',
    '  status: guard.ok ? null : guard.response.status,',
    '  body,',
    '}));',
  ].join('\n');
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', '-e', script],
    { cwd: process.cwd(), env },
  );
  const result = JSON.parse(stdout) as {
    readonly ok: boolean;
    readonly status: number | null;
    readonly body: { readonly title: string; readonly status: number; readonly detail?: string };
  };
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.title, 'Service Unavailable');
  assert.equal(result.body.status, 503);
});
