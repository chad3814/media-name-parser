import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { closeDb, withTransaction } from '../../lib/db/client';
import { POST as uiLookup } from '../../app/api/ui/lookup/route';
import { POST as apiLookup } from '../../app/api/v1/lookup/route';
import { signIn, deleteUser } from '../helpers/signIn';
import { ensureUser } from '../../lib/auth/users';
import { mintApiKey } from '../../lib/auth/apiKey';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

// Already resolved in the dev database, so a lookup against it makes no
// provider call -- confirmed separately by inspecting the `cached` field on
// the envelope this file asserts on below.
const CACHED_NAME =
  'Movies/Cocaine Bear (2023)/Cocaine.Bear.2023.NORDiC.1080p.WEB-DL.H.264.DDP5.1.Atmos-NoTrace.mkv';

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

test('the browser route refuses a real api key', opts, async () => {
  // A *minted* key, not a made-up string. An unminted token is refused by
  // either gate -- no cookie, or unknown key -- so a fake token leaves this
  // test green even when the route is wired to apiKeyGate, which is precisely
  // the crossover it is named for. Measured: with a real key the wrongly
  // wired route returns 202 and the correct one 401.
  const email = 'ui-realkey@example.test';
  try {
    const userId = await withTransaction(async (tx) => (await ensureUser(tx, email)).id);
    const minted = await mintApiKey();
    await withTransaction((tx) => tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES (${userId}, 'uiLookup crossover test', ${minted.tokenHash}, ${minted.prefix})`));

    const bearer = new Headers({ authorization: `Bearer ${minted.token}` });

    // First prove the key is real, by using it where it is supposed to work.
    // Without this, a 401 below could just mean the token was bogus.
    const onKeyRoute = await apiLookup(body(bearer, CACHED_NAME));
    assert.ok(
      [200, 202].includes(onKeyRoute.status),
      `the minted key should work on /api/v1/lookup, got ${onKeyRoute.status}`,
    );

    // Now the assertion that matters: the same working key is refused here.
    const onUiRoute = await uiLookup(body(bearer, CACHED_NAME));
    assert.equal(onUiRoute.status, 401, 'a valid api key must not reach the session route');
  } finally {
    // api_keys.user_id cascades, so removing the user removes the key.
    await deleteUser(email);
  }
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
    const response = await uiLookup(body(await signIn(email), CACHED_NAME));
    assert.ok([200, 202].includes(response.status), `unexpected ${response.status}`);
    const envelope = await response.json() as {
      lookupId: string; state: string; cached: boolean; confidence: number | null;
    };
    assert.equal(typeof envelope.lookupId, 'string');
    assert.ok(['resolved', 'unresolved', 'pending'].includes(envelope.state));
    assert.equal(envelope.cached, true, 'the cached name must not hit the provider');
  } finally {
    await deleteUser(email);
  }
});

test('the browser route refuses a batched body but accepts a single lookup', opts, async () => {
  // sessionGate charges no rate limit, and the shared handler accepts up to
  // 100 items -- without a check at the route, the session path would be an
  // unthrottled bulk endpoint. Both directions matter: refusing a batch, and
  // not refusing the single-item shape the page actually sends.
  const email = 'ui-batch@example.test';
  try {
    const headers = await signIn(email);

    const batchHeaders = new Headers(headers);
    batchHeaders.set('content-type', 'application/json');
    const batched = new Request('http://localhost:3000/api/ui/lookup', {
      method: 'POST',
      headers: batchHeaders,
      body: JSON.stringify({ items: [{ category: 'movies', name: CACHED_NAME }] }),
    });
    const batchedResponse = await uiLookup(batched);
    assert.equal(batchedResponse.status, 400);

    const single = await uiLookup(body(headers, CACHED_NAME));
    assert.ok([200, 202].includes(single.status), `unexpected ${single.status}`);
  } finally {
    await deleteUser(email);
  }
});
