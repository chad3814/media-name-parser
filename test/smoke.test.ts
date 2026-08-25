import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the corpus fixtures are present and non-empty', () => {
  const files = [
    'fixtures/corpus/movies.releases.raw.txt',
    'fixtures/corpus/movies.library.raw.txt',
    'fixtures/corpus/tv.releases.raw.txt',
    'fixtures/corpus/tv.library.raw.txt',
    'fixtures/corpus/tv.sport.raw.txt',
  ];
  let total = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length > 0, `${file} is empty`);
    total += lines.length;
  }
  assert.equal(total, 5951);
});
