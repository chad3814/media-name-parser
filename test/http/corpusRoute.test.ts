import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { closeDb, withTransaction } from '../../lib/db/client';
import { ensureUser } from '../../lib/auth/users';
import { mintApiKey } from '../../lib/auth/apiKey';
import { POST as corpus } from '../../app/api/ui/corpus/route';
import { CORPUS_CHUNK } from '../../lib/corpus/chunk';
import { signIn, deleteUser } from '../helpers/signIn';
import { seedLookup, type Seeded } from '../helpers/seedLookup';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/**
 * A resolved name this test owns, so no test here calls TMDB.
 *
 * This used to SELECT any resolved row out of the dev cache, which made the
 * test pass or fail on what earlier runs happened to leave behind. The caller
 * must `release()` it.
 */
async function cachedName(): Promise<Seeded> {
  return seedLookup({
    category: 'movies', name: 'Corpus.Fixture.Cached.2010.1080p.mkv',
    state: 'resolved', confidence: 0.95,
  });
}

function body(headers: Headers, names: readonly string[]): Request {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return new Request('http://localhost:3000/api/ui/corpus', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ items: names.map((name) => ({ category: 'movies', name })) }),
  });
}

test('the chunk size is small enough to fit the function budget', () => {
  // Arithmetic, not taste: items run sequentially at up to LOOKUP_DEADLINE_MS
  // (8s) each, and maxDuration is 60. This assertion is here so that raising
  // the cap without raising the budget fails loudly rather than timing out in
  // production on a cold chunk.
  assert.ok(CORPUS_CHUNK * 8 < 60, `${CORPUS_CHUNK} items of 8s does not fit in 60s`);
});

test('an anonymous request is refused', opts, async () => {
  const response = await corpus(body(new Headers(), ['Whatever.2010.mkv']));
  assert.equal(response.status, 401);
});

test('an anonymous request over the cap is refused for lack of a session, not for its shape', opts, async () => {
  // Gating happens before the body is even parsed: an anonymous caller's
  // status must not depend on what it sent, and a 400 here would disclose
  // the chunk cap to someone with no session.
  const names = Array.from({ length: CORPUS_CHUNK + 1 }, (_, i) => `Over.Cap.${i}.2010.mkv`);
  const response = await corpus(body(new Headers(), names));
  assert.equal(response.status, 401);
});

test('an anonymous single-item body is refused for lack of a session, not for its shape', opts, async () => {
  const response = await corpus(new Request('http://localhost:3000/api/ui/corpus', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ category: 'movies', name: 'Whatever.2010.mkv' }),
  }));
  assert.equal(response.status, 401);
});

test('an api key is refused: this route is for people', opts, async () => {
  // A real minted key, not a made-up string -- an unminted token is refused by
  // either gate, so a fake one could not tell a wrongly wired route from a
  // correct one. This project has been bitten by exactly that.
  const email = 'corpus-key@example.test';
  try {
    const userId = await withTransaction(async (tx) => (await ensureUser(tx, email)).id);
    const minted = await mintApiKey();
    await withTransaction((tx) => tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES (${userId}, 'corpus route test', ${minted.tokenHash}, ${minted.prefix})`));
    const headers = new Headers({ authorization: `Bearer ${minted.token}` });
    assert.equal((await corpus(body(headers, ['Whatever.2010.mkv']))).status, 401);
  } finally {
    await deleteUser(email);
  }
});

test('a signed-in user gets one result per item', opts, async () => {
  const email = 'corpus-ok@example.test';
  const cached = await cachedName();
  try {
    const name = cached.name;
    const response = await corpus(body(await signIn(email), [name, name]));
    assert.equal(response.status, 200, 'a batch response is always 200');
    const payload = await response.json() as {
      results: readonly { status: number; state: string; cached: boolean }[];
    };
    assert.equal(payload.results.length, 2);
    // Cached, therefore no provider call: this is what keeps the test offline.
    assert.equal(payload.results[0]?.cached, true);
    assert.equal(payload.results[0]?.status, 200);
  } finally {
    await deleteUser(email);
    await cached.release();
  }
});

test('a chunk over the cap is refused, and the message says the cap', opts, async () => {
  const email = 'corpus-cap@example.test';
  try {
    const names = Array.from({ length: CORPUS_CHUNK + 1 }, (_, i) => `Over.Cap.${i}.2010.mkv`);
    const response = await corpus(body(await signIn(email), names));
    assert.equal(response.status, 400);
    const problem = await response.json() as { detail?: string };
    // A cap without a number is a message the caller cannot act on.
    assert.ok(
      (problem.detail ?? '').includes(String(CORPUS_CHUNK)),
      `the detail should name the cap: ${problem.detail}`,
    );
  } finally {
    await deleteUser(email);
  }
});

test('a single-item body is refused: this route is the batch surface', opts, async () => {
  // The mirror of /api/ui/lookup refusing batches. Each route does one thing,
  // so a caller cannot half-use either.
  const email = 'corpus-single@example.test';
  try {
    const headers = new Headers(await signIn(email));
    headers.set('content-type', 'application/json');
    const response = await corpus(new Request('http://localhost:3000/api/ui/corpus', {
      method: 'POST',
      headers,
      body: JSON.stringify({ category: 'movies', name: 'Whatever.2010.mkv' }),
    }));
    assert.equal(response.status, 400);
  } finally {
    await deleteUser(email);
  }
});
