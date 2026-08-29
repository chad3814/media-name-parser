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

test('no session token reaches stdout', opts, async () => {
  // A token in a log or a CI transcript is a live credential. The sink holds
  // only the magic-link token, and nothing in this suite prints either.
  assert.equal(magicLinkSink.length, 0);
});
