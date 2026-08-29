import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KeysManager } from '../../components/keys-manager';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

test('the manager is a client component', async () => {
  assert.equal(typeof KeysManager, 'function');
  assert.ok((await source('components/keys-manager.tsx')).startsWith("'use client'"));
});

test('the manager imports KeyRow type-only', async () => {
  // lib/keys/manage.ts imports Drizzle; a value import would ship it.
  const text = await source('components/keys-manager.tsx');
  for (const line of text.split('\n').filter((l) => l.includes('lib/keys/manage'))) {
    assert.ok(line.includes('import type'), `must be type-only: ${line}`);
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
