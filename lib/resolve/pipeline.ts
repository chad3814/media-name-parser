import { advisoryLock, withTransaction } from '../db/client';
import { normalizeKey } from '../parse/normalize';
import { parseVideo } from '../parse/video';
import type { Category, ParsedVideo } from '../parse/types';
import type { JsonValue, Provider, ProviderCallRecord } from '../providers/types';
import { ProviderAuthFailed } from '../providers/errors';
import { CONFIDENCE_FLOOR } from './confidence';
import { persistResolved, recordProviderCalls } from './persist';
import {
  decide, findResolvedSibling, readLookup, recordHit, upsertParse, writeLookupOutcome,
  type LookupState,
} from '../cache/lookup';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

export const LOOKUP_DEADLINE_MS = envNumber('LOOKUP_DEADLINE_MS', 8000);

export interface PipelineDeps {
  readonly provider: Provider;
  readonly now: () => Date;
  /**
   * Hands back the calls the provider made since the last drain, so they can
   * be written inside the same transaction as the result.
   *
   * This has to be injected. The provider owns its client, the client owns the
   * `recordCall` sink, and the pipeline can see neither -- so without a drain
   * `provider_calls` is never written at all, which is a silent hole in the
   * only observability the spec asks for.
   */
  readonly drainCalls?: () => readonly ProviderCallRecord[];
}

export interface LookupRequest {
  readonly category: Category;
  readonly name: string;
}

export interface PipelineResult {
  readonly state: LookupState;
  readonly lookupId: string;
  readonly confidence: number | null;
  readonly mediaId: string | null;
  readonly parsed: ParsedVideo | null;
  readonly refusal: string | null;
  readonly cached: boolean;
  readonly partial: boolean;
  /**
   * The failure will fail identically on every retry, so there is no point
   * attempting it again -- a rejected credential, principally.
   *
   * This exists because the catch below flattens every provider error into a
   * `pending` result, which is right for the request path (a 202, never a
   * throw) and destroys the one thing the sweeper needs to know. The spec
   * requires a provider auth failure to go straight to `abandoned` "so the
   * sweeper does not grind against a bad key"; without a field on the result
   * the class never crosses the seam and the sweeper burns all six attempts.
   */
  readonly terminal: boolean;
}

export interface PipelineOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Ignore the cooling window -- and nothing else.
   *
   * For queue-driven retries only. The sweeper and the waitUntil continuation
   * both run moments after a `pending` write set `last_attempt_at = now()`,
   * so `decide()` returns `cooling` and they would never call out -- which
   * would make the durable-retry path a no-op.
   *
   * Narrowly scoped on purpose. `decide()` makes three other judgements --
   * a pinned row is never re-resolved, a stale parser version forces a
   * re-parse, an already-complete row is served as-is -- and every one of
   * them is still true for a queue-driven retry. Skipping the whole decision
   * meant a job whose lookup had since been resolved re-ran the entire
   * provider resolution, and a pinned row was re-resolved against the spec.
   */
  readonly force?: boolean;
}

/**
 * One lookup, start to finish.
 *
 * The early returns matter: a `fresh` or `cooling` decision must not take the
 * advisory lock, because a cache hit that contends with anything defeats the
 * purpose of caching. Sibling adoption is checked before the lock too -- it is
 * one indexed read, and it skips the provider entirely for a second spelling
 * of a release already resolved.
 */
