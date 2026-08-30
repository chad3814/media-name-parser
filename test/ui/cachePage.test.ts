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

test('the page guards itself as well as the layout', async () => {
  // A layout does not re-run on client-side navigation, so the thing that
  // serves data checks for itself.
  const text = await source('app/(admin)/admin/cache/page.tsx');
  const lines = importLines(text, 'lib/auth/session');
  assert.ok(lines.length > 0, 'expected the session module to be imported');
  assert.ok(text.includes('requireAdmin('), 'the page must call requireAdmin');
});

test('the page uses the tested query module rather than inlining SQL', async () => {
  const text = await source('app/(admin)/admin/cache/page.tsx');
  const lines = importLines(text, 'lib/cache/browse');
  assert.ok(lines.length > 0, 'expected browseCache to be imported');
  assert.ok(text.includes('browseCache('), 'expected browseCache to be called');
  assert.ok(text.includes('parseFilters('), 'expected parseFilters to be called');
  // Inline SQL here would be untested and would duplicate the band logic.
  assert.equal(text.includes('sql`'), false, 'the page must not build its own query');
});

test('the admin index links to the cache browser', async () => {
  // It promised cache inspection for two plans; now the link exists.
  const text = await source('app/(admin)/admin/page.tsx');
  assert.ok(text.includes('/admin/cache'), 'the admin index should link to the browser');
});
