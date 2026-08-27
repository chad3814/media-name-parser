import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

export interface RateVerdict {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
  /** Seconds until the current window ends. Meaningful only when refused. */
  readonly retryAfterSeconds: number;
}

/**
 * Counts one request against a key's budget for the current minute.
 *
 * Fixed windows, not a sliding log. The cost is that a caller can get up to
 * twice its limit across a boundary -- 60 requests at 11:59:59.9 and 60 more a
 * fraction of a second later. A sliding log needs a row per request and a range
 * scan to evaluate; double-at-the-boundary is the cheaper failure and it is
 * bounded.
 *
 * The counter is one atomic statement, so two concurrent requests cannot both
 * read 59 and both decide they are fine.
 */
export async function consume(
  tx: Tx, apiKeyId: string, limit: number, now: Date = new Date(),
): Promise<RateVerdict> {
  const result = await tx.execute(sql`
    INSERT INTO rate_limit_windows (api_key_id, window_start, count)
    VALUES (${apiKeyId}::uuid, date_trunc('minute', ${now.toISOString()}::timestamptz), 1)
    ON CONFLICT (api_key_id, window_start) DO UPDATE
      SET count = rate_limit_windows.count + 1
    RETURNING count`);
  const used = Number(result.rows[0]?.count ?? 0);
  const secondsIntoMinute = now.getUTCSeconds();
  return {
    allowed: used <= limit,
    used,
    limit,
    retryAfterSeconds: Math.max(1, 60 - secondsIntoMinute),
  };
}

/**
 * Drops windows older than `keepWindows` minutes. Called by the sweep cron so
 * the table does not grow without bound; it holds one row per key per minute.
 *
 * Two by default, which is what the spec fixes it at. The window in progress
 * plus the one before it is all `consume` can ever read -- it only ever touches
 * `date_trunc('minute', now())` -- so anything older is dead weight, and the
 * one-window margin covers a prune racing a request across a minute boundary.
 */
export async function pruneRateWindows(tx: Tx, keepWindows = 2): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM rate_limit_windows
     WHERE window_start < date_trunc('minute', now()) - (${keepWindows} * interval '1 minute')`);
  return Number(result.rowCount ?? 0);
}
