import { createTmdbClient, tmdbTokenFromEnv } from '../providers/tmdb/client';
import { createTmdbProvider } from '../providers/tmdb/resolve';
import { createTpdbClient, tpdbTokenFromEnv } from '../providers/tpdb/client';
import { createTpdbProvider } from '../providers/tpdb/resolve';
import type { Provider, ProviderCallRecord } from '../providers/types';
import type { PipelineDeps, PipelineResult } from '../resolve/pipeline';
import type { Category } from '../parse/types';
import type { MediaView } from '../media/read';

export interface LookupEnvelope {
  readonly lookupId: string;
  readonly state: 'resolved' | 'unresolved' | 'pending';
  readonly partial: boolean;
  readonly cached: boolean;
  readonly confidence: number | null;
  readonly refusal: string | null;
  /**
   * The parse behind this answer, whether this request derived it or read it
   * from the cache.
   *
   * The spec says `GET /v1/lookup/{id}` returns "the same envelope" as a POST,
   * and a consumer aggregating a parse rate over responses would otherwise
   * score every cached row as unparsed. For a refused lookup this is the
   * stored `{ refusal }` record rather than a parse, which is why the type is
   * opaque JSON rather than `ParsedVideo`.
   */
  readonly parsed: Readonly<Record<string, unknown>> | null;
  readonly media: MediaView | null;
}

export function toEnvelope(result: PipelineResult, media: MediaView | null): LookupEnvelope {
  return {
    lookupId: result.lookupId,
    state: result.state,
    partial: result.partial,
    cached: result.cached,
    confidence: result.confidence,
    refusal: result.refusal,
    // `unknown` here is the structural exception: the parse is serialised
    // wholesale into the response and never read field by field.
    // A fresh parse when this request made one, the stored parse otherwise.
    // `unknown` here is the structural exception: the value is serialised into
    // the response wholesale and never read field by field.
    parsed: result.parsed === null
      ? result.cachedParse
      : (result.parsed as unknown as Readonly<Record<string, unknown>>),
    media,
  };
}

/**
 * The provider wiring for one category's lookup.
 *
 * `drainCalls` has to be created alongside the client, because the client
 * owns its own `recordCall` sink and the pipeline cannot reach into it.
 * Building it here is what keeps `provider_calls` from silently staying empty.
 *
 * Per category and on demand, mirroring `lib/jobs/sweep.ts`. Building both
 * providers up front and catching the throw when a credential was absent
 * turned a missing `TMDB_API_KEY` into a `movies` lookup that took the
 * pipeline's "no provider supports movies" branch: `unresolved` written with a
 * fresh `last_attempt_at`, so every request for the next twelve hours was
 * served the cooling answer -- HTTP 202, `partial: true`, no refusal, and
 * nothing logged. A server that cannot serve a category must say so. Nothing
 * is caught here; the throw lands in `handleLookup`'s own try, which logs it
 * and answers 503.
 *
 * Splitting it per category is what stops one missing credential stranding the
 * other category: an `xxx` lookup on a deployment with no TPDB key throws,
 * and a `movies` lookup on that same deployment does not.
 */
export function buildDeps(category: Category): PipelineDeps {
  let pending: ProviderCallRecord[] = [];
  const recordCall = (row: ProviderCallRecord): void => { pending.push(row); };

  const providers: readonly Provider[] = category === 'xxx'
    ? [createTpdbProvider(createTpdbClient({ token: tpdbTokenFromEnv(), recordCall }))]
    : [createTmdbProvider(createTmdbClient({ token: tmdbTokenFromEnv(), recordCall }))];

  return {
    providers,
    now: () => new Date(),
    drainCalls: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}
