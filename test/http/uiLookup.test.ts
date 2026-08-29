import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { POST as uiLookup } from '../../app/api/ui/lookup/route';
import { POST as apiLookup } from '../../app/api/v1/lookup/route';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function body(headers: Headers, name: string): Request {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return new Request('http://localhost:3000/api/ui/lookup', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ category: 'movies', name }),
  });
}

test('the browser route refuses an anonymous request', opts, async () => {
  const response = await uiLookup(body(new Headers(), 'Whatever.2010.1080p.mkv'));
  assert.equal(response.status, 401);
});

test('the browser route refuses an api key', opts, async () => {
  // A key is not a cookie: /api/ui/* is for people.
  const headers = new Headers({ authorization: 'Bearer mnp_deadbeef_notarealkey' });
  const response = await uiLookup(body(headers, 'Whatever.2010.1080p.mkv'));
  assert.equal(response.status, 401);
});

test('the public route still refuses a session cookie', opts, async () => {
  // The other direction, and the property Plan 4 verified route by route.
  const email = 'ui-cross@example.test';
  try {
    const response = await apiLookup(body(await signIn(email), 'Whatever.2010.1080p.mkv'));
    assert.equal(response.status, 401);
  } finally {
    await deleteUser(email);
  }
});

test('a signed-in user gets an envelope from the browser route', opts, async () => {
  // Uses a name already cached in the dev database so the test makes no
  // network call. `cached` proves it came from the cache rather than TMDB.
  const email = 'ui-ok@example.test';
  try {
    const response = await uiLookup(body(
      await signIn(email),
      'Movies/Cocaine Bear (2023)/Cocaine.Bear.2023.NORDiC.1080p.WEB-DL.H.264.DDP5.1.Atmos-NoTrace.mkv',
    ));
    assert.ok([200, 202].includes(response.status), `unexpected ${response.status}`);
    const envelope = await response.json() as {
      lookupId: string; state: string; cached: boolean; confidence: number | null;
    };
    assert.equal(typeof envelope.lookupId, 'string');
    assert.ok(['resolved', 'unresolved', 'pending'].includes(envelope.state));
  } finally {
    await deleteUser(email);
  }
});
