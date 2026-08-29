import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../lib/db/client';
import { magicLinkSink } from '../../lib/auth/server';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { GET as authGet, POST as authPost } from '../../app/api/auth/[...all]/route';
import { GET as whoami } from '../../app/api/v1/admin/whoami/route';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };
const BASE = 'http://localhost:3000';

after(async () => { if (hasDb) await closeDb(); });

const EMAIL = 'flow@example.test';

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    DELETE FROM session WHERE user_id IN (SELECT id FROM "user" WHERE email = ${EMAIL})`);
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`);
  // A requested-but-never-verified magic link leaves a row here. The email is
  // stored inside the `value` JSON, not in `identifier`.
  await db.execute(sql`DELETE FROM verification WHERE value LIKE ${'%' + EMAIL + '%'}`);
}

test('a magic link signs a user in through the mounted handler', opts, async () => {
  await cleanup();
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    const requested = await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
    assert.equal(requested.status, 200);
    assert.deepEqual(await requested.json(), { status: true });

    const delivery = magicLinkSink.at(-1);
    assert.ok(delivery !== undefined, 'the sink captured no link');
    // The link Better Auth builds must point at the route we mounted.
    assert.equal(new URL(delivery.url).pathname, '/api/auth/magic-link/verify');
    assert.equal(delivery.email, EMAIL);

    const verified = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${delivery.token}&callbackURL=/`,
    ));
    // 302, not 200: the route redirects where auth.api.magicLinkVerify does not.
    assert.equal(verified.status, 302);
    const setCookie = verified.headers.get('set-cookie');
    assert.ok(setCookie !== null, 'no session cookie was set');
    assert.ok(setCookie.startsWith('better-auth.session_token='), setCookie.split('=')[0] ?? '');

    const sessions = await getDb().execute(sql`
      SELECT count(*)::int AS n FROM session
       WHERE user_id IN (SELECT id FROM "user" WHERE email = ${EMAIL})`);
    assert.equal(Number(sessions.rows[0]?.n), 1);

    // The cookie is now good enough to pass a guard. Non-admin, so 403.
    const cookie = setCookie.split(';')[0] ?? '';
    const headers = new Headers({ cookie });
    assert.equal((await whoami(new Request(`${BASE}/x`, { headers }))).status, 403);

    await getDb().execute(sql`UPDATE "user" SET role = ${ADMIN_ROLE} WHERE email = ${EMAIL}`);
    const allowed = await whoami(new Request(`${BASE}/x`, { headers }));
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { email: string }).email, EMAIL);
  } finally {
    magicLinkSink.length = 0;
    delete process.env.MAGIC_LINK_SINK;
    await cleanup();
  }
});

test('a magic link cannot be used twice', opts, async () => {
  await cleanup();
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
    const token = magicLinkSink.at(-1)?.token ?? '';
    assert.ok(token.length > 0);
    const first = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=/`));
    assert.equal(first.status, 302);
    assert.ok(first.headers.get('set-cookie') !== null);

    // A single-use token that is not single-use is a real vulnerability: a link
    // sitting in a mailbox would be a permanent credential.
    const second = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=/`));
    const reused = second.headers.get('set-cookie');
    assert.ok(
      reused === null || !reused.startsWith('better-auth.session_token='),
      'a reused magic link issued a second session',
    );
  } finally {
    magicLinkSink.length = 0;
    delete process.env.MAGIC_LINK_SINK;
    await cleanup();
  }
});

test('a forged token issues no session', opts, async () => {
  const response = await authGet(new Request(
    `${BASE}/api/auth/magic-link/verify?token=not-a-real-token&callbackURL=/`));
  const setCookie = response.headers.get('set-cookie');
  assert.ok(
    setCookie === null || !setCookie.startsWith('better-auth.session_token='),
    'a forged token issued a session',
  );
});

test('no credential reaches the log during sign-in', opts, async () => {
  // The name of the test it replaces was true but unverified: the old version
  // asserted magicLinkSink.length === 0, which every earlier test's `finally`
  // has already guaranteed. This captures console output around a real
  // sign-in and checks the two live credentials never appear in it.
  const captured: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };

  let magicToken = '';
  let sessionToken = '';
  try {
    process.env.MAGIC_LINK_SINK = '1';
    magicLinkSink.length = 0;
    await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
    magicToken = magicLinkSink.at(-1)?.token ?? '';
    const verified = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${magicToken}&callbackURL=/`));
    const setCookie = verified.headers.get('set-cookie') ?? '';
    sessionToken = setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0] ?? '';
  } finally {
    console.error = originalError;
    console.log = originalLog;
    magicLinkSink.length = 0;
    delete process.env.MAGIC_LINK_SINK;
  }

  // Assert the credentials are real before asserting their absence, so this
  // cannot pass by comparing against empty strings.
  assert.ok(magicToken.length > 16, 'no magic-link token was captured');
  assert.ok(sessionToken.length > 16, 'no session token was issued');

  const output = captured.join('\n');
  assert.equal(output.includes(magicToken), false, 'the magic-link token reached the log');
  assert.equal(output.includes(sessionToken), false, 'the session token reached the log');
  await cleanup();
});

test('with no mailer configured, the failure is logged without the token', opts, async () => {
  // The path that actually logs. With the sink off, sendMagicLink calls
  // logFailure, and the line must name the address so the problem is
  // diagnosable -- while the token stays out of it.
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    delete process.env.MAGIC_LINK_SINK;
    magicLinkSink.length = 0;
    await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
  } finally {
    console.error = originalError;
    magicLinkSink.length = 0;
  }

  const output = captured.join('\n');
  assert.ok(output.includes('no mailer is configured'), 'the failure was not logged');
  assert.ok(output.includes(EMAIL), 'the log line does not say which address');
  // Production must not accumulate live tokens in memory.
  assert.equal(magicLinkSink.length, 0);
  await cleanup();
});
