import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CorpusRunner } from '../../components/corpus-runner';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

const importLines = (text: string, path: string): readonly string[] =>
  text.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes(path));

test('the runner is a client component', async () => {
  assert.equal(typeof CorpusRunner, 'function');
  assert.ok((await source('components/corpus-runner.tsx')).startsWith("'use client'"));
});

test('the runner chunks to the number the route enforces', async () => {
  // A page that chunked to a different number than the route accepts would
  // 400 on every request, or silently send less than it could.
  const text = await source('components/corpus-runner.tsx');
  const lines = importLines(text, 'lib/corpus/chunk');
  assert.ok(lines.length > 0, 'expected CORPUS_CHUNK to come from lib/corpus/chunk');
  assert.ok(text.includes('CORPUS_CHUNK'), 'expected the imported constant to be used');
  // Not re-declared locally, which is how the two drift apart.
  assert.equal(/const\s+CORPUS_CHUNK\s*=/.test(text), false, 'must not redeclare the chunk size');
});

test('the runner does not import the route module', async () => {
  // CORPUS_CHUNK is a value, so it cannot be imported as a type. Taking it
  // from the route would pull handleLookup -- and therefore Drizzle and the
  // TMDB client -- into the browser bundle, and the build would still pass.
  // This is the assertion that stops that, since nothing else would notice.
  const text = await source('components/corpus-runner.tsx');
  const offending = text.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes('api/ui/corpus/route'));
  assert.deepEqual(offending, [], 'a client component must not import a route module');
});

test('the runner imports the shared category list rather than restating it', async () => {
  const text = await source('components/corpus-runner.tsx');
  const lines = importLines(text, 'lib/parse/types');
  assert.ok(lines.length > 0, 'expected CATEGORIES to be imported');
  assert.equal(/const\s+CATEGORIES\s*=\s*\[/.test(text), false, 'must not restate the categories');
});

test('the runner uses the tested aggregate rather than inlining arithmetic', async () => {
  // The three numbers are the point of the page; untested arithmetic in a
  // component is exactly what lib/corpus/aggregate.ts exists to avoid.
  const text = await source('components/corpus-runner.tsx');
  const lines = importLines(text, 'lib/corpus/aggregate');
  assert.ok(lines.length > 0, 'expected summarise to be imported');
  assert.ok(text.includes('summarise('), 'expected summarise to be called');
});

test('the page is a server component that guards itself', async () => {
  const text = await source('app/corpus/page.tsx');
  assert.equal(text.includes("'use client'"), false, 'the page must stay a server component');
  assert.ok(text.includes('getCurrentUser'), 'the page must read the session');
  assert.ok(text.includes("redirect('/sign-in')"), 'and redirect when there is none');
});
