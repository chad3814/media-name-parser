import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeps } from '../../lib/http/envelope';

/**
 * `buildDeps` is exercised directly, not through `handleLookup`.
 *
 * The route tests inject their own `testDeps()` so they stay offline, which
 * means every one of them bypasses this factory entirely. A test written
 * against the route could not observe which providers get built, and an
 * earlier attempt at exactly that passed identically whether `books` routed
 * to TMDB or to nothing at all.
 */

function withoutEnv(names: readonly string[], fn: () => void): void {
  const saved = new Map(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  try {
    fn();
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

const TMDB = ['TMDB_READ_ACCESS_TOKEN', 'TMDB_API_KEY'];

test('books builds no provider, because ibdb.dev is not implemented', () => {
  // A category nothing serves must answer `unresolved`. It must NOT be routed
  // to a provider that does not support it, because then a deployment with no
  // TMDB credential raises a 503 for a lookup nothing was going to answer.
  withoutEnv(TMDB, () => {
    assert.deepEqual(buildDeps('books').providers, []);
  });
});

test('a missing credential for a category that HAS a provider still raises', () => {
  // The other half, and the reason `books` cannot simply be lumped in with a
  // catch-all: an absent TMDB credential is an outage for movies and tv, and
  // must surface as one rather than as a cached non-answer.
  withoutEnv(TMDB, () => {
    assert.throws(() => buildDeps('movies'), /TMDB/);
    assert.throws(() => buildDeps('tv'), /TMDB/);
  });
});

test('xxx builds the tpdb provider, and only that one', () => {
  const providers = buildDeps('xxx').providers;
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.name, 'tpdb');
  assert.equal(providers[0]?.supports('xxx'), true);
  assert.equal(providers[0]?.supports('movies'), false);
});

test('movies builds the tmdb provider, and only that one', () => {
  const providers = buildDeps('movies').providers;
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.name, 'tmdb');
  assert.equal(providers[0]?.supports('movies'), true);
  assert.equal(providers[0]?.supports('xxx'), false);
});
