# TheTVDB TV Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When TMDB cannot answer a `tv` lookup — it finds nothing, or it finds the series but not the season/episode named — resolve against TheTVDB instead.

**Architecture:** A new `tvdb` provider under `lib/providers/tvdb/`, plus a composite `createFallbackProvider(primary, secondary)` that implements the existing `Provider` interface and calls the secondary only when a pure `needsFallback(parsed, outcome)` predicate says the primary fell short. `lib/resolve/pipeline.ts` is not touched: it still selects exactly one provider.

**Tech Stack:** TypeScript (strict, no `any`/`unknown` except the immediate argument of a zod parse), zod v4, Drizzle + Postgres enums, `node:test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-20-thetvdb-fallback-design.md`

## Global Constraints

- Node >= 24. ESM (`"type": "module"`). 2-space indent, semicolons always.
- **Never** the `any` or `unknown` TypeScript type. The one permitted `unknown` is the immediate argument of a `schema.parse(...)` call, matching `lib/providers/tpdb/client.ts:141`.
- Prefer async APIs over sync twins everywhere.
- Every zod field `.nullish()` unless verified present on every sampled row (house rule, `lib/providers/tpdb/schema.ts:1-8`).
- Credentials never enter a log, a URL, or a `provider_calls` row. Record `path`, never the full URL (`lib/providers/tpdb/client.ts:118-120`).
- Base URL: `https://api4.thetvdb.com/v4`. Env var: `TVDB_API_KEY`.
- A missing `TVDB_API_KEY` is **not** an outage — tv lookups must behave exactly as today.
- Verification gate for every commit: `npm run lint && npm run typecheck && npm test && npm run build`.
- Commits are signed. If signing fails, commit with `git -c commit.gpgsign=false` and note it.

## File Structure

**Create:**
- `lib/providers/tvdb/client.ts` — login, JWT cache, bearer GETs, call recording, rate bucket, error classes.
- `lib/providers/tvdb/schema.ts` — zod for the two responses used.
- `lib/providers/tvdb/normalize.ts` — TVDB records → `ResolvedMedia` chain.
- `lib/providers/tvdb/resolve.ts` — the provider; two entry paths.
- `lib/providers/fallback.ts` — `needsFallback` + `createFallbackProvider`.
- `lib/providers/build.ts` — one shared provider factory for `envelope.ts` and `sweep.ts`.
- `test/providers/tvdb-client.test.ts`, `test/providers/tvdb-resolve.test.ts`, `test/providers/fallback.test.ts`.

**Modify:**
- `lib/providers/types.ts:15` — `ProviderName` gains `'tvdb'`.
- `lib/db/schema.ts:10` — `providerEnum` gains `'tvdb'`; generated migration under `drizzle/`.
- `lib/http/envelope.ts:90-128` and `lib/jobs/sweep.ts:195-215` — use the shared factory.
- `.env.example` — document `TVDB_API_KEY`.

---

### Task 1: Widen `ProviderName` and the `provider` enum

**Files:**
- Modify: `lib/providers/types.ts:15`
- Modify: `lib/db/schema.ts:10`
- Create: `drizzle/0004_*.sql` (generated)
- Test: `test/db/schema.test.ts` (existing, must still pass), `test/deploy/migrations.test.ts` (existing)

**Interfaces:**
- Consumes: nothing.
- Produces: `ProviderName` now includes `'tvdb'`; the Postgres `provider` enum accepts `'tvdb'`.

- [ ] **Step 1: Write the failing test**

Append to `test/db/schema.test.ts`:

```ts
test('the provider enum carries every provider the code can name', () => {
  // `ProviderName` and the Postgres enum have to agree: a provider the code
  // can construct but the column cannot store fails at write time, deep
  // inside a transaction, rather than at build time.
  const names: readonly ProviderName[] = ['tmdb', 'ibdb', 'tpdb', 'tvdb'];
  assert.deepEqual([...providerEnum.enumValues].sort(), [...names].sort());
});
```

Add `import type { ProviderName } from '../../lib/providers/types';` and make sure `providerEnum` is imported from `../../lib/db/schema`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/db/schema.test.ts`
Expected: FAIL — the enum has three values, the list has four.

- [ ] **Step 3: Make the change**

`lib/providers/types.ts:15`:

```ts
export type ProviderName = 'tmdb' | 'ibdb' | 'tpdb' | 'tvdb';
```

`lib/db/schema.ts:10`:

```ts
export const providerEnum = pgEnum('provider', ['tmdb', 'ibdb', 'tpdb', 'tvdb']);
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

Inspect the generated SQL. It must be exactly an `ALTER TYPE "public"."provider" ADD VALUE 'tvdb';`. Postgres 12+ permits that inside a transaction *as long as the new value is not used in the same transaction* — this migration only adds it, so it is safe. If Drizzle instead emits a drop-and-recreate of the type, do **not** accept it: that would rewrite every column using it. Hand-write the `ALTER TYPE` statement instead and update `drizzle/meta` via a regenerate.

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test test/db/schema.test.ts test/deploy/migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/types.ts lib/db/schema.ts drizzle test/db/schema.test.ts
git commit -m "Let the provider enum name TheTVDB"
```

---

### Task 2: `needsFallback` — the rule, with no network

**Files:**
- Create: `lib/providers/fallback.ts`
- Test: `test/providers/fallback.test.ts`

**Interfaces:**
- Consumes: `ParsedVideo` (`lib/parse/types.ts`), `ResolveOutcome` (`lib/providers/types.ts`).
- Produces: `export function needsFallback(parsed: ParsedVideo, outcome: ResolveOutcome | null): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/providers/fallback.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsFallback } from '../../lib/providers/fallback';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';
import type { MediaKind, ResolveOutcome } from '../../lib/providers/types';

function parsed(name: string): ParsedVideo {
  const result = parseVideo('tv', name);
  if (!result.ok) throw new Error(`fixture refused: ${result.refusal}`);
  return result.parsed;
}

/** Only the two fields the rule reads. */
function outcome(kind: MediaKind): ResolveOutcome {
  return {
    confidence: 0.9,
    media: { kind } as ResolveOutcome['media'],
  };
}

const EPISODE = 'Ghosts.S05E12.1080p.WEB.h264-GRP.mkv';
const SEASON = 'Ghosts.S05.1080p.WEB.h264-GRP.mkv';
const SERIES = 'Ghosts.1080p.WEB.h264-GRP.mkv';

test('no answer at all needs the fallback', () => {
  assert.equal(needsFallback(parsed(EPISODE), null), true);
  assert.equal(needsFallback(parsed(SERIES), null), true);
});

test('an answer at the depth that was asked for does not', () => {
  assert.equal(needsFallback(parsed(EPISODE), outcome('episode')), false);
  assert.equal(needsFallback(parsed(SEASON), outcome('season')), false);
  assert.equal(needsFallback(parsed(SERIES), outcome('series')), false);
});

test('a shallower answer than the filename asked for needs the fallback', () => {
  // This is the reported case: TMDB matched the series, had no such episode,
  // and returned the season instead -- `lib/providers/tmdb/resolve.ts:273`.
  assert.equal(needsFallback(parsed(EPISODE), outcome('season')), true);
  assert.equal(needsFallback(parsed(EPISODE), outcome('series')), true);
  assert.equal(needsFallback(parsed(SEASON), outcome('series')), true);
});

test('a deeper answer than asked for is not a shortfall', () => {
  assert.equal(needsFallback(parsed(SERIES), outcome('episode')), false);
});

