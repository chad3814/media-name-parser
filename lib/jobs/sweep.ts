import { withTransaction } from '../db/client';
import { envInt } from '../env';
import { pruneRateWindows } from '../auth/rateLimit';
import { logFailure } from '../http/log';
import { createTmdbClient, tmdbTokenFromEnv } from '../providers/tmdb/client';
import { createTmdbProvider } from '../providers/tmdb/resolve';
import type { ProviderCallRecord } from '../providers/types';
import { resolveLookup } from '../resolve/pipeline';
import { pruneProviderCalls } from '../resolve/persist';
import { CONFIDENCE_FLOOR } from '../resolve/confidence';
import { decide, readLookup } from '../cache/lookup';
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
  readonly prunedProviderCalls: number;
}

/**
 * Jobs claimed per sweep.
 *
 * Six, not twenty-five. The cron fires every minute and each job may spend up
 * to `LOOKUP_DEADLINE_MS` (8s by default), so twenty-five was up to 200
 * seconds of sequential work in one invocation -- past the route's
 * `maxDuration`. The lease reaper makes an interrupted sweep recoverable
 * rather than destructive, but a reclaim still counts as an attempt, so a job
 * repeatedly at the tail of an over-long sweep could reach `abandoned`
 * carrying a stale error. Six is a worst case near 48 seconds, inside the
 * route's 60, and at once a minute the queue still drains far faster than any
 * plausible fill rate.
 */
const DEFAULT_LIMIT = envInt('SWEEP_LIMIT', 6);

/** How one job ended, in the vocabulary the report counts. */
type JobResult = 'done' | 'retried' | 'abandoned';

/**
 * One claimed job, start to settled.
 *
 * Everything that can throw lives inside the `try`, the client construction
 * included. `tmdbTokenFromEnv()` used to sit in the loop outside it, so a
 * missing or misnamed credential threw past the settle: the first sweep claimed
 * up to 25 jobs, died on the first, and left all 25 rows in `running` -- which,
 * before `claimDue` grew a lease reaper, meant permanently invisible.
 */
interface SharedProvider {
  readonly client: ReturnType<typeof createTmdbClient>;
  readonly drain: () => readonly ProviderCallRecord[];
}

async function runJob(
  job: ClaimedJob,
  deps: SweepDeps,
  /** Built once per sweep and shared across jobs. See `sweep`. */
  client: () => SharedProvider,
): Promise<JobResult> {
  const category = job.category;

  try {
    // Nothing left to do is the common case worth checking for: the
    // `waitUntil` continuation usually finishes the lookup in the original
    // invocation, and re-resolving an answer that already exists is a provider
    // call spent to overwrite a good row with the same value -- or, if the
    // retry blows its own deadline, with nulls. `decide` is asked rather than
    // the state column directly, so "there is nothing to attempt" means
    // exactly what it means on the request path, pinned rows included.
    const current = await withTransaction(async (tx) => readLookup(tx, category, job.name));
    if (decide(current, deps.now(), CONFIDENCE_FLOOR).kind === 'fresh') {
      await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'done' }));
      return 'done';
    }

    // One client, and therefore one token bucket, for the whole sweep. A
    // fresh bucket per job enforced nothing -- every job got a full
    // allowance, and what actually bounded provider load was the sequential
    // loop and the network round trip. That stops being true the moment
    // anyone parallelises this loop, and a limiter that works only by
    // accident is worse than none.
    const shared = client();
    const pipelineDeps = {
      providers: [createTmdbProvider(shared.client)],
      now: deps.now,
      drainCalls: shared.drain,
    };

    // `force: true`: this job's lookup row just had `last_attempt_at` set
    // to now (either by the original blown-deadline write or by a previous
    // sweep's retry), so `decide()` would return `cooling` and serve the
    // stale row without ever calling the provider -- which would make
    // every sweep a no-op that backs off and eventually abandons the job
    // having never retried anything.
    const result = await resolveLookup(
      { category, name: job.name },
      pipelineDeps,
      { force: true },
    );

    // Read off the result, not off a caught error: the pipeline catches every
    // provider failure and reports it as `pending`, so a `TmdbAuthFailed`
    // never reaches the `catch` below. The spec wants a rejected credential
    // abandoned on the first attempt so the sweeper does not grind against it.
    if (result.terminal) {
      await withTransaction(async (tx) => settle(tx, job.jobId, {
        kind: 'abandon', error: result.refusal ?? 'the provider rejected the credential',
      }));
      return 'abandoned';
    }
    // `pending` still means unfinished, so it is a retry rather than a
    // success -- otherwise a job that keeps timing out would be deleted and
    // silently forgotten.
    if (result.state === 'pending') {
      await withTransaction(async (tx) => settle(tx, job.jobId, {
        kind: 'retry', error: result.refusal ?? 'still incomplete',
      }));
      return 'retried';
    }
    await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'done' }));
    return 'done';
  } catch (error) {
    // Whatever reaches here is not a provider outcome -- those arrive on the
    // result -- but something structural: an unreachable database, or a
    // credential missing from the environment. Both are worth another attempt,
    // and `JOB_MAX_ATTEMPTS` bounds how many.
    const message = error instanceof Error ? error.message : String(error);
    await withTransaction(async (tx) => settle(tx, job.jobId, {
      kind: 'retry', error: message,
    }));
    return 'retried';
  }
}

