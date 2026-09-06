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

test('nothing serves books, whatever else is built', () => {
  // `books` has no provider: ibdb.dev is not implemented. What matters is that
  // nothing CLAIMS to serve it -- not that the list is empty. Other providers
  // are built so a filename naming a foreign catalogue can be honoured, and
  // they must not answer a books lookup by being present.
  withoutEnv(TMDB, () => {
    const providers = buildDeps('books').providers;
    assert.deepEqual(providers.filter((p) => p.supports('books')), []);
  });
});

test('a missing credential for the category that HAS a provider still raises', () => {
  // An absent TMDB credential is an outage for movies and tv, and must
  // surface as one rather than as a cached non-answer. Only the category's own
  // provider is strict; the optional ones are allowed to be unavailable.
  withoutEnv(TMDB, () => {
    assert.throws(() => buildDeps('movies'), /TMDB/);
    assert.throws(() => buildDeps('tv'), /TMDB/);
  });
});

test('the category provider comes first, and it is the only one that serves it', () => {
  for (const [category, name, other] of [
    ['xxx', 'tpdb', 'movies'],
    ['movies', 'tmdb', 'xxx'],
  ] as const) {
    const providers = buildDeps(category).providers;
    assert.equal(providers[0]?.name, name, `${category} is served by ${name}`);
    assert.deepEqual(
      providers.filter((p) => p.supports(category)).map((p) => p.name), [name],
      'exactly one provider claims the category',
    );
    assert.ok(providers.some((p) => p.supports(other)),
      'the other provider is still built, so an id naming it can be honoured');
  }
});
