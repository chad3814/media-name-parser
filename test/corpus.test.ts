import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CORPUS, measure } from '../scripts/corpus-report';

const baselineSchema = z.object({
  parseRate: z.record(z.string(), z.number()),
  titleLeaks: z.record(z.string(), z.number()),
  refused: z.record(z.string(), z.number()),
  resolveRate: z.record(z.string(), z.number()).nullable(),
});

function baseline() {
  return baselineSchema.parse(JSON.parse(readFileSync('fixtures/corpus/baseline.json', 'utf8')));
}

test('no corpus file regresses below its recorded parse rate', () => {
  const recorded = baseline();
  for (const { file, category } of CORPUS) {
    const floor = recorded.parseRate[file];
    assert.notEqual(floor, undefined, `${file} has no recorded baseline`);
    if (floor === undefined) continue;
    const actual = measure(file, category);
    assert.ok(
      actual.rate >= floor - 0.0001,
      `${file} regressed: ${(actual.rate * 100).toFixed(2)}% < ${(floor * 100).toFixed(2)}% ` +
      `(parsed=${actual.parsed} refused=${actual.refused} failed=${actual.failed})`,
    );
  }
});

test('no corpus file leaks more junk into titles than its recorded ceiling', () => {
  const recorded = baseline();
  for (const { file, category } of CORPUS) {
    const ceiling = recorded.titleLeaks[file];
    assert.notEqual(ceiling, undefined, `${file} has no recorded leak ceiling`);
    if (ceiling === undefined) continue;
    const actual = measure(file, category);
    assert.ok(
      actual.titleLeaks <= ceiling,
      `${file} leaked more junk into titles: ${actual.titleLeaks} > ${ceiling}`,
    );
  }
});

test('no corpus file refuses more lines than its recorded ceiling', () => {
  // The parse rate alone cannot catch this: an intentional refusal counts
  // toward the rate, so a parser that refused every line would score 100%.
  const recorded = baseline();
  for (const { file, category } of CORPUS) {
    const ceiling = recorded.refused[file];
    assert.notEqual(ceiling, undefined, `${file} has no recorded refusal ceiling`);
    if (ceiling === undefined) continue;
    const actual = measure(file, category);
    assert.ok(
      actual.refused <= ceiling,
      `${file} refused more lines than before: ${actual.refused} > ${ceiling}`,
    );
  }
});

test('the parser never throws on any corpus line', () => {
  for (const { file, category } of CORPUS) {
    const actual = measure(file, category);
    assert.ok(actual.total > 0, `${file} is empty`);
    assert.equal(actual.threw, 0, `${file}: parser threw on ${actual.threw} line(s)`);
    assert.equal(actual.failed, 0, `${file}: ${actual.failed} line(s) parsed to an empty title`);
  }
});
