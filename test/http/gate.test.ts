import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { apiKeyGate, sessionGate } from '../../lib/http/gate';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function req(headers: Headers): Request {
  return new Request('http://localhost:3000/api/ui/lookup', { method: 'POST', headers });
}

test('apiKeyGate refuses a request with no bearer token', opts, async () => {
  const result = await apiKeyGate(req(new Headers()));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.response.status, 401);
});

test('apiKeyGate refuses a session cookie', opts, async () => {
  // The whole point of two gates: a cookie is not a key.
  const email = 'gate-cookie@example.test';
  try {
    const result = await apiKeyGate(req(await signIn(email)));
    assert.equal(result.ok, false);
  } finally {
    await deleteUser(email);
  }
});

test('sessionGate refuses a request with no cookie', opts, async () => {
  const result = await sessionGate(req(new Headers()));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.response.status, 401);
});

test('sessionGate admits a signed-in user', opts, async () => {
  const email = 'gate-session@example.test';
  try {
    const result = await sessionGate(req(await signIn(email)));
    assert.equal(result.ok, true);
  } finally {
    await deleteUser(email);
  }
});

test('sessionGate refuses a bearer token', opts, async () => {
  // And the other direction: a key is not a cookie.
  const headers = new Headers({ authorization: 'Bearer mnp_deadbeef_notarealkey' });
  const result = await sessionGate(req(headers));
  assert.equal(result.ok, false);
});

test('a gate result carries no caller', () => {
  // Deliberate: handleLookup never reads one, so the gate does not invent one.
  // If a future handler needs the caller, widen the type on purpose rather
  // than stuffing a synthetic Caller through here.
  const shape: Awaited<ReturnType<typeof sessionGate>> = { ok: true };
  assert.deepEqual(Object.keys(shape), ['ok']);
});
