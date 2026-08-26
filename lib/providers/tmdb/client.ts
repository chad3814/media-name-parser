import type { ZodType } from 'zod';
import type { ProviderCallRecord, ResolveContext } from '../types';

const BASE = 'https://api.themoviedb.org/3';

export class TmdbAuthFailed extends Error {
  constructor(status: number) {
    super(`TMDB rejected the credential (${status})`);
    this.name = 'TmdbAuthFailed';
  }
}

export class TmdbRateLimited extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super('TMDB rate limit reached');
    this.name = 'TmdbRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TmdbOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly recordCall?: (row: ProviderCallRecord) => void;
  /** Requests per second. TMDB documents "around 40" and does not guarantee it. */
  readonly ratePerSecond?: number;
}

export interface TmdbClient {
  get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: ZodType<T>,
    ctx: ResolveContext,
  ): Promise<T | null>;
}

/**
 * The credential, from either name.
 *
 * `TMDB_READ_ACCESS_TOKEN` is what the spec calls for, but the value in use is
 * stored as `TMDB_API_KEY` -- which is a misleading name for it: this is a v4
 * Read Access Token (a JWT) and belongs in an Authorization header, not in an
 * `api_key` query parameter. Accepting both names avoids a rename; the comment
 * exists so nobody "fixes" it by passing it as a query parameter and earning a
 * 401.
 */
export function tmdbTokenFromEnv(): string {
  const token = process.env.TMDB_READ_ACCESS_TOKEN ?? process.env.TMDB_API_KEY ?? '';
  if (token.length === 0) {
    throw new Error('neither TMDB_READ_ACCESS_TOKEN nor TMDB_API_KEY is set');
  }
  return token;
}

/**
 * A token bucket, in-process and deliberately so. The advisory lock already
 * prevents two concurrent resolutions of the same release, and TMDB's limit is
 * per-account rather than per-instance, so a distributed limiter would be
 * machinery bought for a problem that has not appeared. A 429 is still handled
 * as a real outcome, because "we should not hit it" is not "we cannot".
 */
function createBucket(ratePerSecond: number) {
  let tokens = ratePerSecond;
  let last = Date.now();
  return async function take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(ratePerSecond, tokens + ((now - last) / 1000) * ratePerSecond);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - tokens) / ratePerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

export function createTmdbClient(options: TmdbOptions): TmdbClient {
  const doFetch = options.fetchImpl ?? fetch;
  const record = options.recordCall ?? ((): void => {});
  const take = createBucket(options.ratePerSecond ?? 30);

  return {
    async get<T>(
      path: string,
      query: Record<string, string | number | undefined>,
      schema: ZodType<T>,
      ctx: ResolveContext,
    ): Promise<T | null> {
      // Check first: an already-cancelled request should cost nothing.
      ctx.signal.throwIfAborted();
      await take();
      ctx.signal.throwIfAborted();

      const url = new URL(`${BASE}${path}`);
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }

      const started = Date.now();
      const response = await doFetch(url, {
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
        },
        signal: ctx.signal,
      });
      // `path`, not `url`: the credential is in a header and never in the URL,
      // but recording the path alone also keeps query values out of the log.
      record({
        provider: 'tmdb',
        endpoint: path,
        status: response.status,
        durationMs: Date.now() - started,
        lookupId: ctx.lookupId,
      });

      if (response.status === 404) return null;
      if (response.status === 401 || response.status === 403) {
        throw new TmdbAuthFailed(response.status);
      }
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? null : Number.parseInt(header, 10);
        throw new TmdbRateLimited(seconds !== null && Number.isNaN(seconds) ? null : seconds);
      }
      if (!response.ok) {
        throw new Error(`TMDB ${path} failed with ${response.status}`);
      }
      // The immediate argument of a zod parse: the one permitted `unknown`.
      const body: unknown = await response.json();
      return schema.parse(body);
    },
  };
}
