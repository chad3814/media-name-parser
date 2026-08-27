import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { JOB_MAX_ATTEMPTS, nextDelayMs } from './backoff';

export interface ClaimedJob {
  readonly jobId: string;
  readonly lookupId: string;
  readonly category: string;
  readonly name: string;
  readonly attempts: number;
}

export type JobOutcome =
  /** Finished. The row is deleted; `lookups` is the record of the outcome. */
  | { readonly kind: 'done' }
  /** Failed but worth another go. */
  | { readonly kind: 'retry'; readonly error: string }
  /** Failed terminally -- a bad credential, or out of attempts. */
  | { readonly kind: 'abandon'; readonly error: string };

/**
 * Marks a lookup as needing more work.
 *
 * Idempotent on `lookup_id`, which has a unique index: a lookup that blows its
 * deadline twice has one job, not two. Re-enqueueing resets the schedule
 * without resetting `attempts`, so a repeatedly-slow lookup still backs off.
 */
export async function enqueue(tx: Tx, lookupId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO lookup_jobs (lookup_id, state, next_attempt_at)
    VALUES (${lookupId}::uuid, 'pending', now())
    ON CONFLICT (lookup_id) DO UPDATE
      SET state = 'pending', next_attempt_at = now(), updated_at = now()`);
}

/**
 * Takes ownership of up to `limit` due jobs.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two concurrent sweeps safe: the second
 * one steps over rows the first has locked instead of blocking on them or
 * double-running them. This must be inside a transaction, which is why the
 * whole service uses the WebSocket driver.
 */
export async function claimDue(
  tx: Tx, limit: number, workerId: string,
): Promise<readonly ClaimedJob[]> {
  const result = await tx.execute(sql`
    WITH due AS (
      SELECT j.id FROM lookup_jobs j
       WHERE j.state = 'pending' AND j.next_attempt_at <= now()
       ORDER BY j.next_attempt_at
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
    )
    UPDATE lookup_jobs j
       SET state = 'running', locked_at = now(), locked_by = ${workerId},
           attempts = j.attempts + 1, updated_at = now()
      FROM due, lookups l
     WHERE j.id = due.id AND l.id = j.lookup_id
    RETURNING j.id AS job_id, j.lookup_id, j.attempts, l.category, l.name`);
  return result.rows.map((row) => ({
    jobId: String(row.job_id),
    lookupId: String(row.lookup_id),
    category: String(row.category),
    name: String(row.name),
    attempts: Number(row.attempts),
  }));
}

export async function settle(tx: Tx, jobId: string, outcome: JobOutcome): Promise<void> {
  if (outcome.kind === 'done') {
    // Deleted rather than marked done: `lookups` already records the outcome,
    // and a second copy is a second thing that can disagree with it.
    await tx.execute(sql`DELETE FROM lookup_jobs WHERE id = ${jobId}::uuid`);
    return;
  }

  if (outcome.kind === 'abandon') {
    await tx.execute(sql`
      UPDATE lookup_jobs
         SET state = 'abandoned', last_error = ${outcome.error},
             locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid`);
    return;
  }

  const current = await tx.execute(sql`
    SELECT attempts FROM lookup_jobs WHERE id = ${jobId}::uuid`);
  const attempts = Number(current.rows[0]?.attempts ?? 0);
  if (attempts >= JOB_MAX_ATTEMPTS) {
    await tx.execute(sql`
      UPDATE lookup_jobs
         SET state = 'abandoned',
             last_error = ${`${outcome.error} (gave up after ${attempts} attempts)`},
             locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid`);
    return;
  }
  const delay = nextDelayMs(attempts);
  await tx.execute(sql`
    UPDATE lookup_jobs
       SET state = 'pending', last_error = ${outcome.error},
           next_attempt_at = now() + (${delay} * interval '1 millisecond'),
           locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = ${jobId}::uuid`);
}
