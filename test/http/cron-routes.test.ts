import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../app/api/cron/sweep/route';
import { fixtureFetch } from '../support/tmdb-fixtures';

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

test('the cron route with the correct bearer runs the sweep and returns a report', opts, async () => {
  // The route builds its own `sweep()` call with no seam to inject a
  // fixture-backed fetch. Swapping the global for the duration of this test
  // keeps it offline even if it happens to claim a real due job left behind
  // by another, concurrently-running test file: a claim that hits a name
  // with no recording throws (per `fixtureFetch`'s own contract) rather than
  // reaching the network, and that throw is caught per-job inside `sweep()`
  // and settled as a retry, not surfaced here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fixtureFetch();
  try {
    await withCronSecret('cron-test-secret', async () => {
      const response = await GET(new Request('https://x.test/api/cron/sweep', {
        headers: { authorization: 'Bearer cron-test-secret' },
      }));
      assert.equal(response.status, 200);
      const report = await json(response);
      assert.equal(typeof report.claimed, 'number');
      assert.equal(typeof report.done, 'number');
      assert.equal(typeof report.retried, 'number');
      assert.equal(typeof report.abandoned, 'number');
      assert.equal(typeof report.prunedRateWindows, 'number');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
