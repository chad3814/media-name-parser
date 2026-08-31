import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CacheFilters } from '../../components/cache-filters';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

const importLines = (text: string, path: string): readonly string[] =>
  text.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes(path));

test('the filter form is a server component and needs no client bundle', async () => {
  // A plain <form method="get"> submits to the same URL and the server reads
  // it back. No 'use client', no state, no fetch -- and it works without JS.
  assert.equal(typeof CacheFilters, 'function');
  const text = await source('components/cache-filters.tsx');
  assert.equal(text.includes("'use client'"), false, 'must not be a client component');
  assert.ok(text.includes('method="get"'), 'must submit as a GET form');
  assert.equal(text.includes('useState'), false, 'the URL is the state');
});

test('the page awaits searchParams', async () => {
  // Next 16 passes a Promise, and BOTH annotations typecheck -- so a missing
  // await is not a compile error, it silently makes every filter undefined.
  const text = await source('app/(admin)/admin/cache/page.tsx');
  assert.ok(text.includes('Promise<'), 'searchParams must be typed as a Promise');
  assert.ok(/await\s+searchParams/.test(text), 'searchParams must be awaited');
});

test('the page delegates its guard to loadCacheView, which itself calls requireAdmin', async () => {
  // The guard used to live inside this async Server Component, where
  // node:test cannot reach it -- a review proved that by replacing it with
  // `void guard;` and watching every test here stay green while the page
  // served cache data to a non-admin. The decision now lives in
  // lib/cache/view.ts, exercised directly by test/cache/view.test.ts.
  const pageText = await source('app/(admin)/admin/cache/page.tsx');
  const pageImports = importLines(pageText, 'lib/cache/view');
  assert.ok(pageImports.length > 0, 'expected the page to import lib/cache/view');
  assert.ok(pageText.includes('loadCacheView('), 'the page must call loadCacheView');

  const viewText = await source('lib/cache/view.ts');
  const viewImports = importLines(viewText, 'auth/session');
  assert.ok(viewImports.length > 0, 'expected loadCacheView to import the session module');
  assert.ok(viewText.includes('requireAdmin('), 'loadCacheView must call requireAdmin');
});

test('the page cannot query around the guard', async () => {
  const text = await source('app/(admin)/admin/cache/page.tsx');
  // browseCache and parseFilters live behind loadCacheView's guard. If the
  // page could reach either directly, it could serve data to a caller
  // loadCacheView already refused.
  assert.equal(text.includes('browseCache'), false, 'the page must not import browseCache');
  assert.equal(text.includes('parseFilters'), false, 'the page must not import parseFilters');
  // Inline SQL here would be untested and would duplicate the band logic.
  assert.equal(text.includes('sql`'), false, 'the page must not build its own query');
});

test('the admin index links to the cache browser', async () => {
  // It promised cache inspection for two plans; now the link exists.
  const text = await source('app/(admin)/admin/page.tsx');
  assert.ok(text.includes('/admin/cache'), 'the admin index should link to the browser');
});
