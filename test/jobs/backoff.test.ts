import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelayMs, JOB_MAX_ATTEMPTS } from '../../lib/jobs/backoff';

test('delay grows with attempts', () => {
  const noJitter = (): number => 0.5;
  const delays = [1, 2, 3, 4, 5].map((n) => nextDelayMs(n, noJitter));
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok((delays[i] ?? 0) > (delays[i - 1] ?? 0), `attempt ${i + 1} should wait longer`);
  }
});

test('the first retry is soon and the last is not absurd', () => {
  const noJitter = (): number => 0.5;
  assert.ok(nextDelayMs(1, noJitter) <= 60_000, 'the first retry should be within a minute');
  assert.ok(nextDelayMs(JOB_MAX_ATTEMPTS, noJitter) <= 6 * 3600_000, 'and the last within six hours');
});

test('jitter spreads retries so a batch does not stampede', () => {
  // Two jobs failing in the same tick must not come back in the same tick.
  const low = nextDelayMs(3, () => 0);
  const high = nextDelayMs(3, () => 1);
  assert.ok(high > low, 'jitter must actually vary the delay');
  assert.ok(high - low > 1000, `the spread should be meaningful, got ${high - low}ms`);
});

test('a delay is always positive and never NaN', () => {
  for (const attempts of [0, 1, 5, 50, 5000]) {
    for (const r of [0, 0.5, 1]) {
      const delay = nextDelayMs(attempts, () => r);
      assert.ok(Number.isFinite(delay), `attempts=${attempts} r=${r} gave ${delay}`);
      assert.ok(delay > 0);
    }
  }
});

test('the delay is capped rather than growing forever', () => {
  const noJitter = (): number => 0.5;
  assert.equal(nextDelayMs(100, noJitter), nextDelayMs(1000, noJitter));
});
