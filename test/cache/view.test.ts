import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { loadCacheView } from '../../lib/cache/view';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { signIn, deleteUser, setRole } from '../helpers/signIn';
import { seedLookup } from '../helpers/seedLookup';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

// This is the only page in the project that renders other users' data. The
// guard used to live inside the async Server Component, where node:test
// cannot reach it -- a review proved that by replacing the guard with
// `void guard;` and watching every existing test stay green while the page
// served cache data to a non-admin. These tests exercise the decision
// directly, and the shape of `CacheView` means a refusal cannot carry a
// `page` even by mistake.

test('an anonymous caller is sent to sign in and gets no data', opts, async () => {
  const view = await loadCacheView(new Headers(), new URLSearchParams());
  assert.equal(view.kind, 'signin');
  assert.equal('page' in view, false, 'a refusal must not carry data');
});

test('a signed-in non-admin is refused for role and gets no data', opts, async () => {
  const email = 'view-nonadmin@example.test';
  try {
    const view = await loadCacheView(await signIn(email), new URLSearchParams());
    assert.equal(view.kind, 'refused');
    if (view.kind !== 'refused') throw new Error('unreachable');
    assert.equal(view.reason, 'role');
    assert.equal('page' in view, false, 'a refusal must not carry data');
  } finally {
    await deleteUser(email);
  }
});

test('a failed session read is refused as unavailable, not as a role problem', opts, async (t) => {
  // The arm F1's refactor left uncovered. Collapsing 403 and 503 into
  // reason:'role' leaves tsc, oxlint and every other test in this file green
  // -- and it would tell an admin their permissions are wrong during an
  // outage, which is the exact regression this directory has already
  // shipped once (see app/(admin)/admin/cache/page.tsx's git history).
  // Reachable now only because the decision moved out of the async Server
  // Component: node:test cannot render that, but loadCacheView is a plain
  // function, and requireUser's own try/catch is what turns this stubbed
  // throw into the 503 that requireAdmin passes through.
  const { getAuth } = await import('../../lib/auth/server');
  t.mock.method(getAuth().api, 'getSession', async () => {
    throw new Error('simulated session-read failure');
  });
  const view = await loadCacheView(new Headers(), new URLSearchParams());
  assert.equal(view.kind, 'refused');
  if (view.kind !== 'refused') throw new Error('unreachable');
  assert.equal(view.reason, 'unavailable', 'an outage is not a permissions problem');
});

test('an admin gets the page and its filters', opts, async () => {
  const email = 'view-admin@example.test';
  // The `none` band means confidence IS NULL, so the fixture has to be
  // unscored. Asking the dev cache for such a row is what this test used to
  // do, and a full run leaves behind only a scored one -- so on any freshly
  // migrated database it could not pass.
  // Not `books`: browse.test.ts asserts exact row counts scoped to that
  // category, and these files run in parallel.
  const unscored = await seedLookup({
    category: 'xxx', name: 'View.Fixture.Unscored', state: 'pending', confidence: null,
  });
  try {
    const headers = await signIn(email);
    await setRole(email, ADMIN_ROLE);
    const view = await loadCacheView(headers, new URLSearchParams('band=none'));
    assert.equal(view.kind, 'ready');
    if (view.kind !== 'ready') throw new Error('unreachable');
    assert.equal(view.filters.band, 'none');
    assert.ok(view.page.rows.some((row) => row.name === unscored.name),
      'the none band should return the unscored row just seeded');
    // `every` on an empty page is vacuously true, so the `some` above is what
    // gives this assertion something to be wrong about.
    assert.ok(view.page.rows.every((row) => row.confidence === null),
      'the none band must return only unscored rows');
  } finally {
    await deleteUser(email);
    await unscored.release();
  }
});