test('a kind with no tv depth is never a shortfall', () => {
  // A movie or scene cannot be missing a season, so the depth rule must not
  // fire for them however the kinds compare.
  assert.equal(needsFallback(parsed(SERIES), outcome('movie')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: FAIL — `Cannot find module '../../lib/providers/fallback'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/providers/fallback.ts`:

```ts
import type { ParsedVideo } from '../parse/types';
import type { MediaKind, Provider, ResolveContext, ResolveOutcome } from './types';
import type { Category } from '../parse/types';
import { logFailure } from '../http/log';

/**
 * How specific a tv record is. A filename naming an episode that comes back
 * as a season has been answered at depth 2 when it asked for depth 3.
 *
 * Kinds outside this table -- `movie`, `book`, `scene` -- are absent rather
 * than zero, so `shortfall` below can tell "shallower" from "not comparable"
 * and never fires for a category that has no seasons to miss.
 */
const DEPTH: ReadonlyMap<MediaKind, number> = new Map([
  ['series', 1], ['season', 2], ['episode', 3],
]);

/**
 * Whether the primary provider fell short of the question asked.
 *
 * Pure on purpose: no network, no clock, no provider. The whole fallback rule
 * lives here so it can be read and tested in one place.
 *
 * Two cases, both from the spec. No answer at all is the obvious one. The
 * second is subtler and is the reported failure: `tmdb/resolve.ts:273`
 * returns the *season* when the episode is not on TMDB, and
 * `confidence.ts:96` docks 0.4 for the miss -- so the lookup answers a
 * shallower question than it was asked and usually lands under the floor.
 */
export function needsFallback(parsed: ParsedVideo, outcome: ResolveOutcome | null): boolean {
  if (outcome === null) return true;
  const asked = DEPTH.get(parsed.kind === 'scene' ? 'scene' : parsed.kind);
  const got = DEPTH.get(outcome.media.kind);
  if (asked === undefined || got === undefined) return false;
  return got < asked;
}
```

Note `parsed.kind` is one of `movie | series | season | episode | scene`, and `MediaKind` adds `book`. The lookup above is safe for every one of them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/fallback.ts test/providers/fallback.test.ts
git commit -m "Name the rule for when a provider fell short"
```

---

### Task 3: `createFallbackProvider` — the composite

**Files:**
- Modify: `lib/providers/fallback.ts`
- Test: `test/providers/fallback.test.ts`

**Interfaces:**
- Consumes: `needsFallback` from Task 2; `Provider`, `ResolveContext`, `ResolveOutcome`.
- Produces: `export function createFallbackProvider(primary: Provider, secondary: Provider | null): Provider`.

- [ ] **Step 1: Write the failing test**

Append to `test/providers/fallback.test.ts`:

```ts
import { createFallbackProvider } from '../../lib/providers/fallback';
import type { Provider } from '../../lib/providers/types';

const ctx = { signal: new AbortController().signal, lookupId: null };

function stub(name: 'tmdb' | 'tvdb', answer: ResolveOutcome | null | Error, calls: string[]): Provider {
  return {
    name,
    supports: (category) => category === 'tv',
    resolve: async () => {
      calls.push(name);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test('the secondary is never called when the primary answers in full', async () => {
  const calls: string[] = [];
  const provider = createFallbackProvider(
    stub('tmdb', outcome('episode'), calls), stub('tvdb', outcome('episode'), calls),
  );
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb'], 'a good answer costs nothing extra');
  assert.equal(out?.media.kind, 'episode');
});

test('the secondary answers when the primary returns nothing', async () => {
  const calls: string[] = [];
  const better = { confidence: 0.95, media: { kind: 'episode' } as ResolveOutcome['media'] };
  const provider = createFallbackProvider(stub('tmdb', null, calls), stub('tvdb', better, calls));
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb', 'tvdb']);
  assert.equal(out?.confidence, 0.95);
});

test('the primary answer survives when the secondary has nothing', async () => {
  // The fallback may only improve an answer, never destroy one.
  const calls: string[] = [];
  const shallow = outcome('season');
  const provider = createFallbackProvider(stub('tmdb', shallow, calls), stub('tvdb', null, calls));
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb', 'tvdb']);
  assert.equal(out?.media.kind, 'season', 'the shallow answer is still better than none');
});

test('the primary answer survives when the secondary throws', async () => {
  const calls: string[] = [];
  const shallow = outcome('season');
  const provider = createFallbackProvider(
    stub('tmdb', shallow, calls), stub('tvdb', new Error('tvdb exploded'), calls),
  );
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.equal(out?.media.kind, 'season');
});

test('a throwing secondary on a null primary yields null, not a throw', async () => {
  const calls: string[] = [];
  const provider = createFallbackProvider(
    stub('tmdb', null, calls), stub('tvdb', new Error('tvdb exploded'), calls),
  );
  assert.equal(await provider.resolve(parsed(EPISODE), ctx), null);
});

test('with no secondary the composite is the primary', async () => {
  // A missing TVDB_API_KEY must not be an outage.
  const calls: string[] = [];
  const provider = createFallbackProvider(stub('tmdb', outcome('season'), calls), null);
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb']);
  assert.equal(out?.media.kind, 'season');
});

test('the composite reports the primary name and support', () => {
  const provider = createFallbackProvider(stub('tmdb', null, []), stub('tvdb', null, []));
  assert.equal(provider.name, 'tmdb', 'so pipeline id-routing still finds it');
  assert.equal(provider.supports('tv'), true);
  assert.equal(provider.supports('movies'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: FAIL — `createFallbackProvider` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/providers/fallback.ts`:

```ts
/**
 * A provider that leads with `primary` and asks `secondary` only when the
 * first fell short.
 *
 * A composite rather than a chain inside `lib/resolve/pipeline.ts`: that file
 * owns the transactions, the advisory lock and the deadline, and a
 * tv-specific rule does not belong in it. The pipeline still selects exactly
 * one provider and never learns there are two.
 *
 * `name` is the primary's. That is the provider this composite leads with and
 * the one `providerForIdSource` routes to, so the pipeline's id-based
 * selection keeps working; each client records its own `provider_calls` rows,
 * so attribution stays honest either way.
 *
 * A null `secondary` is the ordinary case of an unconfigured credential, not
 * an error: the composite is then simply the primary.
 */
export function createFallbackProvider(primary: Provider, secondary: Provider | null): Provider {
  return {
    name: primary.name,
    supports(category: Category): boolean {
      return primary.supports(category);
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      const first = await primary.resolve(parsed, ctx);
      if (secondary === null || !needsFallback(parsed, first)) return first;
      try {
        // Null, not a throw: the fallback may only improve an answer. A
        // secondary that is down must not turn the primary's answer -- or an
        // honest `unresolved` -- into a 202 and a retry.
        return (await secondary.resolve(parsed, ctx)) ?? first;
      } catch (error) {
        logFailure(`fallback provider ${secondary.name} failed; keeping ${primary.name}`, error);
        return first;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/fallback.ts test/providers/fallback.test.ts
git commit -m "Let one provider stand in for another that fell short"
```

---

### Task 4: The TheTVDB client — login, token cache, GETs

**Files:**
- Create: `lib/providers/tvdb/client.ts`
- Test: `test/providers/tvdb-client.test.ts`

**Interfaces:**
- Consumes: `ProviderCallRecord`, `ResolveContext` from `lib/providers/types`; `ProviderAuthFailed` from `lib/providers/errors`.
- Produces:
  - `export class TvdbAuthFailed extends ProviderAuthFailed`
  - `export class TvdbRateLimited extends Error { readonly retryAfterSeconds: number | null }`
  - `export interface TvdbClient { get<T>(path: string, query: Record<string, string | number | undefined>, schema: ZodType<T>, ctx: ResolveContext): Promise<T | null> }`
  - `export interface TvdbOptions { readonly apiKey: string; readonly fetchImpl?: typeof fetch; readonly recordCall?: (row: ProviderCallRecord) => void; readonly ratePerSecond?: number }`
  - `export function createTvdbClient(options: TvdbOptions): TvdbClient`
  - `export function tvdbKeyFromEnv(): string`

- [ ] **Step 1: Write the failing test**

Create `test/providers/tvdb-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createTvdbClient, TvdbAuthFailed, tvdbKeyFromEnv } from '../../lib/providers/tvdb/client';
import type { ProviderCallRecord } from '../../lib/providers/types';

const ctx = { signal: new AbortController().signal, lookupId: null };
const bodySchema = z.object({ data: z.object({ id: z.number() }) });

/** A JWT-shaped string. Only the payload is ever decoded. */
function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }))
    .toString('base64url');
  return `header.${payload}.signature`;
}

interface Call { readonly url: string; readonly method: string; readonly auth: string | null }

function fakeFetch(calls: Call[], handler: (url: string) => Response): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization') });
    return handler(url);
  }) as typeof fetch;
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('the first call logs in, and the second reuses the token', async () => {
  const calls: Call[] = [];
  const token = jwt(3600);
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch(calls, (url) =>
      url.endsWith('/login') ? ok({ data: { token } }) : ok({ data: { id: 1 } })),
  });

  await client.get('/series/1', {}, bodySchema, ctx);
  await client.get('/series/2', {}, bodySchema, ctx);

  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'POST /v4/login', 'GET /v4/series/1', 'GET /v4/series/2',
  ], 'one login, then both requests');
  assert.equal(calls[1]?.auth, `Bearer ${token}`);
});

test('the credential never reaches a recorded call', async () => {
  const rows: ProviderCallRecord[] = [];
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    recordCall: (row) => rows.push(row),
    fetchImpl: fakeFetch([], (url) =>
      url.endsWith('/login') ? ok({ data: { token: jwt(3600) } }) : ok({ data: { id: 1 } })),
  });
  await client.get('/series/1', { season: 2 }, bodySchema, ctx);

  assert.equal(rows.length, 1, 'the login is infrastructure, not a provider call to report');
  assert.equal(rows[0]?.provider, 'tvdb');
  assert.equal(rows[0]?.endpoint, '/series/1', 'the path, never the query or the URL');
  const serialised = JSON.stringify(rows);
  assert.ok(!serialised.includes('secret-key'), 'no api key anywhere in the record');
  assert.ok(!serialised.includes('Bearer'), 'no token anywhere in the record');
});

test('a 401 on a data call logs in again and retries once', async () => {
  const calls: Call[] = [];
  let served401 = false;
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch(calls, (url) => {
      if (url.endsWith('/login')) return ok({ data: { token: jwt(3600) } });
      if (!served401) { served401 = true; return new Response('', { status: 401 }); }
      return ok({ data: { id: 7 } });
    }),
  });

  const out = await client.get('/series/1', {}, bodySchema, ctx);
  assert.deepEqual(out, { data: { id: 7 } });
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), [
    '/v4/login', '/v4/series/1', '/v4/login', '/v4/series/1',
  ], 'a stale token is refreshed and the call repeated exactly once');
});

