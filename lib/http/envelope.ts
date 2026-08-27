import { createTmdbClient, tmdbTokenFromEnv } from '../providers/tmdb/client';
import { createTmdbProvider } from '../providers/tmdb/resolve';
import type { ProviderCallRecord } from '../providers/types';
import type { PipelineDeps, PipelineResult } from '../resolve/pipeline';
import type { MediaView } from '../media/read';

export interface LookupEnvelope {
  readonly lookupId: string;
  readonly state: 'resolved' | 'unresolved' | 'pending';
  readonly partial: boolean;
  readonly cached: boolean;
  readonly confidence: number | null;
  readonly refusal: string | null;
  /** The tokens this request derived. Null on a cache hit: nothing was parsed. */
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
    parsed: result.parsed === null
      ? null
      : (result.parsed as unknown as Readonly<Record<string, unknown>>),
    media,
  };
}

/**
 * The provider wiring, built once per request.
 *
 * `drainCalls` has to be created alongside the client, because the client owns
 * the `recordCall` sink and the pipeline cannot reach into it. Building both
 * here is what keeps `provider_calls` from silently staying empty.
 */
export function buildTmdbDeps(): PipelineDeps {
  let pending: ProviderCallRecord[] = [];
  const client = createTmdbClient({
    token: tmdbTokenFromEnv(),
    recordCall: (row) => { pending.push(row); },
  });
  return {
    provider: createTmdbProvider(client),
    now: () => new Date(),
    drainCalls: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}
