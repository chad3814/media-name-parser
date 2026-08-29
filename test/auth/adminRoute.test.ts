import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../lib/db/client';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { signIn, deleteUser as cleanup, setRole } from '../helpers/signIn';
import { GET } from '../../app/api/v1/admin/whoami/route';
import { POST as authPost } from '../../app/api/auth/[...all]/route';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function get(headers: Headers): Promise<Response> {
  return GET(new Request('http://localhost:3000/api/v1/admin/whoami', { headers }));
}

test('an anonymous request gets 401', opts, async () => {
  const response = await get(new Headers());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
});

test('a signed-in non-admin gets 403', opts, async () => {
  const email = 'whoami-plain@example.test';
  await cleanup(email);
  const response = await get(await signIn(email));
  assert.equal(response.status, 403);
  await cleanup(email);
});

test('an admin gets 200 with their identity', opts, async () => {
  const email = 'whoami-admin@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, ADMIN_ROLE);
  const response = await get(headers);
  assert.equal(response.status, 200);
  const body = await response.json() as { email: string; roles: string[]; isAdmin: boolean };
  assert.equal(body.email, email);
  assert.equal(body.isAdmin, true);
  assert.deepEqual(body.roles, [ADMIN_ROLE]);
  await cleanup(email);
});

test('the response never contains a session token', opts, async () => {
  const email = 'whoami-leak@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, ADMIN_ROLE);
  const text = await (await get(headers)).text();
  const cookie = headers.get('cookie') ?? '';
  const token = cookie.slice(cookie.indexOf('=') + 1);
  assert.ok(token.length > 0);
  assert.equal(text.includes(token), false, 'the response echoed the session token');
  await cleanup(email);
});

test('the admin plugin endpoints are not served', async () => {
  // Verified against the configured instance: admin() publishes 15 endpoints
  // under this prefix, including impersonate-user and set-role.
  for (const path of [
    'admin/set-role', 'admin/impersonate-user', 'admin/remove-user',
    'admin/ban-user', 'admin/list-users', 'admin/set-user-password',
  ]) {
    const response = await authPost(new Request(`http://localhost:3000/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    assert.equal(response.status, 404, `${path} must not be served`);
  }
});

test('blocking the admin prefix does not block the routes we do serve', opts, async () => {
  // A prefix check that also refused sign-in would be worse than the problem.
  const email = 'prefix-probe@example.test';
  try {
    const response = await authPost(new Request(
      'http://localhost:3000/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, callbackURL: '/' }),
      }));
    assert.notEqual(response.status, 404);
  } finally {
    await cleanup(email);
    await getDb().execute(sql`DELETE FROM verification WHERE value LIKE ${'%' + email + '%'}`);
  }
});
