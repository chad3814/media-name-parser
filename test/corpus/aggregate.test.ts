import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, MAX_NAMES, type CorpusRow } from '../../lib/corpus/aggregate';

function row(over: Partial<CorpusRow>): CorpusRow {
  return {
    name: 'x', state: 'resolved', status: 200, cached: false,
    confidence: 1, refusal: null, ...over,
  };
}

test('an empty run reports zeroes, not NaN', () => {
  // The failure mode for a measurement tool is a plausible wrong number, and
  // 0/0 is the classic one.
  const s = summarise([]);
  assert.equal(s.total, 0);
  assert.equal(s.parsedRate, 0);
  assert.equal(s.resolvedRate, 0);
  assert.equal(s.meanConfidence, null);
  assert.equal(s.complete, true, 'a run with nothing pending is complete');
});

test('rates are fractions of the total', () => {
  const s = summarise([
    row({ state: 'resolved', confidence: 1 }),
    row({ state: 'unresolved', confidence: 0.5 }),
    row({ state: 'unresolved', confidence: null, refusal: 'no title found' }),
    row({ state: 'resolved', confidence: 0.8 }),
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.resolved, 2);
  assert.equal(s.resolvedRate, 0.5);
  // Three of four parsed: the refused one did not.
  assert.equal(s.refused, 1);
  assert.equal(s.parsed, 3);
  assert.equal(s.parsedRate, 0.75);
});

test('the mean covers only scored rows', () => {
  // Treating a null as zero would drag the mean down and make an unscored
  // lookup look like a bad match rather than no match.
  const s = summarise([
    row({ confidence: 1 }),
    row({ confidence: 0.5 }),
    row({ confidence: null, state: 'unresolved' }),
  ]);
  assert.equal(s.meanConfidence, 0.75);
});

test('the mean is null when nothing was scored', () => {
  const s = summarise([row({ confidence: null, state: 'unresolved' })]);
  assert.equal(s.meanConfidence, null);
});

test('a pending item is counted as pending, never as a failure', () => {
  // An item that blew its deadline has its parse and an enqueued job. Folding
  // it into unresolved would under-report the resolve rate, which is the one
  // number this page exists to show.
  const s = summarise([
    row({ state: 'resolved' }),
    row({ state: 'pending', status: 202, confidence: null }),
  ]);
  assert.equal(s.pending, 1);
  assert.equal(s.resolved, 1);
  assert.equal(s.complete, false, 'a pending item means the run is not complete');
  // It parsed -- there is no refusal -- so it counts as parsed.
  assert.equal(s.parsed, 2);
  assert.equal(s.parsedRate, 1);
});

test('a 202 status marks a run incomplete even if state says otherwise', () => {
  // Belt and braces: the per-item status is the field the handler sets from
  // `partial`, so trust it as well as `state`.
  const s = summarise([row({ state: 'unresolved', status: 202 })]);
  assert.equal(s.pending, 1);
  assert.equal(s.complete, false);
});

test('cached items are counted, because a fast run is a cached run', () => {
  const s = summarise([row({ cached: true }), row({ cached: false })]);
  assert.equal(s.cachedCount, 1);
});

test('rates are exact for a third, not rounded into a wrong number', () => {
  const s = summarise([row({}), row({ state: 'unresolved' }), row({ state: 'unresolved' })]);
  // Rounding belongs in the view, not the arithmetic.
  assert.ok(Math.abs(s.resolvedRate - 1 / 3) < 1e-12);
});

test('the name cap is small enough that a person will wait for the run', () => {
  // 5951 corpus lines at 5 per chunk is 1190 requests; this keeps a run to 100.
  assert.ok(MAX_NAMES <= 500);
});
