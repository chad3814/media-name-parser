import { createTmdbClient, tmdbTokenFromEnv } from '../providers/tmdb/client';
import { createTmdbProvider } from '../providers/tmdb/resolve';
import { createTpdbClient, tpdbTokenFromEnv } from '../providers/tpdb/client';
import { createTpdbProvider } from '../providers/tpdb/resolve';
import type { Provider, ProviderCallRecord } from '../providers/types';
import type { PipelineDeps, PipelineResult } from '../resolve/pipeline';
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
 * The provider wiring, built once per request.
 *
 * `drainCalls` has to be created alongside the clients, because each client
 * owns its own `recordCall` sink and the pipeline cannot reach into either.
 * Building all of them here is what keeps `provider_calls` from silently
 * staying empty. Both clients share one `pending` queue and feed it through
 * the same `recordCall`, which is safe because every `ProviderCallRecord`
 * already carries its own `provider` field.
 *
 * Each provider is constructed only when its credential is present. A
 * deployment missing `TPDB_API_KEY` must still serve `movies`/`tv` lookups,
 * and `tpdbTokenFromEnv()`/`tmdbTokenFromEnv()` both throw when their
 * variable is absent -- so the throw is caught here rather than left to
 * escape at request time. The resulting gap in `providers` is not silent: the
 * pipeline's "no provider supports <category>" branch is what a lookup for
 * that category gets instead.
 */
export function buildDeps(): PipelineDeps {
  let pending: ProviderCallRecord[] = [];
  const recordCall = (row: ProviderCallRecord): void => { pending.push(row); };

  const providers: Provider[] = [];
  try {
    const tmdbClient = createTmdbClient({ token: tmdbTokenFromEnv(), recordCall });
    providers.push(createTmdbProvider(tmdbClient));
  } catch {
    // TMDB not configured for this deployment; movies/tv lookups will find
    // no provider and resolve to `unresolved` rather than throwing.
  }
  try {
    const tpdbClient = createTpdbClient({ token: tpdbTokenFromEnv(), recordCall });
    providers.push(createTpdbProvider(tpdbClient));
  } catch {
    // TPDB not configured for this deployment; xxx lookups will find no
    // provider and resolve to `unresolved` rather than throwing.
  }

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
