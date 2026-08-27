import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../app/api/cron/sweep/route';
import { fixtureFetch } from '../support/tmdb-fixtures';
import { handleSweep } from '../../lib/http/sweepHandler';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

/**
 * `CRON_SECRET` set for the duration of `fn` and restored afterward, so no
 * other test in the suite observes it. Set directly on `process.env`, never
 * read from a file -- it is a throwaway string invented for this test.
 */
async function withCronSecret<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

test('the cron route without an Authorization header is 401', opts, async () => {
  await withCronSecret('cron-test-secret', async () => {
    const response = await GET(new Request('https://x.test/api/cron/sweep'));
    assert.equal(response.status, 401);
  });
});

test('the cron route with the wrong bearer is 401', opts, async () => {
  await withCronSecret('cron-test-secret', async () => {
    const response = await GET(new Request('https://x.test/api/cron/sweep', {
      headers: { authorization: 'Bearer not-the-secret' },
    }));
    assert.equal(response.status, 401);
  });
});

test('the cron handler with the correct bearer runs the sweep and returns a report', opts, async () => {
  // Through `handleSweep` with a fixture-backed fetch injected, rather than
  // through the route with `globalThis.fetch` swapped. The old arrangement
  // worked but was order-fragile: a throw before its `finally` would leave a
  // stubbed global behind for whatever ran next.
  await withCronSecret('cron-test-secret', async () => {
    const response = await handleSweep(
      new Request('https://x.test/api/cron/sweep', {
        headers: { authorization: 'Bearer cron-test-secret' },
      }),
      { workerId: 'cron-test', now: () => new Date(), fetchImpl: fixtureFetch() },
    );
    assert.equal(response.status, 200);
    const report = await json(response);
    assert.equal(typeof report.claimed, 'number');
    assert.equal(typeof report.done, 'number');
    assert.equal(typeof report.retried, 'number');
    assert.equal(typeof report.abandoned, 'number');
    assert.equal(typeof report.prunedRateWindows, 'number');
    // The spec puts the 30-day `provider_calls` retention on this same cron,
    // so the report has to account for it too.
    assert.equal(typeof report.prunedProviderCalls, 'number');
  });
});

test('the route delegates to the handler and still refuses without the bearer', opts, async () => {
  // The route is now a wrapper, so this is what keeps it wired up: if the
  // delegation broke, an unauthenticated request would not come back 401.
  await withCronSecret('cron-test-secret', async () => {
    const response = await GET(new Request('https://x.test/api/cron/sweep'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  });
});
