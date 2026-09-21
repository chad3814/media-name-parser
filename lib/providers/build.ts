import type { Provider, ProviderCallRecord, ProviderName } from './types';
import { createTmdbProvider } from './tmdb/resolve';
import { createTmdbClient, tmdbTokenFromEnv } from './tmdb/client';
import { createTpdbProvider } from './tpdb/resolve';
import { createTpdbClient, tpdbTokenFromEnv } from './tpdb/client';
import { createTvdbProvider } from './tvdb/resolve';
import { createTvdbClient, tvdbKeyFromEnv } from './tvdb/client';
import { createFallbackProvider } from './fallback';
import { logFailure } from '../http/log';

/**
 * The fallback's credential is optional in a way the primary's is not.
 *
 * A deployment with no TheTVDB key resolves tv exactly as it did before this
 * provider existed. Logged rather than swallowed, because "not configured"
 * and "configured wrongly" look identical from here -- the same reasoning
 * `lib/http/envelope.ts` already applies to its optional providers.
 */
function tvdbOrNull(
  recordCall: (row: ProviderCallRecord) => void, fetchImpl?: typeof fetch,
): Provider | null {
  try {
    return createTvdbProvider(createTvdbClient({
      apiKey: tvdbKeyFromEnv(), recordCall, ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }));
  } catch (error) {
    logFailure('TheTVDB is unavailable; tv falls back to TMDB alone', error);
    return null;
  }
}

/**
 * Builds one provider by name.
 *
 * `lib/http/envelope.ts` and `lib/jobs/sweep.ts` each carried their own copy
 * of a `category === 'xxx' ? tpdb : tmdb` ternary. Two copies of a routing
 * rule is a rule that drifts -- the reasoning `lib/providers/routing.ts`
 * already records for its own table -- and a third provider does not fit the
 * shape of a ternary at all.
 *
 * TMDB comes back wrapped: TheTVDB stands in for it when it finds no series,
 * or finds the series but not the season or episode the filename named.
 * Every other provider is built bare.
 *
 * A missing credential throws, and must: the caller distinguishes a category
 * with no provider (answer `unresolved`) from a provider with no credential
 * (answer 503), and swallowing the second here would strand every lookup on
 * a cooling `unresolved` row for twelve hours.
 */
export function buildProvider(
  name: ProviderName,
  recordCall: (row: ProviderCallRecord) => void,
  /** The sweeper substitutes a fetch so a whole sweep can run offline. */
  fetchImpl?: typeof fetch,
): Provider {
  const override = fetchImpl === undefined ? {} : { fetchImpl };
  if (name === 'tpdb') {
    return createTpdbProvider(createTpdbClient({
      token: tpdbTokenFromEnv(), ...override, recordCall,
    }));
  }
  if (name === 'tvdb') {
    return createTvdbProvider(createTvdbClient({
      apiKey: tvdbKeyFromEnv(), ...override, recordCall,
    }));
  }
  // `ibdb` has no implementation and is unreachable: `providerFor` routes
  // `books` to null rather than here. It falls in with TMDB rather than
  // throwing, because a name that cannot arrive needs no branch of its own.
  const tmdb = createTmdbProvider(createTmdbClient({
    token: tmdbTokenFromEnv(), ...override, recordCall,
  }));
  return createFallbackProvider(tmdb, tvdbOrNull(recordCall, fetchImpl));
}
