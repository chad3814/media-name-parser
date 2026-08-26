import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, STALE_AFTER_HOURS, type LookupRow } from '../../lib/cache/lookup';
import { PARSER_VERSION } from '../../lib/parse/markers';

const NOW = new Date('2026-08-26T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3600_000);
const FLOOR = 0.75;

const row = (over: Partial<LookupRow>): LookupRow => ({
  id: 'l1', category: 'tv', name: 'x', normalizedKey: 'x',
  mediaId: 'm1', confidence: 0.9, pinned: false, state: 'resolved',
  lastAttemptAt: hoursAgo(100), parserVersion: PARSER_VERSION,
  ...over,
});

test('a resolved row above the floor is fresh and costs nothing', () => {
  assert.equal(decide(row({}), NOW, FLOOR).kind, 'fresh');
});

test('no row at all means resolve', () => {
  const got = decide(null, NOW, FLOOR);
  assert.equal(got.kind, 'resolve');
  assert.equal(got.kind === 'resolve' ? got.lookup : 'x', null);
});

test('an unresolved row attempted within the window is cooling, not retried', () => {
  const got = decide(row({ state: 'unresolved', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(1) }), NOW, FLOOR);
  assert.equal(got.kind, 'cooling');
});

test('an unresolved row attempted outside the window resolves again', () => {
  const got = decide(row({ state: 'unresolved', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(STALE_AFTER_HOURS + 1) }), NOW, FLOOR);
  assert.equal(got.kind, 'resolve');
});

test('the window boundary is inclusive of the stale side', () => {
  const inside = decide(row({ state: 'unresolved', mediaId: null, lastAttemptAt: hoursAgo(STALE_AFTER_HOURS - 0.01) }), NOW, FLOOR);
  const outside = decide(row({ state: 'unresolved', mediaId: null, lastAttemptAt: hoursAgo(STALE_AFTER_HOURS + 0.01) }), NOW, FLOOR);
  assert.equal(inside.kind, 'cooling');
  assert.equal(outside.kind, 'resolve');
});

test('a match below the confidence floor counts as incomplete', () => {
  const cooling = decide(row({ state: 'unresolved', confidence: 0.4, lastAttemptAt: hoursAgo(1) }), NOW, FLOOR);
  const retry = decide(row({ state: 'unresolved', confidence: 0.4, lastAttemptAt: hoursAgo(50) }), NOW, FLOOR);
  assert.equal(cooling.kind, 'cooling');
  assert.equal(retry.kind, 'resolve');
});

test('a resolved row whose confidence is below the floor is not fresh', () => {
  assert.equal(decide(row({ state: 'resolved', confidence: 0.5, lastAttemptAt: hoursAgo(50) }), NOW, FLOOR).kind, 'resolve');
});

test('a pinned row is fresh forever, whatever its state or age', () => {
  const cases: readonly Partial<LookupRow>[] = [
    { pinned: true, state: 'unresolved', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(10_000) },
    { pinned: true, state: 'resolved', confidence: 0.1, lastAttemptAt: hoursAgo(10_000) },
    { pinned: true, parserVersion: PARSER_VERSION - 1 },
  ];
  for (const over of cases) {
    assert.equal(decide(row(over), NOW, FLOOR).kind, 'fresh', JSON.stringify(over));
  }
});

test('a stale parser version forces a re-parse even on a resolved row', () => {
  assert.equal(decide(row({ parserVersion: PARSER_VERSION - 1 }), NOW, FLOOR).kind, 'resolve');
});

test('a missing parse row forces a resolve', () => {
  assert.equal(decide(row({ parserVersion: null }), NOW, FLOOR).kind, 'resolve');
});

test('a null lastAttemptAt is treated as never attempted', () => {
  assert.equal(decide(row({ state: 'unresolved', mediaId: null, lastAttemptAt: null }), NOW, FLOOR).kind, 'resolve');
});

test('a pending row inside the window is cooling', () => {
  assert.equal(decide(row({ state: 'pending', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(0.1) }), NOW, FLOOR).kind, 'cooling');
});