export async function resolveLookup(
  request: LookupRequest,
  deps: PipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const { category, name } = request;
  const normalizedKey = normalizeKey(name);

  const existing = await withTransaction(async (tx) => readLookup(tx, category, name));
  const force = options.force === true;

  const decision = decide(existing, deps.now(), CONFIDENCE_FLOOR);
  // `force` drops only the `cooling` arm, because that is the only judgement a
  // queue-driven retry knows better than `decide()` does: it runs moments
  // after a `pending` write set `last_attempt_at = now()`, so serving the
  // stale row would make the durable-retry path a no-op. `fresh` still stands
  // -- a pinned row, or one another worker has since resolved, has nothing
  // left to attempt.
  if (decision.kind === 'fresh' || (decision.kind === 'cooling' && !force)) {
    const row = decision.lookup;
    await withTransaction(async (tx) => recordHit(tx, row.id));
    return {
      state: row.state,
      lookupId: row.id,
      confidence: row.confidence,
      mediaId: row.mediaId,
      parsed: null,
      refusal: null,
      cached: true,
      partial: decision.kind === 'cooling' && row.state !== 'resolved',
      terminal: false,
    };
  }

  const parse = parseVideo(category, name);
  if (!parse.ok) {
    // A refusal is a real answer and is cached like any other, so the same
    // sidecar file asked about twice costs one parse.
    const lookupId = await withTransaction(async (tx) => {
      await upsertParse(tx, category, normalizedKey, { refusal: parse.refusal });
      return writeLookupOutcome(tx, {
        category, name, normalizedKey, mediaId: null, confidence: null, state: 'unresolved',
      });
    });
    return {
      state: 'unresolved', lookupId, confidence: null, mediaId: null,
      parsed: null, refusal: parse.refusal, cached: false, partial: false,
      terminal: false,
    };
  }

  const parsed = parse.parsed;

  // Adopt a sibling before spending anything on the provider.
  const adopted = await withTransaction(async (tx) => {
    // The second permitted `unknown`: a ParsedVideo is structurally JSON, but
    // TypeScript cannot see that through the discriminated union.
    await upsertParse(tx, category, normalizedKey, parsed as unknown as JsonValue);
    const sibling = await findResolvedSibling(tx, category, normalizedKey, existing?.id ?? null);
    if (sibling === null) return null;
    const lookupId = await writeLookupOutcome(tx, {
      category, name, normalizedKey,
      mediaId: sibling.mediaId, confidence: sibling.confidence, state: 'resolved',
    });
    return { lookupId, sibling };
  });
  if (adopted !== null) {
    return {
      state: 'resolved', lookupId: adopted.lookupId,
      confidence: adopted.sibling.confidence, mediaId: adopted.sibling.mediaId,
      parsed, refusal: null, cached: true, partial: false, terminal: false,
    };
  }

  if (!deps.provider.supports(category)) {
    const lookupId = await withTransaction(async (tx) => writeLookupOutcome(tx, {
      category, name, normalizedKey, mediaId: null, confidence: null, state: 'unresolved',
    }));
    return {
      state: 'unresolved', lookupId, confidence: null, mediaId: null,
      parsed, refusal: `no provider supports ${category}`, cached: false, partial: false,
      terminal: false,
    };
  }

  const deadlineMs = options.deadlineMs ?? LOOKUP_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  if (options.signal !== undefined) {
    // Check before subscribing: an already-aborted signal fires no further
    // `abort` event, so a listener alone would ignore it completely and the
    // lookup would run to completion after the caller had given up.
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const outcome = await deps.provider.resolve(parsed, {
      signal: controller.signal,
      lookupId: existing?.id ?? null,
    });

    const written = await withTransaction(async (tx) => {
      // Serialises the *write* for one release, nothing more: the provider
      // call above has already happened by the time this lock is taken, so two
      // concurrent misses still make two sets of provider calls. The spec asks
      // for the lock to prevent that duplicate call (Request flow 5.3), and
      // that is not implemented -- holding a transaction-scoped lock across an
      // 8-second provider call would pin a database connection for the
      // duration, which is a trade the design has not made. Recorded as debt
      // rather than described as done. Correctness does not depend on either
      // reading: every write below is an upsert on a natural key.
      await advisoryLock(tx, `${category}:${normalizedKey}`);
      const mediaId = outcome === null ? null : await persistResolved(tx, outcome.media);
      const confidence = outcome === null ? null : outcome.confidence;
      // Below the floor is a real answer worth keeping: the row is inspectable
      // and the 12-hour rule will retry it. It is simply not `resolved`.
      const state: LookupState =
        mediaId !== null && confidence !== null && confidence >= CONFIDENCE_FLOOR
          ? 'resolved'
          : 'unresolved';
      const lookupId = await writeLookupOutcome(tx, {
        category, name, normalizedKey, mediaId, confidence, state,
      });
      const calls = deps.drainCalls?.() ?? [];
      if (calls.length > 0) await recordProviderCalls(tx, calls);
      return { lookupId, mediaId, confidence, state };
    });

    return {
      state: written.state, lookupId: written.lookupId,
      confidence: written.confidence, mediaId: written.mediaId,
      parsed, refusal: null, cached: false, partial: false, terminal: false,
    };
  } catch (error) {
    // A blown deadline is not a failure of the request: the parse is real and
    // worth returning, and the row stays incomplete so the 12-hour rule or the
    // sweeper will finish the job.
    const lookupId = await withTransaction(async (tx) => writeLookupOutcome(tx, {
      category, name, normalizedKey, mediaId: null, confidence: null, state: 'pending',
    }));
    const aborted = controller.signal.aborted;
    return {
      state: 'pending', lookupId, confidence: null, mediaId: null, parsed,
      refusal: aborted ? null : String(error instanceof Error ? error.message : error),
      cached: false, partial: true,
      // The catch stays -- the request path must answer 202, not throw -- but
      // terminality has to survive it, or the sweeper cannot tell a bad
      // credential from a slow network.
      terminal: error instanceof ProviderAuthFailed,
    };
  } finally {
    clearTimeout(timer);
  }
}