/**
 * Runs whatever is due.
 *
 * Deliberately small. The 12-hour staleness rule already retries anything
 * anyone asks about twice, so this exists only for the filename nobody asks
 * about again -- a safety net rather than the main road. If it ever needs to be
 * cleverer than claim-run-settle, the freshness rule has stopped working and
 * that is the thing to fix.
 *
 * Each job is settled in its own transaction, and each is run behind its own
 * guard. One poisonous job must not roll back the successes claimed alongside
 * it, and must not abort the jobs claimed after it either -- everything claimed
 * in this invocation holds a lease, so anything left unsettled is invisible
 * until that lease expires.
 */
export async function sweep(
  deps: SweepDeps, options: { readonly limit?: number } = {},
): Promise<SweepReport> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const claimed: readonly ClaimedJob[] = limit === 0
    ? []
    : await withTransaction(async (tx) => claimDue(tx, limit, deps.workerId));

  // Lazily, not up front: `tmdbTokenFromEnv()` throws when no token is
  // configured, and that throw must land inside a job's own try -- settling
  // that job -- rather than aborting the loop and stranding every job claimed
  // alongside it.
  let built: SharedProvider | null = null;
  const sharedProvider = (): SharedProvider => {
    if (built === null) {
      let pending: ProviderCallRecord[] = [];
      built = {
        client: createTmdbClient({
          token: tmdbTokenFromEnv(),
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          recordCall: (row) => { pending.push(row); },
        }),
        drain: (): readonly ProviderCallRecord[] => {
          const out = pending;
          pending = [];
          return out;
        },
      };
    }
    return built;
  };

  let done = 0;
  let retried = 0;
  let abandoned = 0;

  for (const job of claimed) {
    let outcome: JobResult;
    try {
      outcome = await runJob(job, deps, sharedProvider);
    } catch (error) {
      // `runJob` settles its own failures, so reaching here means the settle
      // itself failed -- the database went away mid-sweep. The row keeps its
      // lease and `claimDue` will reclaim it once that expires, which is what
      // makes counting it a retry true rather than convenient.
      logFailure(`sweep job ${job.jobId}`, error);
      outcome = 'retried';
    }
    if (outcome === 'done') done += 1;
    else if (outcome === 'abandoned') abandoned += 1;
    else retried += 1;
  }

  // One transaction for both prunes: they are the same housekeeping and there
  // is nothing to gain from letting one commit while the other rolls back.
  const pruned = await withTransaction(async (tx) => ({
    rateWindows: await pruneRateWindows(tx),
    providerCalls: await pruneProviderCalls(tx),
  }));
  return {
    claimed: claimed.length,
    done,
    retried,
    abandoned,
    prunedRateWindows: pruned.rateWindows,
    prunedProviderCalls: pruned.providerCalls,
  };
}