test('a second 401 after a fresh token is a credential failure', async () => {
  const client = createTvdbClient({
    apiKey: 'secret-key',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch([], (url) =>
      url.endsWith('/login') ? ok({ data: { token: jwt(3600) } }) : new Response('', { status: 401 })),
  });
  await assert.rejects(
    () => client.get('/series/1', {}, bodySchema, ctx),
    (error: Error) => error instanceof TvdbAuthFailed,
  );
});

test('a rejected login is a credential failure, not a generic error', async () => {
  const client = createTvdbClient({
    apiKey: 'wrong',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch([], () => new Response('', { status: 401 })),
  });
  await assert.rejects(
    () => client.get('/series/1', {}, bodySchema, ctx),
    (error: Error) => error instanceof TvdbAuthFailed,
  );
});

test('404 is absence, not failure', async () => {
  const client = createTvdbClient({
    apiKey: 'k',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch([], (url) =>
      url.endsWith('/login') ? ok({ data: { token: jwt(3600) } }) : new Response('', { status: 404 })),
  });
  assert.equal(await client.get('/series/999999', {}, bodySchema, ctx), null);
});

test('an expired cached token is replaced before the call', async () => {
  const calls: Call[] = [];
  let issued = 0;
  const client = createTvdbClient({
    apiKey: 'k',
    ratePerSecond: 1000,
    fetchImpl: fakeFetch(calls, (url) => {
      if (url.endsWith('/login')) { issued += 1; return ok({ data: { token: jwt(issued === 1 ? -10 : 3600) } }); }
      return ok({ data: { id: 1 } });
    }),
  });
  await client.get('/series/1', {}, bodySchema, ctx);
  await client.get('/series/2', {}, bodySchema, ctx);
  assert.equal(issued, 2, 'the already-expired token is not reused');
});

