import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { signIn, deleteUser as cleanup, setRole } from '../helpers/signIn';
import { GET } from '../../app/api/v1/admin/whoami/route';

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
