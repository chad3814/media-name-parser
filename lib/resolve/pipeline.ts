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
import { envInt } from '../env';


export const LOOKUP_DEADLINE_MS = envInt('LOOKUP_DEADLINE_MS', 8000);

export interface PipelineDeps {
  readonly providers: readonly Provider[];
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
  /** Set only when this request did the parsing. */
  readonly parsed: ParsedVideo | null;
  /**
   * The parse already on record, when this request served a cached row.
   *
   * Deliberately not typed as `ParsedVideo`: a refused lookup stores
   * `{ refusal }` rather than a parse, so casting the column to `ParsedVideo`
   * would be a lie the type system could not catch. The HTTP envelope treats
   * it as opaque JSON, which is what it is.
   *
   * `unknown` here is the deserialization exception: passed through, never
   * read field by field.
   */
  readonly cachedParse: Readonly<Record<string, unknown>> | null;
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
      cachedParse: row.tokens,
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
      parsed: null, cachedParse: null, refusal: parse.refusal, cached: false, partial: false,
      terminal: false,
    };
  }

  const parsed = parse.parsed;

  // Claim the work before spending anything on the provider.
  //
  // This is the double-checked pattern the spec's step 5.3 is really asking
  // for: check, lock, check again, act. The first `readLookup` above is
  // unlocked and therefore only advisory -- two concurrent misses can both
  // pass it. Inside the lock the row is re-read, so exactly one of them
  // proceeds to call the provider and the others see what it wrote.
  //
  // The lock is transaction-scoped, so it is released when this short
  // transaction commits -- before the provider call, not across it. Holding it
  // across an eight-second HTTP call would pin a pooled connection for the
  // duration and cap concurrency at the pool size. What serialises the
  // provider call is the in-flight marker this writes, not the lock itself:
  // a request arriving afterwards reads a `pending` row with a fresh
  // `last_attempt_at`, decides `cooling`, and returns without calling out.
  const claim = await withTransaction(async (tx) => {
    await advisoryLock(tx, `${category}:${normalizedKey}`);

    // The second permitted `unknown`: a ParsedVideo is structurally JSON, but
    // TypeScript cannot see that through the discriminated union.
    await upsertParse(tx, category, normalizedKey, parsed as unknown as JsonValue);

    // Re-read under the lock. Someone may have resolved this, or claimed it,
    // between the unlocked read and here.
    const current = await readLookup(tx, category, name);
    const recheck = decide(current, deps.now(), CONFIDENCE_FLOOR);
    if (current !== null && (recheck.kind === 'fresh' || (recheck.kind === 'cooling' && !force))) {
      return { kind: 'yield' as const, row: current, cooling: recheck.kind === 'cooling' };
    }

    const sibling = await findResolvedSibling(tx, category, normalizedKey, current?.id ?? null);
    if (sibling !== null) {
      const lookupId = await writeLookupOutcome(tx, {
        category, name, normalizedKey,
        mediaId: sibling.mediaId, confidence: sibling.confidence, state: 'resolved',
      });
      return { kind: 'adopted' as const, lookupId, sibling };
    }

    // The in-flight marker. `state: 'pending'` with `last_attempt_at = now()`
    // is exactly what `decide` reads as "someone is working on this".
    const lookupId = await writeLookupOutcome(tx, {
      category, name, normalizedKey, mediaId: null, confidence: null, state: 'pending',
    });
    return { kind: 'claimed' as const, lookupId };
  });

  if (claim.kind === 'yield') {
    // Another caller got here first. Serve what they have written rather than
    // duplicating their provider calls.
    return {
      state: claim.row.state,
      lookupId: claim.row.id,
      confidence: claim.row.confidence,
      mediaId: claim.row.mediaId,
      parsed: null,
      cachedParse: claim.row.tokens,
      refusal: null,
      cached: true,
      partial: claim.cooling && claim.row.state !== 'resolved',
      terminal: false,
    };
  }

  if (claim.kind === 'adopted') {
    return {
      state: 'resolved', lookupId: claim.lookupId,
      confidence: claim.sibling.confidence, mediaId: claim.sibling.mediaId,
      parsed, cachedParse: null, refusal: null, cached: true, partial: false, terminal: false,
    };
  }

  const provider = deps.providers.find((p) => p.supports(category)) ?? null;
  if (provider === null) {
    const lookupId = await withTransaction(async (tx) => writeLookupOutcome(tx, {
      category, name, normalizedKey, mediaId: null, confidence: null, state: 'unresolved',
    }));
    return {
      state: 'unresolved', lookupId, confidence: null, mediaId: null,
      parsed, cachedParse: null, refusal: `no provider supports ${category}`, cached: false, partial: false,
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
    const outcome = await provider.resolve(parsed, {
      signal: controller.signal,
      lookupId: existing?.id ?? null,
    });

    const written = await withTransaction(async (tx) => {
      // Serialises the write for one release. The duplicate provider call the
      // spec's step 5.3 is concerned with is prevented earlier, by the
      // in-flight claim above -- not by this lock, which is taken after the
      // provider has already answered. Kept because it costs one cheap
      // statement and makes concurrent writers queue rather than interleave.
      // Correctness does not depend on it either way: every write below is an
      // upsert on a natural key.
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
      parsed, cachedParse: null, refusal: null, cached: false, partial: false, terminal: false,
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
      state: 'pending', lookupId, confidence: null, mediaId: null, parsed, cachedParse: null,
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
