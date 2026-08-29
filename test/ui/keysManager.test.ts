import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KeysManager, canCreateKey, when } from '../../components/keys-manager';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

test('the manager is a client component', async () => {
  assert.equal(typeof KeysManager, 'function');
  assert.ok((await source('components/keys-manager.tsx')).startsWith("'use client'"));
});

test('the manager imports KeyRow type-only', async () => {
  // lib/keys/manage.ts imports Drizzle; a value import would ship it.
  // Only import statements are inspected, not prose: filtering every line that
  // mentions the path would fail on a comment explaining the rule, and a test
  // that dictates the wording of a comment is a nuisance rather than a guard.
  const text = await source('components/keys-manager.tsx');
  const imports = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes('lib/keys/manage'));
  assert.ok(imports.length > 0, 'expected the manager to import KeyRow');
  for (const line of imports) {
    assert.ok(line.startsWith('import type'), `must be type-only: ${line}`);
  }
});

test('the secret is never persisted anywhere', async () => {
  // The token lives in component state and nowhere else. A localStorage or
  // sessionStorage write would outlive the page and turn a one-time secret
  // into a stored credential.
  const text = await source('components/keys-manager.tsx');
  for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie']) {
    assert.equal(text.includes(forbidden), false, `must not use ${forbidden}`);
  }
});

test('the page is a server component that lists keys for the render', async () => {
  const text = await source('app/keys/page.tsx');
  assert.ok(!text.includes("'use client'"), 'the page must stay a server component');
  assert.ok(text.includes('listKeys'), 'the page should populate the first render');
  assert.ok(text.includes('KeysManager'));
});

test('the create form is unavailable while an undismissed secret is on screen', () => {
  // The secret in `fresh` is the only copy that exists; creating another key
  // would replace it and destroy it silently.
  assert.equal(canCreateKey(false, false), true);
  assert.equal(canCreateKey(true, false), false, 'busy must block');
  assert.equal(canCreateKey(false, true), false, 'an undismissed secret must block');
  assert.equal(canCreateKey(true, true), false);
});

test('the timestamp formatter is timezone-independent', () => {
  // toLocaleString() would render in the server's timezone during SSR and
  // the visitor's on hydration -- a mismatch invisible to tests and the
  // build. Exercised under two different ambient timezones to prove the
  // output does not move with TZ.
  const iso = '2026-03-14T09:30:00.000Z';
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const inLA = when(iso);
    process.env.TZ = 'Asia/Tokyo';
    const inTokyo = when(iso);
    assert.equal(inLA, '2026-03-14 09:30 UTC');
    assert.equal(inTokyo, '2026-03-14 09:30 UTC');
    assert.equal(inLA, inTokyo);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  assert.equal(when(null), '—');
});
