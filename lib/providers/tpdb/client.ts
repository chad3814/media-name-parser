import type { ZodType } from 'zod';
import type { ProviderCallRecord, ResolveContext } from '../types';
import { ProviderAuthFailed } from '../errors';

const BASE = 'https://api.theporndb.net';

/**
 * Extends `ProviderAuthFailed` rather than `Error` so the pipeline and the
 * sweeper can recognise "not retryable" without importing anything TPDB.
 */
export class TpdbAuthFailed extends ProviderAuthFailed {
  constructor(status: number) {
    super(`TPDB rejected the credential (${status})`);
    this.name = 'TpdbAuthFailed';
  }
}

export interface TpdbOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly recordCall?: (row: ProviderCallRecord) => void;
  /** Requests per second. TPDB publishes no limit; this is a courtesy default. */
  readonly ratePerSecond?: number;
}

export interface TpdbClient {
  get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: ZodType<T>,
    ctx: ResolveContext,
  ): Promise<T | null>;
}

/** Reads the credential from the environment. */
export function tpdbTokenFromEnv(): string {
  const token = process.env.TPDB_API_KEY ?? '';
  if (token.length === 0) {
    throw new Error('TPDB_API_KEY is not set');
  }
  return token;
}

/**
 * A token bucket, in-process and deliberately so. The advisory lock already
 * prevents two concurrent resolutions of the same release, and any real
 * quota TPDB enforces is per-account rather than per-instance, so a
 * distributed limiter would be machinery bought for a problem that has not
 * appeared. TPDB publishes no rate limit at all; this bucket exists purely
 * as a courtesy to their API and a caller can raise it via `ratePerSecond`.
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

export function createTpdbClient(options: TpdbOptions): TpdbClient {
  const doFetch = options.fetchImpl ?? fetch;
  const record = options.recordCall ?? ((): void => {});
  const take = createBucket(options.ratePerSecond ?? 5);

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
        provider: 'tpdb',
        endpoint: path,
        status: response.status,
        durationMs: Date.now() - started,
        lookupId: ctx.lookupId,
      });

      if (response.status === 404) return null;
      if (response.status === 401 || response.status === 403) {
        throw new TpdbAuthFailed(response.status);
      }
      if (!response.ok) {
        throw new Error(`TPDB ${path} failed with ${response.status}`);
      }
      // The immediate argument of a zod parse: the one permitted `unknown`.
      const body: unknown = await response.json();
      return schema.parse(body);
    },
  };
}
