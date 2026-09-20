import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProvider } from '../../lib/providers/build';

function withEnv(vars: Readonly<Record<string, string | undefined>>, run: () => void): void {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('tmdb is wrapped so TheTVDB can stand in for it', () => {
  withEnv({ TMDB_READ_ACCESS_TOKEN: 'tmdb-token', TVDB_API_KEY: 'tvdb-key' }, () => {
    const provider = buildProvider('tmdb', () => {});
    assert.equal(provider.name, 'tmdb', 'the composite answers to the primary name');
    assert.equal(provider.supports('tv'), true);
    assert.equal(provider.supports('movies'), true);
  });
});

test('a missing TheTVDB key is not an outage', () => {
  // tv must keep working exactly as it did before this provider existed.
  // Only a missing *primary* credential may raise.
  withEnv({ TMDB_READ_ACCESS_TOKEN: 'tmdb-token', TVDB_API_KEY: undefined }, () => {
    const provider = buildProvider('tmdb', () => {});
    assert.equal(provider.name, 'tmdb');
    assert.equal(provider.supports('tv'), true);
  });
});

test('a missing primary credential still raises', () => {
  withEnv({ TMDB_READ_ACCESS_TOKEN: undefined, TVDB_API_KEY: 'tvdb-key' }, () => {
    assert.throws(() => buildProvider('tmdb', () => {}), /TMDB/i);
  });
});

test('a missing TheTVDB key raises when TheTVDB is asked for by name', () => {
  // Optional as a *fallback* is not optional as a primary: a caller naming
  // it outright has to hear that it is not configured.
  withEnv({ TVDB_API_KEY: undefined }, () => {
    assert.throws(() => buildProvider('tvdb', () => {}), /TVDB_API_KEY/);
  });
});

test('tpdb is built bare, with no fallback', () => {
  withEnv({ TPDB_API_KEY: 'tpdb-key' }, () => {
    const provider = buildProvider('tpdb', () => {});
    assert.equal(provider.name, 'tpdb');
    assert.equal(provider.supports('xxx'), true);
    assert.equal(provider.supports('tv'), false);
  });
});
