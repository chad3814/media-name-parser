import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { GET as listRoute, POST as createRoute } from '../../app/api/keys/route';
import { DELETE as revokeRoute } from '../../app/api/keys/[id]/route';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

const A = 'keysroute-a@example.test';
const B = 'keysroute-b@example.test';

after(async () => { if (hasDb) await closeDb(); });

async function cleanup(): Promise<void> {
  for (const email of [A, B]) await deleteUser(email);
}

function post(headers: Headers, label: string): Request {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return new Request('http://localhost:3000/api/keys', {
    method: 'POST', headers: h, body: JSON.stringify({ label }),
  });
}

test('an anonymous request cannot list or create keys', opts, async () => {
  const listed = await listRoute(new Request('http://localhost:3000/api/keys'));
  assert.equal(listed.status, 401);
  const created = await createRoute(post(new Headers(), 'nope'));
  assert.equal(created.status, 401);
});

test('creating a key returns the secret exactly once', opts, async () => {
  await cleanup();
  try {
    const headers = await signIn(A);
    const created = await createRoute(post(headers, 'laptop'));
    assert.equal(created.status, 201);
    const payload = await created.json() as { token: string; key: { id: string; prefix: string } };
    assert.ok(payload.token.startsWith('mnp_'));

    // The list must never carry it again, nor the hash.
    const listed = await listRoute(new Request('http://localhost:3000/api/keys', { headers }));
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.equal(text.includes(payload.token), false, 'the list echoed the secret');
    assert.equal(text.toLowerCase().includes('token_hash'), false);
    assert.equal(text.toLowerCase().includes('tokenhash'), false);
    assert.ok(text.includes(payload.key.prefix), 'the list should name the key by prefix');
  } finally {
    await cleanup();
  }
});

test('a label is required', opts, async () => {
  await cleanup();
  try {
    const headers = new Headers(await signIn(A));
    headers.set('content-type', 'application/json');
    const response = await createRoute(new Request('http://localhost:3000/api/keys', {
      method: 'POST', headers, body: JSON.stringify({}),
    }));
    assert.equal(response.status, 400);
  } finally {
    await cleanup();
  }
});

test('creating a key requires an application/json content type', opts, async () => {
  // The safety of trusting the body at all rests on this rather than on
  // SameSite=Lax alone -- that mitigates the practical CSRF risk, but nothing
  // asserted that a non-JSON body was refused before this test did.
  await cleanup();
  try {
    const cookie = await signIn(A);

    const textHeaders = new Headers(cookie);
    textHeaders.set('content-type', 'text/plain');
    const textResponse = await createRoute(new Request('http://localhost:3000/api/keys', {
      method: 'POST', headers: textHeaders, body: JSON.stringify({ label: 'plain' }),
    }));
    assert.equal(textResponse.status, 400);

    // RFC 9110 makes media types case-insensitive, and fetch does not
    // normalise header values -- a compliant client spelling it
    // "Application/JSON" must not be refused for that alone.
    const mixedCaseHeaders = new Headers(cookie);
    mixedCaseHeaders.set('content-type', 'Application/JSON');
    const mixedCaseResponse = await createRoute(new Request('http://localhost:3000/api/keys', {
      method: 'POST', headers: mixedCaseHeaders, body: JSON.stringify({ label: 'mixed-case' }),
    }));
    assert.equal(mixedCaseResponse.status, 201);

    const jsonResponse = await createRoute(post(cookie, 'json'));
    assert.equal(jsonResponse.status, 201);
  } finally {
    await cleanup();
  }
});

test('a user cannot revoke another user key through the route', opts, async () => {
  await cleanup();
  try {
    const headersA = await signIn(A);
    const created = await createRoute(post(headersA, 'mine'));
    const payload = await created.json() as { key: { id: string } };

    const headersB = await signIn(B);
    const response = await revokeRoute(
      new Request(`http://localhost:3000/api/keys/${payload.key.id}`, { method: 'DELETE', headers: headersB }),
      { params: Promise.resolve({ id: payload.key.id }) },
    );
    // Same answer as a key that does not exist: no disclosure either way.
    assert.equal(response.status, 404);
  } finally {
    await cleanup();
  }
});

test('an owner can revoke their own key', opts, async () => {
  await cleanup();
  try {
    const headers = await signIn(A);
    const created = await createRoute(post(headers, 'doomed'));
    const payload = await created.json() as { key: { id: string } };

    const response = await revokeRoute(
      new Request(`http://localhost:3000/api/keys/${payload.key.id}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: payload.key.id }) },
    );
    assert.equal(response.status, 204);

    const listed = await listRoute(new Request('http://localhost:3000/api/keys', { headers }));
    const body = await listed.json() as { keys: readonly { revokedAt: string | null }[] };
    assert.equal(body.keys.length, 1, 'expected exactly one key');
    assert.ok(body.keys[0]?.revokedAt !== null, 'the key should be marked revoked');
  } finally {
    await cleanup();
  }
});

test('a malformed key id does not produce a 500', opts, async () => {
  // `id`::uuid on a non-uuid throws in Postgres; the route must catch it.
  await cleanup();
  try {
    const headers = await signIn(A);
    const response = await revokeRoute(
      new Request('http://localhost:3000/api/keys/not-a-uuid', { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    assert.ok([400, 404].includes(response.status), `got ${response.status}`);
  } finally {
    await cleanup();
  }
});
