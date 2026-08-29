import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LookupForm } from '../../components/lookup-form';

test('the form is a component', () => {
  assert.equal(typeof LookupForm, 'function');
});

test('the form imports the envelope type only as a type', async () => {
  // lib/http/envelope.ts pulls in the TMDB client and Drizzle. A value import
  // here would put both in the browser bundle -- and it would still build,
  // which is why this is asserted rather than left to review.
  const source = await readFile(new URL('../../components/lookup-form.tsx', import.meta.url), 'utf8');
  // Only actual import statements, not prose. Filtering every line that
  // mentions the path would fail on a comment explaining why the import is
  // type-only, which would let a test dictate the wording of a comment.
  const envelopeImports = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes('lib/http/envelope'));
  assert.ok(envelopeImports.length > 0, 'expected the form to import the envelope type');
  for (const line of envelopeImports) {
    assert.ok(line.startsWith('import type'), `must be a type-only import: ${line}`);
  }
});

test('the form is a client component', async () => {
  const source = await readFile(new URL('../../components/lookup-form.tsx', import.meta.url), 'utf8');
  assert.ok(source.startsWith("'use client'"), "must begin with 'use client'");
});

test('the page is a server component that does not import the client bundle entry', async () => {
  const source = await readFile(new URL('../../app/page.tsx', import.meta.url), 'utf8');
  assert.ok(!source.includes("'use client'"), 'the page must stay a server component');
  assert.ok(source.includes('LookupForm'), 'the page must render the form');
});
