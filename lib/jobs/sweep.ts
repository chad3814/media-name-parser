import { withTransaction } from '../db/client';
import { pruneRateWindows } from '../auth/rateLimit';
import { createTmdbClient, TmdbAuthFailed, tmdbTokenFromEnv } from '../providers/tmdb/client';
import { createTmdbProvider } from '../providers/tmdb/resolve';
import type { ProviderCallRecord } from '../providers/types';
import { resolveLookup } from '../resolve/pipeline';
import type { Category } from '../parse/types';
import { claimDue, settle, type ClaimedJob } from './queue';

export interface SweepDeps {
  /** Injected so tests serve recorded fixtures instead of the network. */
  readonly fetchImpl?: typeof fetch;
  readonly workerId: string;
  readonly now: () => Date;
}

export interface SweepReport {
  readonly claimed: number;
  readonly done: number;
  readonly retried: number;
  readonly abandoned: number;
  readonly prunedRateWindows: number;
}

const DEFAULT_LIMIT = 25;

/**
 * Runs whatever is due.
 *
 * Deliberately small. The 12-hour staleness rule already retries anything
 * anyone asks about twice, so this exists only for the filename nobody asks
 * about again -- a safety net rather than the main road. If it ever needs to be
 * cleverer than claim-run-settle, the freshness rule has stopped working and
 * that is the thing to fix.
 *
 * Each job is settled in its own transaction. One poisonous job must not roll
 * back the successes claimed alongside it.
 */
export async function sweep(
  deps: SweepDeps, options: { readonly limit?: number } = {},
): Promise<SweepReport> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const claimed: readonly ClaimedJob[] = limit === 0
    ? []
    : await withTransaction(async (tx) => claimDue(tx, limit, deps.workerId));

  let done = 0;
  let retried = 0;
  let abandoned = 0;

  for (const job of claimed) {
    let pending: ProviderCallRecord[] = [];
    const client = createTmdbClient({
      token: tmdbTokenFromEnv(),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      recordCall: (row) => { pending.push(row); },
    });
    const pipelineDeps = {
      provider: createTmdbProvider(client),
      now: deps.now,
      drainCalls: (): readonly ProviderCallRecord[] => {
        const out = pending;
        pending = [];
        return out;
      },
    };

    try {
      const result = await resolveLookup(
        { category: job.category as Category, name: job.name },
        pipelineDeps,
      );
      // `pending` still means unfinished, so it is a retry rather than a
      // success -- otherwise a job that keeps timing out would be deleted and
      // silently forgotten.
      if (result.state === 'pending') {
        await withTransaction(async (tx) => settle(tx, job.jobId, {
          kind: 'retry', error: result.refusal ?? 'still incomplete',
        }));
        retried += 1;
      } else {
        await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'done' }));
        done += 1;
      }
    } catch (error) {
      // A bad credential will fail identically every time, so retrying it just
      // burns attempts and fills the log. It is terminal.
      const terminal = error instanceof TmdbAuthFailed;
      const message = error instanceof Error ? error.message : String(error);
      await withTransaction(async (tx) => settle(tx, job.jobId, terminal
        ? { kind: 'abandon', error: message }
        : { kind: 'retry', error: message }));
      if (terminal) abandoned += 1;
      else retried += 1;
    }
  }

  const prunedRateWindows = await withTransaction(async (tx) => pruneRateWindows(tx));
  return { claimed: claimed.length, done, retried, abandoned, prunedRateWindows };
}