test('the env reader refuses an unset key rather than calling with an empty one', () => {
  const before = process.env.TVDB_API_KEY;
  delete process.env.TVDB_API_KEY;
  try {
    assert.throws(() => tvdbKeyFromEnv(), /TVDB_API_KEY/);
  } finally {
    if (before !== undefined) process.env.TVDB_API_KEY = before;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/tvdb-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/providers/tvdb/client.ts`:

```ts
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { ProviderCallRecord, ResolveContext } from '../types';
import { ProviderAuthFailed } from '../errors';

const BASE = 'https://api4.thetvdb.com/v4';

/**
 * Seconds of headroom on a cached token.
 *
 * The token is good for 30 days, so the exact figure hardly matters; what
 * matters is never sending one that expires between the check and the
 * server reading it.
 */
const EXPIRY_SKEW_SECONDS = 60;

export class TvdbAuthFailed extends ProviderAuthFailed {
  constructor(status: number) {
    super(`TheTVDB rejected the credential (${status})`);
    this.name = 'TvdbAuthFailed';
  }
}

export class TvdbRateLimited extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super('TheTVDB rate limit reached');
    this.name = 'TvdbRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TvdbOptions {
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

export function tvdbKeyFromEnv(): string {
  const key = process.env.TVDB_API_KEY ?? '';
  if (key.length === 0) throw new Error('TVDB_API_KEY is not set');
  return key;
}

const loginSchema = z.object({ data: z.object({ token: z.string() }) });

/**
 * When a JWT expires, read from its own payload.
 *
 * Trusting the token's `exp` rather than assuming the documented 30 days:
 * the documentation is a statement about today's policy and the token is a
 * statement about this token. An unreadable payload expires immediately,
 * which costs one extra login and never sends a token the server will
 * refuse.
 */
function expiryOf(token: string): number {
  const payload = token.split('.')[1];
  if (payload === undefined) return 0;
  try {
    // The immediate argument of a zod parse: the one permitted `unknown`.
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const parsed = z.object({ exp: z.number().nullish() }).safeParse(claims);
    const exp = parsed.success ? parsed.data.exp : null;
    return exp === null || exp === undefined ? 0 : exp;
  } catch {
    return 0;
  }
}

/** Mirrors `createBucket` in the TPDB client; see its docstring for why. */
function createBucket(ratePerSecond: number) {
  let tokens = ratePerSecond;
  let last = Date.now();
  return async function take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(ratePerSecond, tokens + ((now - last) / 1000) * ratePerSecond);
      last = now;
      if (tokens >= 1) { tokens -= 1; return; }
      const waitMs = Math.ceil(((1 - tokens) / ratePerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

/**
 * TheTVDB is the only provider here that does not take a static credential:
 * `POST /login` exchanges the api key for a JWT good for 30 days. The token
 * is held in process, which on serverless means one login per cold start --
 * one extra call on an instance about to make several, and cheaper than a
 * database round trip for a credential.
 *
 * The login is deliberately not reported through `recordCall`. `provider_calls`
 * exists to show what the service asked of a catalogue on a caller's behalf,
 * and a token exchange is infrastructure rather than a lookup.
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
   * otherwise each exchange the key, and the second would overwrite the
   * first's token while it was in use.
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
        // A token good for 30 days still expires, and an instance can outlive
        // one. Refresh and repeat exactly once: a second 401 is the key.
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
      if (!response.ok) throw new Error(`TheTVDB ${path} failed with ${response.status}`);
      // The immediate argument of a zod parse: the one permitted `unknown`.
      const body: unknown = await response.json();
      return schema.parse(body);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/providers/tvdb-client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/tvdb/client.ts test/providers/tvdb-client.test.ts
git commit -m "Trade TheTVDB's api key for a token, once"
```

---

### Task 5: Schemas and normalisation

**Files:**
- Create: `lib/providers/tvdb/schema.ts`
- Create: `lib/providers/tvdb/normalize.ts`
- Test: covered by Task 6's resolver tests plus the schema-trap cases below.

**Interfaces:**
- Consumes: `ResolvedMedia` from `lib/providers/types`; `sortTitleOf` from `lib/providers/tmdb/normalize`.
- Produces:
  - `export const episodesResponseSchema` — `{ data: { series, episodes[] } }`
  - `export const searchResponseSchema` — `{ data: [{ tvdb_id, name, year, first_air_time, overview, slug }] }`
  - `export const seriesResponseSchema` — `{ data: series }`
  - `export type TvdbSeries`, `export type TvdbEpisode`, `export type TvdbSearchResult`
  - `export function normalizeSeries(series: TvdbSeries): ResolvedMedia`
  - `export function normalizeSeason(series: ResolvedMedia, seasonNumber: number): ResolvedMedia`
  - `export function normalizeEpisode(season: ResolvedMedia, episode: TvdbEpisode): ResolvedMedia`

- [ ] **Step 1: Write the failing test**

Create `test/providers/tvdb-normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesSchema, searchResultSchema } from '../../lib/providers/tvdb/schema';
import { normalizeSeries, normalizeSeason, normalizeEpisode } from '../../lib/providers/tvdb/normalize';

test('a series status is an object on a record and a string in search', () => {
  // Verified live on 2026-09-20. One shape per endpoint, and a schema that
  // accepts only one of them rejects half the API.
  const record = seriesSchema.parse({
    id: 121361, name: 'Game of Thrones', slug: 'game-of-thrones',
    firstAired: '2011-04-17', lastAired: '2019-05-19', year: '2011',
    status: { id: 2, name: 'Ended', recordType: 'series', keepUpdated: false },
  });
  assert.equal(record.status?.name, 'Ended');

  const found = searchResultSchema.parse({
    id: 'series-121361', tvdb_id: '121361', name: 'Game of Thrones',
    first_air_time: '2011-04-17', year: '2011', status: 'Ended', slug: 'game-of-thrones',
  });
  assert.equal(found.tvdb_id, '121361', 'the bare id, not the "series-" prefixed one');
});

test('the chain runs series to season to episode, all tvdb', () => {
  const series = normalizeSeries(seriesSchema.parse({
    id: 121361, name: 'Game of Thrones', slug: 'game-of-thrones',
    firstAired: '2011-04-17', lastAired: '2019-05-19', year: '2011',
    status: { name: 'Ended' }, overview: 'Seven noble families fight.',
  }));
  assert.equal(series.provider, 'tvdb');
  assert.equal(series.kind, 'series');
  assert.equal(series.providerRef, '121361');
  assert.equal(series.category, 'tv');
  assert.equal(series.year, 2011);
  assert.equal(series.details.series?.firstAirDate, '2011-04-17');
  assert.equal(series.details.series?.status, 'Ended');
  assert.deepEqual(series.externalIds, [{ source: 'tvdb', id: '121361' }]);

  const season = normalizeSeason(series, 1);
  assert.equal(season.kind, 'season');
  assert.equal(season.details.season?.seasonNumber, 1);
  assert.equal(season.parent, series);

  const episode = normalizeEpisode(season, {
    id: 3254641, seriesId: 121361, name: 'Winter Is Coming', aired: '2011-04-17',
    runtime: 62, overview: 'Eddard Stark is torn.', number: 1, seasonNumber: 1,
    absoluteNumber: 1, isMovie: 0, image: null, seasons: null,
  });
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.providerRef, '3254641');
  assert.equal(episode.title, 'Winter Is Coming');
  assert.equal(episode.details.episode?.seasonNumber, 1);
  assert.equal(episode.details.episode?.episodeNumber, 1);
  assert.equal(episode.details.episode?.airDate, '2011-04-17');
  assert.equal(episode.parent, season);
});

test('a year is read from firstAired when the year field is absent', () => {
  const series = normalizeSeries(seriesSchema.parse({
    id: 1, name: 'X', firstAired: '1999-03-31',
  }));
  assert.equal(series.year, 1999);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/tvdb-normalize.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `lib/providers/tvdb/schema.ts`**

```ts
import { z } from 'zod';

/**
 * Only the fields this slice reads. TheTVDB's records carry far more and
 * grow over time; validating the rest would make this schema start rejecting
 * valid responses the day the API adds a field. Every field is `.nullish()`
 * unless verified present on every sampled row, matching the rule in
 * `lib/providers/tpdb/schema.ts`.
 *
 * The published `swagger.yml` omits every per-record endpoint used here, so
 * these shapes were taken from live responses on 2026-09-20 rather than from
 * the specification.
 */

/**
 * A series' status. An *object* on a series record and a bare *string* in a
 * search result -- the same field, two encodings, one per endpoint. Modelled
 * separately rather than as a union so each call site states which it expects.
 */
const statusObjectSchema = z.object({ name: z.string().nullish() });

export const seriesSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullish(),
  overview: z.string().nullish(),
  firstAired: z.string().nullish(),
  lastAired: z.string().nullish(),
  /** A string on this API, not a number. */
  year: z.string().nullish(),
  status: statusObjectSchema.nullish(),
});

export const episodeSchema = z.object({
  id: z.number(),
  seriesId: z.number().nullish(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  aired: z.string().nullish(),
  runtime: z.number().nullish(),
  /** The episode number within its season. */
  number: z.number().nullish(),
  seasonNumber: z.number().nullish(),
  absoluteNumber: z.number().nullish(),
});

/**
 * `/series/{id}/episodes/{season-type}` answers with the series record *and*
 * the matching episodes, which is what lets the whole chain be built from one
 * call.
 */
export const episodesResponseSchema = z.object({
  data: z.object({
    series: seriesSchema,
    episodes: z.array(episodeSchema).default([]),
  }),
});

/**
 * A search hit. `id` is `"series-121361"`; `tvdb_id` is the bare `"121361"`
 * and is the one every other endpoint accepts.
 */
export const searchResultSchema = z.object({
  tvdb_id: z.string(),
  name: z.string(),
  slug: z.string().nullish(),
  overview: z.string().nullish(),
  first_air_time: z.string().nullish(),
  year: z.string().nullish(),
  /** A bare string here, unlike the object on a series record. */
  status: z.string().nullish(),
});

export const searchResponseSchema = z.object({
  data: z.array(searchResultSchema).default([]),
});

export type TvdbSeries = z.infer<typeof seriesSchema>;
export type TvdbEpisode = z.infer<typeof episodeSchema>;
export type TvdbSearchResult = z.infer<typeof searchResultSchema>;
```

- [ ] **Step 4: Write `lib/providers/tvdb/normalize.ts`**

```ts
import type { JsonValue, ResolvedMedia } from '../types';
import { sortTitleOf } from '../tmdb/normalize';
import type { TvdbEpisode, TvdbSeries } from './schema';

function textOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

/** `year` is a string on this API, and absent often enough to need the date. */
function yearOf(series: TvdbSeries): number | null {
  const fromYear = series.year === null || series.year === undefined
    ? Number.NaN : Number.parseInt(series.year, 10);
  if (!Number.isNaN(fromYear)) return fromYear;
  const aired = textOrNull(series.firstAired);
  if (aired === null) return null;
  const fromAired = Number.parseInt(aired.slice(0, 4), 10);
  return Number.isNaN(fromAired) ? null : fromAired;
}

export function normalizeSeries(series: TvdbSeries): ResolvedMedia {
  const ref = String(series.id);
  return {
    category: 'tv',
    kind: 'series',
    provider: 'tvdb',
    providerRef: ref,
    // Recorded so a later filename naming `{tvdb-121361}` is answered from
    // cache. The slug is not an id any endpoint here accepts, so it is not one.
    externalIds: [{ source: 'tvdb', id: ref }],
    title: series.name,
    sortTitle: sortTitleOf(series.name),
    originalTitle: null,
    releaseDate: textOrNull(series.firstAired),
    year: yearOf(series),
    overview: textOrNull(series.overview),
    raw: series as unknown as JsonValue,
    details: {
      movie: null,
      series: {
        firstAirDate: textOrNull(series.firstAired),
        lastAirDate: textOrNull(series.lastAired),
        status: textOrNull(series.status?.name),
      },
      season: null,
      episode: null,
      scene: null,
    },
    people: [],
    parent: null,
  };
}

/**
 * TheTVDB's episode flow returns no season record, so the season is
 * synthesised from the episode's own `seasonNumber` -- the same thing
 * `lib/providers/tmdb/normalize.ts` does for a TMDB season.
 *
 * The ref is compound because a season number alone is not unique across the
 * catalogue, and `media` is keyed `unique(provider, provider_ref)`.
 */
export function normalizeSeason(series: ResolvedMedia, seasonNumber: number): ResolvedMedia {
  return {
    category: 'tv',
    kind: 'season',
    provider: 'tvdb',
    providerRef: `${series.providerRef}:s${seasonNumber}`,
    externalIds: [],
    title: `${series.title} Season ${seasonNumber}`,
    sortTitle: sortTitleOf(`${series.title} Season ${seasonNumber}`),
    originalTitle: null,
    releaseDate: null,
    year: series.year,
    overview: null,
    raw: { seasonNumber } as JsonValue,
    details: {
      movie: null, series: null, season: { seasonNumber }, episode: null, scene: null,
    },
    people: [],
    parent: series,
  };
}

export function normalizeEpisode(season: ResolvedMedia, episode: TvdbEpisode): ResolvedMedia {
  const ref = String(episode.id);
  const title = textOrNull(episode.name) ?? `Episode ${episode.number ?? 0}`;
  const aired = textOrNull(episode.aired);
  return {
    category: 'tv',
    kind: 'episode',
    provider: 'tvdb',
    providerRef: ref,
    externalIds: [{ source: 'tvdb', id: ref }],
    title,
    sortTitle: sortTitleOf(title),
    originalTitle: null,
    releaseDate: aired,
    year: aired === null ? season.year : Number.parseInt(aired.slice(0, 4), 10),
    overview: textOrNull(episode.overview),
    raw: episode as unknown as JsonValue,
    details: {
      movie: null,
      series: null,
      season: null,
      episode: {
        seasonNumber: episode.seasonNumber ?? season.details.season?.seasonNumber ?? 0,
        episodeNumber: episode.number ?? 0,
        airDate: aired,
      },
      scene: null,
    },
    people: [],
    parent: season,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test test/providers/tvdb-normalize.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/tvdb/schema.ts lib/providers/tvdb/normalize.ts test/providers/tvdb-normalize.test.ts
git commit -m "Read TheTVDB's two shapes of series record"
```

---

### Task 6: The TheTVDB provider

**Files:**
- Create: `lib/providers/tvdb/resolve.ts`
- Test: `test/providers/tvdb-resolve.test.ts`

**Interfaces:**
- Consumes: `TvdbClient` (Task 4); schemas and normalisers (Task 5); `pickBest`, `titleSimilarity` from `lib/resolve/confidence`; `foldForMatch` from `lib/parse/normalize`.
- Produces: `export function createTvdbProvider(client: TvdbClient): Provider`.

- [ ] **Step 1: Write the failing test**

Create `test/providers/tvdb-resolve.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZodType } from 'zod';
import { createTvdbProvider } from '../../lib/providers/tvdb/resolve';
import type { TvdbClient } from '../../lib/providers/tvdb/client';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';

const ctx = { signal: new AbortController().signal, lookupId: null };

interface Call { readonly path: string; readonly query: Record<string, string | number | undefined> }

/** Answers by path so a test can say which endpoint holds what. */
function stubClient(calls: Call[], byPath: Readonly<Record<string, unknown>>): TvdbClient {
  return {
    async get<T>(
      path: string,
      query: Record<string, string | number | undefined>,
      schema: ZodType<T>,
    ): Promise<T | null> {
      calls.push({ path, query });
      const body = byPath[path];
      return body === undefined ? null : schema.parse(body);
    },
  };
}

function parsed(name: string): ParsedVideo {
  const result = parseVideo('tv', name);
  if (!result.ok) throw new Error(`fixture refused: ${result.refusal}`);
  return result.parsed;
}

const GOT_SERIES = {
  id: 121361, name: 'Game of Thrones', slug: 'game-of-thrones',
  firstAired: '2011-04-17', lastAired: '2019-05-19', year: '2011',
  status: { name: 'Ended' }, overview: 'Seven noble families fight.',
};
const GOT_EPISODE = {
  id: 3254641, seriesId: 121361, name: 'Winter Is Coming', aired: '2011-04-17',
  runtime: 62, overview: 'Eddard Stark is torn.', number: 1, seasonNumber: 1, absoluteNumber: 1,
};
const EPISODES_BODY = { data: { series: GOT_SERIES, episodes: [GOT_EPISODE] } };
const EPISODE_NAME = 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP.mkv';

test('it supports tv and nothing else', () => {
  const provider = createTvdbProvider(stubClient([], {}));
  assert.equal(provider.name, 'tvdb');
  assert.equal(provider.supports('tv'), true);
  assert.equal(provider.supports('movies'), false);
  assert.equal(provider.supports('xxx'), false);
  assert.equal(provider.supports('books'), false);
});

test('an inherited series id costs one call and no search', async () => {
  // TMDB already publishes the TVDB series id, so the common path never
  // guesses at a title.
  const calls: Call[] = [];
  const provider = createTvdbProvider(
    stubClient(calls, { '/series/121361/episodes/default': EPISODES_BODY }),
  );
  const out = await provider.resolve(parsed(EPISODE_NAME), { ...ctx, seriesRef: '121361' });

  assert.deepEqual(calls.map((c) => c.path), ['/series/121361/episodes/default']);
  assert.deepEqual(calls[0]?.query, { season: 1, episodeNumber: 1 });
  assert.equal(out?.media.kind, 'episode');
  assert.equal(out?.media.title, 'Winter Is Coming');
  assert.equal(out?.media.parent?.kind, 'season');
  assert.equal(out?.media.parent?.parent?.kind, 'series');
  assert.ok((out?.confidence ?? 0) >= 0.75, `should clear the floor, got ${out?.confidence}`);
});

test('with no inherited id it searches, then fetches the episode', async () => {
  const calls: Call[] = [];
  const provider = createTvdbProvider(stubClient(calls, {
    '/search': { data: [{ tvdb_id: '121361', name: 'Game of Thrones', year: '2011', first_air_time: '2011-04-17' }] },
    '/series/121361/episodes/default': EPISODES_BODY,
  }));
  const out = await provider.resolve(parsed(EPISODE_NAME), ctx);

  assert.deepEqual(calls.map((c) => c.path), ['/search', '/series/121361/episodes/default']);
  assert.deepEqual(calls[0]?.query, { query: 'Game of Thrones', type: 'series' });
  assert.equal(out?.media.title, 'Winter Is Coming');
});

test('a series with no such episode is not answered with the series', async () => {
  // The whole point of this provider is supplying an episode. Returning the
  // series instead would be the very shortfall it exists to repair.
  const provider = createTvdbProvider(stubClient([], {
    '/series/121361/episodes/default': { data: { series: GOT_SERIES, episodes: [] } },
  }));
  assert.equal(await provider.resolve(parsed(EPISODE_NAME), { ...ctx, seriesRef: '121361' }), null);
});

test('a search that matches nothing resolves to null', async () => {
  const provider = createTvdbProvider(stubClient([], { '/search': { data: [] } }));
  assert.equal(await provider.resolve(parsed(EPISODE_NAME), ctx), null);
});

test('a series whose name shares nothing with the filename is refused', async () => {
  // The same guard the TPDB provider grew this week: a row that has no
  // bearing on the filename is not a match however it was reached.
  const provider = createTvdbProvider(stubClient([], {
    '/series/999/episodes/default': {
      data: {
        series: { id: 999, name: 'Entirely Unrelated Programme', firstAired: '2011-04-17' },
        episodes: [GOT_EPISODE],
      },
    },
  }));
  const out = await provider.resolve(parsed(EPISODE_NAME), { ...ctx, seriesRef: '999' });
  assert.ok(out === null || out.confidence < 0.75,
    `nothing in common is not a match, got ${out?.confidence}`);
});

test('a season parse resolves to the season, not an episode', async () => {
  const provider = createTvdbProvider(stubClient([], {
    '/search': { data: [{ tvdb_id: '121361', name: 'Game of Thrones', year: '2011' }] },
    '/series/121361': { data: GOT_SERIES },
  }));
  const out = await provider.resolve(parsed('Game.of.Thrones.S01.1080p.WEB.h264-GRP.mkv'), ctx);
  assert.equal(out?.media.kind, 'season');
  assert.equal(out?.media.details.season?.seasonNumber, 1);
});

test('a multi-episode filename resolves the first episode it names', async () => {
  const calls: Call[] = [];
  const provider = createTvdbProvider(
    stubClient(calls, { '/series/121361/episodes/default': EPISODES_BODY }),
  );
  await provider.resolve(
    parsed('Game.of.Thrones.S01E01E02.1080p.WEB.h264-GRP.mkv'), { ...ctx, seriesRef: '121361' },
  );
  assert.equal(calls[0]?.query.episodeNumber, 1, 'the first number, as the TMDB path does');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/tvdb-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extend `ResolveContext` with the inherited ref**

In `lib/providers/types.ts`, add to `ResolveContext`:

```ts
export interface ResolveContext {
  readonly signal: AbortSignal;
  /** For `provider_calls.lookup_id`; null when resolving outside a lookup. */
  readonly lookupId: string | null;
  /**
   * A series id in this provider's own namespace, handed over by a provider
   * that resolved the series but not the episode.
   *
   * Optional, and absent for every provider but TheTVDB: the alternative was
   * a second resolve signature, and one optional field on the context both
   * providers already take is a smaller seam than a parallel interface.
   */
  readonly seriesRef?: string;
}
```

- [ ] **Step 4: Write `lib/providers/tvdb/resolve.ts`**

```ts
import type { Category, ParsedVideo } from '../../parse/types';
import type { Provider, ResolveContext, ResolveOutcome, ResolvedMedia } from '../types';
import { pickBest, titleSimilarity } from '../../resolve/confidence';
import { foldForMatch } from '../../parse/normalize';
import type { TvdbClient } from './client';
import {
  episodesResponseSchema, searchResponseSchema, seriesSchema,
  type TvdbSearchResult, type TvdbSeries,
} from './schema';
import { normalizeEpisode, normalizeSeason, normalizeSeries } from './normalize';
import { z } from 'zod';

/**
 * How alike the parsed title and the series TheTVDB returned must be for the
 * row to be believed at all.
 *
 * The same sanity guard the TPDB provider grew: a record reached by an
 * inherited id or a fuzzy search still has to have some bearing on the
 * filename. This is not "is it the right series" -- `scoreCandidate` decides
 * that -- only "is there any reason to think these are related".
 */
const MIN_SERIES_AGREEMENT = 0.30;

const seriesResponseSchema = z.object({ data: seriesSchema });

/** The aired order, which is what `SxxExx` in a filename means. */
const SEASON_TYPE = 'default';

function agrees(parsedTitle: string, name: string): boolean {
  if (foldForMatch(parsedTitle).length === 0) return false;
  return titleSimilarity(parsedTitle, name) >= MIN_SERIES_AGREEMENT;
}

/**
 * A search hit as the shared scorer sees it.
 *
 * `originCountries` is deliberately empty: TheTVDB reports a 3-letter
 * lowercase code (`usa`) while `assertedCountry` produces 2-letter uppercase,
 * so passing it through would score an encoding difference as a mismatch.
 * `popularity` and `voteCount` are zero, which contributes under 0.002 --
 * they are a tiebreak this API does not offer and the score does not need.
 */
function candidateOf(hit: TvdbSearchResult) {
  const year = hit.year === null || hit.year === undefined
    ? Number.NaN : Number.parseInt(hit.year, 10);
  const fallbackYear = hit.first_air_time === null || hit.first_air_time === undefined
    ? Number.NaN : Number.parseInt(hit.first_air_time.slice(0, 4), 10);
  const resolved = Number.isNaN(year) ? fallbackYear : year;
  return {
    title: hit.name,
    originalTitle: null,
    year: Number.isNaN(resolved) ? null : resolved,
    originCountries: [] as readonly string[],
    popularity: 0,
    voteCount: 0,
    seasonExists: null,
    episodeExists: null,
  };
}

/**
 * Re-scored once the season and episode are known to exist.
 *
 * This is the whole reason the shared scorer is reused rather than replaced
 * by bands of this provider's own: `scoreCandidate` already pays +0.12 when a
 * season *and* an episode are both confirmed, and that confirmation is
 * precisely what this provider produces.
 */
function scoreWithExistence(
  parsed: ParsedVideo, series: TvdbSeries, seasonExists: boolean, episodeExists: boolean,
): number {
  const best = pickBest(parsed, [series], (s) => ({
    title: s.name,
    originalTitle: null,
    year: normalizeSeries(s).year,
    originCountries: [] as readonly string[],
    popularity: 0,
    voteCount: 0,
    seasonExists,
    episodeExists,
  }));
  return best?.confidence ?? 0;
}

async function findSeriesRef(
  client: TvdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<string | null> {
  const list = await client.get(
    '/search', { query: parsed.title, type: 'series' }, searchResponseSchema, ctx,
  );
  if (list === null || list.data.length === 0) return null;
  const best = pickBest(parsed, list.data, candidateOf);
  if (best === null) return null;
  return agrees(parsed.title, best.item.name) ? best.item.tvdb_id : null;
}

export function createTvdbProvider(client: TvdbClient): Provider {
  return {
    name: 'tvdb',
    supports(category: Category): boolean {
      return category === 'tv';
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      ctx.signal.throwIfAborted();
      if (parsed.kind !== 'series' && parsed.kind !== 'season' && parsed.kind !== 'episode') {
        return null;
      }

      // The id a primary provider already established, else our own search.
      // TMDB publishes the TVDB series id on every series it knows, so the
      // common path costs one call and guesses at nothing.
      const ref = ctx.seriesRef ?? await findSeriesRef(client, parsed, ctx);
      if (ref === null) return null;

      if (parsed.kind === 'episode') {
        const wantedSeason = parsed.seasonNumber;
        const wantedEpisode = parsed.episodeNumbers[0];
        if (wantedSeason === null || wantedEpisode === undefined) return null;
        const body = await client.get(
          `/series/${encodeURIComponent(ref)}/episodes/${SEASON_TYPE}`,
          { season: wantedSeason, episodeNumber: wantedEpisode },
          episodesResponseSchema, ctx,
        );
        if (body === null) return null;
        const found = body.data.episodes[0];
        // No episode is a null answer, not a season: supplying the episode is
        // this provider's entire purpose, and returning its parent instead
        // would be the same shortfall it exists to repair.
        if (found === undefined) return null;
        if (!agrees(parsed.title, body.data.series.name)) return null;

        const series = normalizeSeries(body.data.series);
        const season = normalizeSeason(series, found.seasonNumber ?? wantedSeason);
        return {
          media: normalizeEpisode(season, found),
          confidence: scoreWithExistence(parsed, body.data.series, true, true),
        };
      }

      const body = await client.get(
        `/series/${encodeURIComponent(ref)}`, {}, seriesResponseSchema, ctx,
      );
      if (body === null) return null;
      if (!agrees(parsed.title, body.data.name)) return null;
      const series = normalizeSeries(body.data);
      const media: ResolvedMedia = parsed.kind === 'season'
        ? normalizeSeason(series, parsed.seasonNumber)
        : series;
      return {
        media,
        confidence: scoreWithExistence(parsed, body.data, parsed.kind === 'season', false),
      };
    },
  };
}
```

Note on the last `scoreWithExistence` call: for a series parse both flags are
false-ish, which costs the `episodeExists === false` penalty. That is wrong for
a parse that never named an episode. Use `null` for a flag the parse did not
assert — adjust the helper signature to `boolean | null` and pass
`parsed.kind === 'episode' ? true : null` for `episodeExists`, and
`parsed.kind === 'series' ? null : true` for `seasonExists`, matching how
`lib/providers/tmdb/resolve.ts:267` passes `null` for a non-episode parse.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test test/providers/tvdb-resolve.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/tvdb/resolve.ts lib/providers/types.ts test/providers/tvdb-resolve.test.ts
git commit -m "Resolve a tv episode against TheTVDB"
```

---

### Task 7: One provider factory, wired for tv

**Files:**
- Create: `lib/providers/build.ts`
- Modify: `lib/http/envelope.ts:90-128`
- Modify: `lib/jobs/sweep.ts:195-215`
- Modify: `.env.example`
- Test: `test/providers/build.test.ts` (new); `test/http/lookup-routes.test.ts`, `test/jobs/sweep.test.ts` (existing, must still pass)

**Interfaces:**
- Consumes: `createFallbackProvider` (Task 3), `createTvdbProvider` (Task 6), the existing tmdb/tpdb factories.
- Produces: `export function buildProvider(name: ProviderName, recordCall: (row: ProviderCallRecord) => void): Provider`.

- [ ] **Step 1: Write the failing test**

Create `test/providers/build.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProvider } from '../../lib/providers/build';

function withEnv(vars: Readonly<Record<string, string | undefined>>, run: () => void): void {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    run();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('tmdb is wrapped so TheTVDB can stand in for it', () => {
  withEnv({ TMDB_READ_ACCESS_TOKEN: 'tmdb-token', TVDB_API_KEY: 'tvdb-key' }, () => {
    const provider = buildProvider('tmdb', () => {});
    assert.equal(provider.name, 'tmdb', 'the composite still answers to the primary name');
    assert.equal(provider.supports('tv'), true);
  });
});

test('a missing TheTVDB key is not an outage', () => {
  // The tv category must keep working exactly as it did before this provider
  // existed. Only a missing *primary* credential may raise.
  withEnv({ TMDB_READ_ACCESS_TOKEN: 'tmdb-token', TVDB_API_KEY: undefined }, () => {
    const provider = buildProvider('tmdb', () => {});
    assert.equal(provider.name, 'tmdb');
    assert.equal(provider.supports('tv'), true);
  });
});

test('a missing primary credential still raises', () => {
  withEnv({ TMDB_READ_ACCESS_TOKEN: undefined, TVDB_API_KEY: 'tvdb-key' }, () => {
    assert.throws(() => buildProvider('tmdb', () => {}), /TMDB/i);
  });
});

test('tpdb is built bare, with no fallback', () => {
  withEnv({ TPDB_API_KEY: 'tpdb-key' }, () => {
    const provider = buildProvider('tpdb', () => {});
    assert.equal(provider.name, 'tpdb');
    assert.equal(provider.supports('xxx'), true);
    assert.equal(provider.supports('tv'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/build.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/providers/build.ts`**

```ts
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
 * Builds one provider by name.
 *
 * `lib/http/envelope.ts` and `lib/jobs/sweep.ts` each had their own copy of a
 * `category === 'xxx' ? tpdb : tmdb` ternary. Two copies of a routing rule is
 * a rule that drifts -- the same reasoning `lib/providers/routing.ts` already
 * records -- and a third provider does not fit the shape of a ternary at all.
 *
 * TMDB comes back wrapped: TheTVDB stands in for it when it finds no series,
 * or finds the series but not the season or episode the filename named.
 */
export function buildProvider(
  name: ProviderName,
  recordCall: (row: ProviderCallRecord) => void,
): Provider {
  if (name === 'tpdb') {
    return createTpdbProvider(createTpdbClient({ token: tpdbTokenFromEnv(), recordCall }));
  }
  if (name === 'tvdb') {
    return createTvdbProvider(createTvdbClient({ apiKey: tvdbKeyFromEnv(), recordCall }));
  }
  // `ibdb` has no implementation; it resolves here as TMDB would have before,
  // which is what `providerFor` already guarantees never happens -- `books`
  // routes to null.
  const tmdb = createTmdbProvider(createTmdbClient({ token: tmdbTokenFromEnv(), recordCall }));
  return createFallbackProvider(tmdb, tvdbOrNull(recordCall));
}

/**
 * The fallback's credential is optional in a way the primary's is not. A
 * deployment with no TheTVDB key resolves tv exactly as it did before this
 * provider existed; logged rather than swallowed, because "not configured"
 * and "configured wrongly" look identical from here.
 */
function tvdbOrNull(recordCall: (row: ProviderCallRecord) => void): Provider | null {
  try {
    return createTvdbProvider(createTvdbClient({ apiKey: tvdbKeyFromEnv(), recordCall }));
  } catch (error) {
    logFailure('TheTVDB is unavailable; tv falls back to TMDB alone', error);
    return null;
  }
}
```

- [ ] **Step 4: Point both call sites at it**

In `lib/http/envelope.ts`, delete the local `build` closure (lines ~94-96) and
the now-unused provider imports, and use the shared factory:

```ts
import { buildProvider } from '../providers/build';
// ...
const build = (name: ProviderName): Provider => buildProvider(name, recordCall);
```

In `lib/jobs/sweep.ts`, replace the equivalent ternary (lines ~198-202) the same
way. Keep both files' surrounding comments about strict-versus-best-effort
construction: that logic is unchanged and still correct.

- [ ] **Step 5: Add the env var**

In `.env.example`, after the TPDB block:

```
# --- thetvdb.com, a fallback for the tv category ---------------------------
# Optional. Without it, tv resolves through TMDB alone exactly as before.
# With it, a filename naming a season or episode TMDB does not have -- or a
# series TMDB cannot find -- gets a second opinion. This is the v4 api key;
# the service exchanges it for a 30-day token itself.
TVDB_API_KEY=
```

- [ ] **Step 6: Run the tests**

Run: `npx tsx --test test/providers/build.test.ts test/http/lookup-routes.test.ts test/jobs/sweep.test.ts`
Expected: PASS. If a route test asserts on the number of providers built, update it to expect the composite, not two entries.

- [ ] **Step 7: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/build.ts lib/http/envelope.ts lib/jobs/sweep.ts .env.example test/providers/build.test.ts
git commit -m "Build every provider in one place"
```

---

### Task 8: Hand the inherited series id across the seam

**Files:**
- Modify: `lib/providers/fallback.ts`
- Test: `test/providers/fallback.test.ts`

**Interfaces:**
- Consumes: `ResolveContext.seriesRef` (Task 6).
- Produces: the composite passes TMDB's TVDB series id to the secondary.

- [ ] **Step 1: Write the failing test**

Append to `test/providers/fallback.test.ts`:

```ts
test('the tvdb id TMDB published is handed to the fallback', async () => {
  // This is what makes the common path exact: TMDB already knows the TVDB
  // series id, so the fallback never has to search for the series.
  let seenRef: string | undefined;
  const withIds = {
    confidence: 0.5,
    media: {
      kind: 'season',
      externalIds: [{ source: 'tvdb', id: '121361' }],
      parent: null,
    } as unknown as ResolveOutcome['media'],
  };
  const primary: Provider = {
    name: 'tmdb', supports: () => true, resolve: async () => withIds,
  };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async (_parsed, ctx) => { seenRef = ctx.seriesRef; return null; },
  };
  await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);
  assert.equal(seenRef, '121361');
});

test('the id is found on an ancestor when the match is a season', async () => {
  // TMDB records external ids on the series, and the shortfall case returns
  // the season -- so the id lives on the parent, not the returned node.
  let seenRef: string | undefined;
  const series = { kind: 'series', externalIds: [{ source: 'tvdb', id: '77' }], parent: null };
  const season = { kind: 'season', externalIds: [], parent: series };
  const primary: Provider = {
    name: 'tmdb',
    supports: () => true,
    resolve: async () => ({ confidence: 0.5, media: season as unknown as ResolveOutcome['media'] }),
  };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async (_parsed, ctx) => { seenRef = ctx.seriesRef; return null; },
  };
  await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);
  assert.equal(seenRef, '77');
});

test('no tvdb id means the fallback searches for itself', async () => {
  let seenRef: string | undefined = 'unset';
  const primary: Provider = { name: 'tmdb', supports: () => true, resolve: async () => null };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async (_parsed, ctx) => { seenRef = ctx.seriesRef; return null; },
  };
  await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);
  assert.equal(seenRef, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: FAIL — `seenRef` is `undefined` in the first two tests.

- [ ] **Step 3: Write the implementation**

Add to `lib/providers/fallback.ts`:

```ts
import type { ResolvedMedia } from './types';

/**
 * The TVDB series id the primary already published, if it did.
 *
 * TMDB records it on the *series* node (`tmdb/normalize.ts:113`), and the
 * shortfall case returns a season, so the chain is walked upward rather than
 * only the returned node inspected.
 */
function inheritedSeriesRef(media: ResolvedMedia | null): string | undefined {
  for (let node = media; node !== null; node = node.parent) {
    const found = node.externalIds.find((id) => id.source === 'tvdb');
    if (found !== undefined) return found.id;
  }
  return undefined;
}
```

and in `resolve`, replace the secondary call:

```ts
      try {
        const seriesRef = inheritedSeriesRef(first?.media ?? null);
        const handover = seriesRef === undefined ? ctx : { ...ctx, seriesRef };
        return (await secondary.resolve(parsed, handover)) ?? first;
      } catch (error) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/fallback.ts test/providers/fallback.test.ts
git commit -m "Hand the fallback the series id TMDB already knew"
```

---

### Task 9: Verify against the live API

**Files:**
- No production changes expected. If one is needed, add a test for it first.

- [ ] **Step 1: Write a throwaway probe**

Create `.tmp/verify.ts` (the directory is untracked; delete it afterwards).
Resolve a set of real names through `buildProvider('tmdb', () => {})` with a
real `TVDB_API_KEY` and `TMDB_READ_ACCESS_TOKEN` loaded from `.env.local`:

1. A series and episode TMDB has — must resolve through TMDB, unchanged, with
   TheTVDB never called.
2. A series TMDB has whose episode it lacks — must resolve to the episode, via
   TheTVDB, above the floor.
3. A series TMDB cannot find at all that TheTVDB has.
4. A nonsense name — must resolve to nothing, not to a wrong series.

Run: `node --env-file-if-exists=.env.local --import tsx .tmp/verify.ts`

- [ ] **Step 2: Confirm the no-credential path**

Run the same probe with `TVDB_API_KEY` unset. Every tv name must resolve
exactly as it did before this branch, and the log must carry one
"TheTVDB is unavailable" line rather than an exception.

- [ ] **Step 3: Record what was found**

If any case disagrees with the spec's success criteria, stop and fix it with a
test first — do not adjust the criteria.

- [ ] **Step 4: Clean up and commit any fixes**

```bash
rm -rf .tmp
npm run lint && npm run typecheck && npm test && npm run build
```

---

## Self-Review

**Spec coverage.** Problem and both triggers → Task 2. Composite architecture
→ Task 3. API auth and token cache → Task 4. The two endpoints and both schema
traps → Task 5. Both entry paths, the keystone inherited id, the confidence
reuse and the sanity guard → Tasks 6 and 8. The `provider` enum → Task 1.
Shared factory, `.env.example`, optional credential → Task 7. Failure and
degradation → Tasks 3 and 7. Testing and success criteria → every task plus
Task 9. Out-of-scope items (movies, absolute ordering, `{tvdb-}` re-routing,
corroboration) have no tasks, correctly.

**Placeholders.** None: every code step carries the code, every test step the
assertions, every run step the command and expected result.

**Type consistency.** `createTvdbClient(options: TvdbOptions)` takes `apiKey`
throughout (Tasks 4, 7) — not `token`, which is what the tmdb and tpdb clients
take, because this one exchanges a key rather than sending a token.
`ResolveContext.seriesRef` is declared in Task 6 and consumed in Task 8.
`buildProvider(name, recordCall)` has one signature, used in Tasks 7 and 9.
`needsFallback(parsed, outcome)` and `createFallbackProvider(primary,
secondary)` are stable across Tasks 2, 3 and 8. `normalizeSeason(series,
seasonNumber)` takes the already-normalised parent in both Task 5 and Task 6.

One correction folded in at Task 6, Step 4: the naive
`scoreWithExistence(parsed, series, false, false)` for a series parse would pay
the `episodeExists === false` penalty for an episode the filename never named.
The note there changes the flags to `boolean | null` and passes `null` for an
unasserted one, matching `lib/providers/tmdb/resolve.ts:267`.
