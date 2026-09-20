import { z, type ZodType } from 'zod';
import type { ProviderCallRecord, ResolveContext } from '../types';
import { ProviderAuthFailed } from '../errors';

const BASE = 'https://api4.thetvdb.com/v4';

/**
 * Seconds of headroom on a cached token.
 *
 * The token is good for 30 days, so the exact figure hardly matters; what
 * matters is never sending one that expires between the check here and the
 * server reading it.
 */
const EXPIRY_SKEW_SECONDS = 60;

/**
 * Extends `ProviderAuthFailed` rather than `Error` so the pipeline and the
 * sweeper can recognise "not retryable" without importing anything TheTVDB.
 */
export class TvdbAuthFailed extends ProviderAuthFailed {
  constructor(status: number) {
    super(`TheTVDB rejected the credential (${status})`);
    this.name = 'TvdbAuthFailed';
  }
}

/** A 429, with the wait the API asked for when it named one. Mirrors TPDB's. */
export class TvdbRateLimited extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super('TheTVDB rate limit reached');
    this.name = 'TvdbRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TvdbOptions {
  /**
   * The v4 api key. Named `apiKey` rather than `token` -- unlike the TMDB and
   * TPDB clients, this one does not send what it is given: it exchanges it.
   */
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly recordCall?: (row: ProviderCallRecord) => void;
  /** Requests per second. TheTVDB publishes no limit; this is a courtesy. */
  readonly ratePerSecond?: number;
}

export interface TvdbClient {
  get<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    schema: ZodType<T>,
    ctx: ResolveContext,
  ): Promise<T | null>;
}

/** Reads the credential from the environment. */
export function tvdbKeyFromEnv(): string {
  const key = process.env.TVDB_API_KEY ?? '';
  if (key.length === 0) {
    throw new Error('TVDB_API_KEY is not set');
  }
  return key;
}

const loginSchema = z.object({ data: z.object({ token: z.string() }) });
const claimsSchema = z.object({ exp: z.number().nullish() });

/**
 * When a JWT expires, read from its own payload.
 *
 * Trusting the token's `exp` rather than assuming the documented 30 days: the
 * documentation states today's policy, the token states this token. An
 * unreadable payload expires immediately, which costs one extra login and
 * never sends a token the server will refuse.
 */
function expiryOf(token: string): number {
  const payload = token.split('.')[1];
  if (payload === undefined) return 0;
  try {
    // The immediate argument of a zod parse: the one permitted `unknown`.
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const parsed = claimsSchema.safeParse(claims);
    const exp = parsed.success ? parsed.data.exp : null;
    return exp === null || exp === undefined ? 0 : exp;
  } catch {
    return 0;
  }
}

/** A token bucket, in-process. See `lib/providers/tpdb/client.ts` for why. */
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
      await new Promise((resolve) => { setTimeout(resolve, waitMs); });
    }
  };
}

/**
 * TheTVDB is the only provider here that does not take a static credential:
 * `POST /login` exchanges the api key for a JWT good for 30 days.
 *
 * The token is held in process, which on serverless means one login per cold
 * start -- one extra call on an instance about to make several, and cheaper
 * than a database round trip for a credential. Persisting it is a possible
 * later optimisation, not a requirement.
 *
 * The login is deliberately not reported through `recordCall`.
 * `provider_calls` exists to show what this service asked of a catalogue on a
 * caller's behalf, and a token exchange is infrastructure rather than a
 * lookup; counting it would make every cold start look like an extra query
 * against someone's quota.
 */
export function createTvdbClient(options: TvdbOptions): TvdbClient {
  const doFetch = options.fetchImpl ?? fetch;
  const record = options.recordCall ?? ((): void => {});
  const take = createBucket(options.ratePerSecond ?? 5);

  let token: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<string> | null = null;

  async function login(ctx: ResolveContext): Promise<string> {
    ctx.signal.throwIfAborted();
    const response = await doFetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ apikey: options.apiKey }),
      signal: ctx.signal,
    });
    if (!response.ok) throw new TvdbAuthFailed(response.status);
    // The immediate argument of a zod parse: the one permitted `unknown`.
    const body: unknown = await response.json();
    const fresh = loginSchema.parse(body).data.token;
    token = fresh;
    expiresAt = expiryOf(fresh);
    return fresh;
  }

  /**
   * One login at a time. Two concurrent resolutions on a cold instance would
   * otherwise each exchange the key, and the second would replace the first's
   * token while it was still in use.
   */
  async function authorize(ctx: ResolveContext, force: boolean): Promise<string> {
    const fresh = Date.now() / 1000 + EXPIRY_SKEW_SECONDS < expiresAt;
    if (!force && token !== null && fresh) return token;
    inFlight ??= login(ctx).finally(() => { inFlight = null; });
    return inFlight;
  }

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

      const send = async (bearer: string): Promise<Response> => {
        const started = Date.now();
        const response = await doFetch(url, {
          headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
          signal: ctx.signal,
        });
        // `path`, not `url`: the credential rides in a header and never in
        // the URL, but recording the path alone also keeps query values out.
        record({
          provider: 'tvdb',
          endpoint: path,
          status: response.status,
          durationMs: Date.now() - started,
          lookupId: ctx.lookupId,
        });
        return response;
      };

      let response = await send(await authorize(ctx, false));
      if (response.status === 401) {
        // A token good for 30 days still expires, and a long-lived instance
        // can outlive one. Refresh and repeat exactly once; a second 401 is
        // the key itself, not the token.
        response = await send(await authorize(ctx, true));
      }

      if (response.status === 404) return null;
      if (response.status === 401 || response.status === 403) {
        throw new TvdbAuthFailed(response.status);
      }
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header === null ? null : Number.parseInt(header, 10);
        throw new TvdbRateLimited(seconds !== null && Number.isNaN(seconds) ? null : seconds);
      }
      if (!response.ok) {
        throw new Error(`TheTVDB ${path} failed with ${response.status}`);
      }
      // The immediate argument of a zod parse: the one permitted `unknown`.
      const body: unknown = await response.json();
      return schema.parse(body);
    },
  };
}
