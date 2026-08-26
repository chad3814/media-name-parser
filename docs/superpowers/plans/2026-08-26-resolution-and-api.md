# Resolution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the parsed tokens Plan 1 produces into resolved TMDB media stored in Neon, and expose the whole thing as the cached lookup API the spec describes.

**Architecture:** A provider returns a provider-agnostic `ResolvedMedia` tree and never touches the database; a separate persistence module writes that tree inside one transaction; a pipeline composes parse → cache check → provider → persist under a deadline. Confidence is a pure function so the judgement calls are unit-testable without a network or a database.

**Tech Stack:** Node 26, Next.js 16.3.3 (App Router), TypeScript 7.0.2, Drizzle ORM 0.45.2 over `drizzle-orm/neon-serverless` (WebSocket, **not** HTTP), zod 4.4.3, oxlint 1.80.0, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`

**Plan sequence:** Plan 2 of 4. Plan 1 (`docs/superpowers/plans/2026-08-25-foundation-and-parser.md`) is complete and merged: it delivered the scaffold, the full schema, and the tv/movies parser. This plan delivers a working resolver callable from tests, with no HTTP at all. Plan 3 adds the API surface, API-key auth, rate limiting, and the job sweeper. Plan 4 adds Better Auth sign-in, the four UI pages, and the admin guard.

**Why the split.** The original Plan 2 covered resolution *and* the API in twelve tasks. Eight of those produce something independently valuable — a resolver with real fixtures, cache semantics, and transactional persistence — and the remaining four are all about HTTP. Splitting means the engine gets reviewed before anything is exposed.

## Global Constraints

- **Node >= 26.** ESM only (`"type": "module"`). No `require`.
- **No `any`.** oxlint sets `typescript/no-explicit-any` to `error`.
- **`unknown` only at a deserialization boundary**, with a comment naming which exception it is: the immediate argument of a zod `.parse()` call, or a schema field compared structurally rather than read. Everything arriving from TMDB goes through a zod schema and is used via the inferred type.
- **No TypeScript enums, namespaces, or parameter properties** (`erasableSyntaxOnly: true`). Use `const` objects plus union types, or Drizzle's `pgEnum`.
- **`exactOptionalPropertyTypes: true`.** Prefer `field: T | null` over `field?: T`.
- **`noUncheckedIndexedAccess: true`.** `array[i]` is `T | undefined`; narrow before use.
- **2-space indentation, semicolons always.** `readonly` on interface fields and array types for all value objects.
- **Prefer the async form of any API.** No `*Sync` calls in request paths.
- **Never log a credential.** The TMDB bearer, `DATABASE_URL`, and API-key secrets never reach a log line, an error message, or `provider_calls.endpoint`.
- **Verification gate.** No task is complete until `npm run check` passes (`lint && typecheck && test`). The final task additionally requires `npm run build`.
- **Commit at the end of each task. Never push.**
- **Corpus is read-only.** `fixtures/corpus/*.raw.txt` is committed input data.
- **Offline tests.** No test may reach the network. TMDB responses come from recorded fixtures under `fixtures/tmdb/`.

---

## Three corrections this plan makes to Plan 1 and the spec

Recorded here because each was verified against the real thing, not assumed.

1. **The database driver changes.** Plan 1 shipped `lib/db/client.ts` on
   `drizzle-orm/neon-http`. That driver throws
   `No transactions support in neon-http driver`, and this plan needs
   transactions in three places: `pg_advisory_xact_lock` (transaction-scoped by
   definition), the sweeper's `FOR UPDATE SKIP LOCKED`, and the media upsert,
   which must not half-succeed. Task 1 replaces it with
   `drizzle-orm/neon-serverless` over a `Pool`. Confirmed working on Node 26
   with the platform's native `WebSocket` and no `ws` shim, including genuine
   contention: a second transaction blocked on the advisory lock until the
   first committed.
2. **Episode resolution is three provider calls, not four.**
   `tv/{id}/season/{n}` returns every episode in the season already carrying
   its own `crew` and `guest_stars`, so the separate episode-credits request
   the spec described is unnecessary.
3. **TMDB auth is a bearer token.** The v4 API Read Access Token in an
   `Authorization: Bearer` header is what TMDB documents as the default and
   what works across v3 and v4. `.env.example` now names
   `TMDB_READ_ACCESS_TOKEN`, not `TMDB_API_KEY`.

**Before starting, confirm which credential is on hand.** If only a v3
`api_key` is available, the client in Task 2 needs a query parameter instead of
a header. Everything else is unaffected. Do not guess — the failure mode is a
`401` on every call.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/db/client.ts` | **modified** — `Pool` + `neon-serverless`, `getDb()`, `withTransaction()` |
| `lib/providers/types.ts` | `Provider`, `ResolvedMedia`, `ResolvedPerson` — provider-agnostic |
| `lib/providers/tmdb/schema.ts` | zod schemas for every TMDB payload consumed |
| `lib/providers/tmdb/client.ts` | HTTP only: auth, abort, 429, token bucket, `provider_calls` |
| `lib/providers/tmdb/normalize.ts` | validated payload → `ResolvedMedia` tree |
| `lib/providers/tmdb/resolve.ts` | search → score → detail, per kind |
| `lib/resolve/confidence.ts` | pure scorer |
| `lib/resolve/persist.ts` | write a `ResolvedMedia` tree in one transaction |
| `lib/cache/lookup.ts` | freshness rules, lookup read/write, lazy re-parse |
| `lib/resolve/pipeline.ts` | the only module that composes the above |
| `lib/auth/apiKey.ts` | bearer token → hash → `api_keys` row |
| `lib/auth/rateLimit.ts` | fixed one-minute windowed counter |
| `lib/jobs/backoff.ts` | pure exponential backoff with jitter |
| `lib/jobs/sweep.ts` | claim due jobs, run them, record outcome |
| `lib/http/problem.ts` | `application/problem+json` responses |
| `app/api/v1/lookup/route.ts` | POST, single and batch |
| `app/api/v1/lookup/[id]/route.ts` | GET, poll |
| `app/api/v1/media/[id]/route.ts` | GET, full record |
| `app/api/v1/health/route.ts` | GET |
| `app/api/cron/sweep/route.ts` | GET, Vercel Cron target |
| `scripts/seed-api-key.ts` | mint a key for local and CI use |
| `scripts/record-tmdb.ts` | record real TMDB responses into fixtures |
| `fixtures/tmdb/*.json` | recorded responses, keyed by request path |
| `vercel.json` | cron schedule |

Not created here: anything under `app/(app)/`, `app/(admin)/`, `lib/auth/session.ts`, or `lib/auth/roles.ts`. Those are Plan 3.

---

### Task 1: Transaction-capable database client

**Files:**
- Modify: `lib/db/client.ts` (replaces the `neon-http` implementation entirely)
- Test: `test/db/transaction.test.ts`

**Interfaces:**
- Consumes: `lib/db/schema` (Plan 1).
- Produces:
  - `type Db = NeonDatabase<typeof schema>` — note this is the `neon-serverless` database type, not `NeonHttpDatabase`
  - `getDb(): Db`
  - `withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>` where `type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]`
  - `advisoryLock(tx: Tx, key: string): Promise<void>` — takes `pg_advisory_xact_lock(hashtext($1))`
  - `closeDb(): Promise<void>` — ends the pool, for test teardown

**This test needs a real database.** It is the one test in the plan that does,
because transaction and lock semantics are exactly what a fake would get
wrong. It reads `DATABASE_URL` and **skips** when the variable is absent, so
`npm run check` stays green on a machine with no credentials.

- [ ] **Step 1: Write the failing test**

`test/db/transaction.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, advisoryLock, closeDb } from '../../lib/db/client';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => {
  if (hasDb) await closeDb();
});

test('a transaction commits and returns its value', opts, async () => {
  const got = await withTransaction(async (tx) => {
    const r = await tx.execute(sql`SELECT 1 AS ok`);
    return r.rows[0];
  });
  assert.deepEqual(got, { ok: 1 });
});

test('a throwing transaction rolls back', opts, async () => {
  await assert.rejects(
    withTransaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO parses (category, normalized_key, tokens, parser_version)
        VALUES ('tv', 'rollback-probe', '{}'::jsonb, 1)`);
      throw new Error('boom');
    }),
    /boom/,
  );
  const rows = await getDb().execute(
    sql`SELECT 1 FROM parses WHERE normalized_key = 'rollback-probe'`,
  );
  assert.equal(rows.rows.length, 0, 'the insert should have been rolled back');
});

test('FOR UPDATE SKIP LOCKED runs inside a transaction', opts, async () => {
  const rows = await withTransaction(async (tx) => {
    const r = await tx.execute(sql`
      SELECT id FROM lookup_jobs WHERE state = 'pending'
      FOR UPDATE SKIP LOCKED LIMIT 5`);
    return r.rows;
  });
  assert.ok(Array.isArray(rows));
});

test('the advisory lock genuinely serializes two transactions', opts, async () => {
  const order: string[] = [];
  const key = 'tv:serialize-probe';
  const holder = withTransaction(async (tx) => {
    await advisoryLock(tx, key);
    order.push('A-acquired');
    await tx.execute(sql`SELECT pg_sleep(0.3)`);
    order.push('A-done');
  });
  // Give A time to take the lock before B asks for it.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const waiter = withTransaction(async (tx) => {
    await advisoryLock(tx, key);
    order.push('B-acquired');
  });
  await Promise.all([holder, waiter]);
  assert.deepEqual(order, ['A-acquired', 'A-done', 'B-acquired']);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/db/transaction.test.ts
```

Expected: FAIL — `withTransaction`, `advisoryLock`, and `closeDb` are not
exported. If `DATABASE_URL` is unset the tests skip instead; put it in
`.env.local` and run with `node --env-file=.env.local` to exercise them, and
add `--env-file-if-exists=.env.local` to the `test` script (Step 5).

- [ ] **Step 3: Rewrite `lib/db/client.ts`**

```ts
import { Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export type Db = NeonDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let pool: Pool | null = null;
let cached: Db | null = null;

/**
 * The database handle, created on first use.
 *
 * The WebSocket driver, not the HTTP one. `neon-http` throws
 * `No transactions support in neon-http driver`, and this service needs
 * transactions for `pg_advisory_xact_lock`, for the sweeper's
 * `FOR UPDATE SKIP LOCKED`, and for a media upsert that must not half-succeed.
 * Node 26 supplies a global `WebSocket`, so no `ws` shim is configured.
 *
 * Lazy rather than a module-level const: Next.js imports route modules while
 * building, and a top-level throw on a missing `DATABASE_URL` would turn a
 * config mistake into a build failure pointing at the wrong thing.
 */
export function getDb(): Db {
  if (cached !== null) return cached;
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL is not set');
  }
  pool = new Pool({ connectionString: url });
  cached = drizzle(pool, { schema });
  return cached;
}

export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

/**
 * A transaction-scoped advisory lock over an arbitrary string.
 *
 * `hashtext` maps the key into the bigint the lock function wants. Collisions
 * are possible and harmless: two unrelated keys that collide serialize against
 * each other, costing a little latency and no correctness, because every write
 * downstream is an upsert on a natural key.
 */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/** For test teardown. A serverless function should never call this. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  cached = null;
  if (current !== null) await current.end();
}
```

- [ ] **Step 4: Run the tests against a real branch**

```bash
node --env-file=.env.local --import tsx --test "test/db/transaction.test.ts"
```

Expected: 4 passing. The serialization test is the one that matters — if
`order` comes back as `['A-acquired', 'B-acquired', 'A-done']` the lock is not
being taken inside the transaction, and `advisoryLock` is running on `getDb()`
rather than on `tx`.

- [ ] **Step 5: Teach `npm test` to pick up `.env.local` when present**

In `package.json`, change the `test` script so the transaction test runs
locally and still skips cleanly in a bare checkout:

```json
"test": "node --env-file-if-exists=.env.local --import tsx --test \"test/**/*.test.ts\""
```

- [ ] **Step 6: Verify and commit**

```bash
npm run check
git add lib/db/client.ts test/db/transaction.test.ts package.json
git commit -m "Replace the neon-http client with the WebSocket driver

neon-http throws 'No transactions support in neon-http driver', and
pg_advisory_xact_lock is transaction-scoped by definition, the sweeper
needs FOR UPDATE SKIP LOCKED, and the media upsert must not be able to
half-succeed. Node 26 has a native WebSocket, so no ws shim.

The serialization test is the point: it asserts a second transaction
blocks on the lock until the first commits, which is the property the
duplicate-provider-call optimisation rests on."
```

---
### Task 2: Provider contract and the TMDB HTTP client

**Files:**
- Create: `lib/providers/types.ts`, `lib/providers/tmdb/client.ts`
- Test: `test/providers/tmdb-client.test.ts`

**Interfaces:**
- Consumes: `getDb` (Task 1), `Category`/`ParsedVideo` (Plan 1, `lib/parse/types`).
- Produces:
  - `interface ResolvedPerson { readonly providerRef: string; readonly name: string; readonly role: PersonRole; readonly characterName: string | null; readonly billingOrder: number | null; readonly raw: JsonValue }`
  - `type PersonRole = 'performer' | 'director' | 'producer' | 'writer' | 'author' | 'illustrator' | 'narrator'`
  - `interface ResolvedMedia` — the tree, defined below
  - `interface Provider { readonly name: 'tmdb' | 'ibdb' | 'tpdb'; supports(category: Category): boolean; resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolvedMedia | null> }`
  - `interface ResolveContext { readonly signal: AbortSignal; readonly lookupId: string | null }`
  - `createTmdbClient(options: TmdbOptions): TmdbClient` with `TmdbClient.get<T>(path: string, query: Record<string, string | number | undefined>, schema: ZodType<T>, ctx: ResolveContext): Promise<T | null>`
  - `class TmdbRateLimited extends Error` and `class TmdbAuthFailed extends Error` — the sweeper in Task 12 distinguishes these

**Why the client takes a schema.** Every response is validated at the edge, so
nothing downstream handles `unknown`. `get` returns `null` for a `404` (a
legitimate "no such id"), throws `TmdbAuthFailed` for `401`/`403` (not
retryable), throws `TmdbRateLimited` for `429` (retryable), and throws a plain
`Error` for other non-2xx (retryable).

- [ ] **Step 1: Write the failing test**

`test/providers/tmdb-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createTmdbClient, TmdbAuthFailed, TmdbRateLimited,
} from '../../lib/providers/tmdb/client';

const schema = z.object({ id: z.number(), title: z.string() });

function stub(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return handler(u, init ?? {});
  };
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch, onCall?: (row: unknown) => void) {
  return createTmdbClient({
    token: 'test-token',
    fetchImpl,
    // `unknown` here is the structural-comparison exception: the row is only
    // ever handed back to the test, never read field by field in the client.
    recordCall: onCall ?? (() => {}),
  });
}

const ctx = { signal: new AbortController().signal, lookupId: null };

test('the bearer token goes in the Authorization header, never the query', async () => {
  const { fetchImpl, calls } = stub(() => Response.json({ id: 1, title: 'x' }));
  await client(fetchImpl as unknown as typeof fetch).get('/movie/1', {}, schema, ctx);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer test-token');
  assert.ok(!call.url.includes('test-token'), 'the token must not appear in the URL');
  assert.ok(!call.url.includes('api_key'), 'no api_key query parameter');
});

test('undefined query values are omitted rather than sent as the string undefined', async () => {
  const { fetchImpl, calls } = stub(() => Response.json({ id: 1, title: 'x' }));
  await client(fetchImpl as unknown as typeof fetch)
    .get('/search/movie', { query: 'Outbreak', primary_release_year: undefined }, schema, ctx);
  const url = calls[0]?.url ?? '';
  assert.ok(url.includes('query=Outbreak'));
  assert.ok(!url.includes('primary_release_year'), url);
});

test('a 404 is null, not an error', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 404 }));
  const got = await client(fetchImpl as unknown as typeof fetch).get('/movie/0', {}, schema, ctx);
  assert.equal(got, null);
});

test('a 401 throws TmdbAuthFailed, which is not retryable', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 401 }));
  await assert.rejects(
    client(fetchImpl as unknown as typeof fetch).get('/movie/1', {}, schema, ctx),
    TmdbAuthFailed,
  );
});

test('a 429 throws TmdbRateLimited and carries Retry-After when present', async () => {
  const { fetchImpl } = stub(() => new Response('', { status: 429, headers: { 'retry-after': '7' } }));
  await assert.rejects(
    client(fetchImpl as unknown as typeof fetch).get('/movie/1', {}, schema, ctx),
    (e: unknown) => e instanceof TmdbRateLimited && e.retryAfterSeconds === 7,
  );
});

test('a malformed payload is a validation error, not a silent pass-through', async () => {
  const { fetchImpl } = stub(() => Response.json({ id: 'not-a-number' }));
  await assert.rejects(client(fetchImpl as unknown as typeof fetch).get('/movie/1', {}, schema, ctx));
});

test('every call is recorded with a path and status but never the token', async () => {
  const rows: unknown[] = [];
  const { fetchImpl } = stub(() => Response.json({ id: 1, title: 'x' }));
  await client(fetchImpl as unknown as typeof fetch, (r) => rows.push(r))
    .get('/search/movie', { query: 'Outbreak' }, schema, ctx);
  assert.equal(rows.length, 1);
  const row = JSON.stringify(rows[0]);
  assert.ok(row.includes('/search/movie'), row);
  assert.ok(row.includes('200'), row);
  assert.ok(!row.includes('test-token'), 'the token leaked into provider_calls');
});

test('an aborted signal rejects before the request is made', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = stub(() => Response.json({ id: 1, title: 'x' }));
  await assert.rejects(
    client(fetchImpl as unknown as typeof fetch)
      .get('/movie/1', {}, schema, { signal: controller.signal, lookupId: null }),
  );
  assert.equal(calls.length, 0, 'no request should be issued once aborted');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/providers/tmdb-client.test.ts
```

Expected: FAIL — cannot resolve `../../lib/providers/tmdb/client`.

- [ ] **Step 3: Write `lib/providers/types.ts`**

```ts
import type { Category, ParsedVideo } from '../parse/types';

/** What a jsonb column accepts. Used for the stored `raw` payloads. */
export type JsonValue =
  | string | number | boolean | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PersonRole =
  | 'performer' | 'director' | 'producer' | 'writer'
  | 'author' | 'illustrator' | 'narrator';

export type MediaKind = 'movie' | 'series' | 'season' | 'episode' | 'book' | 'scene';
export type ProviderName = 'tmdb' | 'ibdb' | 'tpdb';

export interface ResolvedPerson {
  readonly providerRef: string;
  readonly name: string;
  readonly role: PersonRole;
  readonly characterName: string | null;
  readonly billingOrder: number | null;
  readonly raw: JsonValue;
}

export interface ResolvedDetails {
  readonly movie: {
    readonly runtimeMinutes: number | null;
    readonly imdbId: string | null;
    readonly tagline: string | null;
    readonly collectionName: string | null;
  } | null;
  readonly series: {
    readonly firstAirDate: string | null;
    readonly lastAirDate: string | null;
    readonly status: string | null;
  } | null;
  readonly season: { readonly seasonNumber: number } | null;
  readonly episode: {
    readonly seasonNumber: number;
    readonly episodeNumber: number;
    readonly airDate: string | null;
  } | null;
}

/**
 * A provider's answer: one node plus its ancestors, each carrying its own
 * people and raw payload. `parent` runs upward, so an episode's parent is its
 * season and that season's parent is the series.
 */
export interface ResolvedMedia {
  readonly category: Category;
  readonly kind: MediaKind;
  readonly provider: ProviderName;
  readonly providerRef: string;
  readonly title: string;
  readonly sortTitle: string;
  readonly originalTitle: string | null;
  readonly releaseDate: string | null;
  readonly year: number | null;
  readonly overview: string | null;
  readonly raw: JsonValue;
  readonly details: ResolvedDetails;
  readonly people: readonly ResolvedPerson[];
  readonly parent: ResolvedMedia | null;
}

export interface ResolveContext {
  readonly signal: AbortSignal;
  /** For `provider_calls.lookup_id`; null when resolving outside a lookup. */
  readonly lookupId: string | null;
}

export interface Provider {
  readonly name: ProviderName;
  supports(category: Category): boolean;
  resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolvedMedia | null>;
}

/** What the pipeline records for observability. Never contains a credential. */
export interface ProviderCallRecord {
  readonly provider: ProviderName;
  readonly endpoint: string;
  readonly status: number;
  readonly durationMs: number;
  readonly lookupId: string | null;
}
```

- [ ] **Step 4: Write `lib/providers/tmdb/client.ts`**

```ts
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
        throw new TmdbRateLimited(Number.isNaN(seconds) ? null : seconds);
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
```

- [ ] **Step 5: Run the tests**

```bash
npm run test -- test/providers/tmdb-client.test.ts
```

Expected: 8 passing. If the abort test fails with a request having been made,
`throwIfAborted` is being called after `doFetch` rather than before.

- [ ] **Step 6: Commit**

```bash
npm run check
git add lib/providers test/providers
git commit -m "Add the provider contract and the TMDB HTTP client

Every response is validated by a zod schema at the edge, so nothing
downstream ever handles unknown. A 404 is null rather than an error --
'no such id' is an answer -- while 401/403 and 429 get distinct error
types because the sweeper treats one as terminal and the other as
retryable.

provider_calls records the path, not the URL, so query values stay out
of the log alongside the credential that was never in the URL anyway.
A test asserts the token appears in no recorded row."
```

---
### Task 3: TMDB payload schemas and normalization

**Files:**
- Create: `lib/providers/tmdb/schema.ts`, `lib/providers/tmdb/normalize.ts`
- Test: `test/providers/tmdb-normalize.test.ts`

**Interfaces:**
- Consumes: `ResolvedMedia`, `ResolvedPerson`, `JsonValue` (Task 2).
- Produces:
  - schemas `tmdbMovieSearch`, `tmdbMovieDetails`, `tmdbTvSearch`, `tmdbTvDetails`, `tmdbSeasonDetails`, and their inferred types `TmdbMovieSearch`, `TmdbMovieDetails`, `TmdbTvSearch`, `TmdbTvDetails`, `TmdbSeasonDetails`
  - `providerRefFor(kind: 'movie' | 'tv' | 'season' | 'episode', ids: readonly number[]): string`
  - `normalizeMovie(details: TmdbMovieDetails): ResolvedMedia`
  - `normalizeSeries(details: TmdbTvDetails): ResolvedMedia`
  - `normalizeSeason(series: ResolvedMedia, season: TmdbSeasonDetails): ResolvedMedia`
  - `normalizeEpisode(season: ResolvedMedia, episode: TmdbSeasonDetails['episodes'][number]): ResolvedMedia`
  - `sortTitleOf(title: string): string`

**Schemas are permissive on purpose.** TMDB adds fields; a strict schema would
turn an upstream addition into an outage. Every schema uses zod's default
object behaviour (unknown keys ignored) and marks anything not guaranteed as
nullable. `raw` stores the whole validated object, which is what makes a
future field addition a backfill rather than a re-fetch.

- [ ] **Step 1: Write the failing test**

`test/providers/tmdb-normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmdbMovieDetails, tmdbTvDetails, tmdbSeasonDetails,
} from '../../lib/providers/tmdb/schema';
import {
  normalizeMovie, normalizeSeries, normalizeSeason, normalizeEpisode,
  providerRefFor, sortTitleOf,
} from '../../lib/providers/tmdb/normalize';

const MOVIE = {
  id: 603,
  title: 'The Matrix',
  original_title: 'The Matrix',
  release_date: '1999-03-30',
  overview: 'A hacker learns the truth.',
  runtime: 136,
  imdb_id: 'tt0133093',
  tagline: 'Welcome to the Real World.',
  belongs_to_collection: { id: 2344, name: 'The Matrix Collection' },
  a_field_tmdb_added_later: 'must not break parsing',
  credits: {
    cast: [
      { id: 6384, name: 'Keanu Reeves', character: 'Neo', order: 0 },
      { id: 2975, name: 'Laurence Fishburne', character: 'Morpheus', order: 1 },
    ],
    crew: [
      { id: 9339, name: 'Lana Wachowski', job: 'Director', department: 'Directing' },
      { id: 9340, name: 'Lilly Wachowski', job: 'Writer', department: 'Writing' },
      { id: 1, name: 'Someone', job: 'Best Boy', department: 'Lighting' },
    ],
  },
};

const TV = {
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  last_air_date: '2013-09-29',
  status: 'Ended',
  overview: 'A chemistry teacher.',
  origin_country: ['US'],
};

const SEASON = {
  id: 3573,
  season_number: 2,
  name: 'Season 2',
  air_date: '2009-03-08',
  overview: '',
  episodes: [
    {
      id: 62092,
      episode_number: 4,
      season_number: 2,
      name: 'Down',
      air_date: '2009-03-29',
      overview: 'Things get worse.',
      crew: [{ id: 5, name: 'John Dahl', job: 'Director', department: 'Directing' }],
      guest_stars: [{ id: 7, name: 'Guest One', character: 'Clerk', order: 3 }],
    },
  ],
};

test('provider refs are the natural keys the schema deduplicates on', () => {
  assert.equal(providerRefFor('movie', [603]), 'tmdb:movie:603');
  assert.equal(providerRefFor('tv', [1396]), 'tmdb:tv:1396');
  assert.equal(providerRefFor('season', [1396, 2]), 'tmdb:tv:1396:2');
  assert.equal(providerRefFor('episode', [1396, 2, 4]), 'tmdb:tv:1396:2:4');
});

test('sortTitleOf strips a leading article and lowercases', () => {
  assert.equal(sortTitleOf('The Matrix'), 'matrix');
  assert.equal(sortTitleOf('A Quiet Place'), 'quiet place');
  assert.equal(sortTitleOf('An Education'), 'education');
  assert.equal(sortTitleOf('Alien'), 'alien');
  assert.equal(sortTitleOf('The The'), 'the');
});

test('an unexpected extra field does not break validation', () => {
  const parsed = tmdbMovieDetails.parse(MOVIE);
  assert.equal(parsed.id, 603);
});

test('a movie normalizes with details and only the interesting crew', () => {
  const media = normalizeMovie(tmdbMovieDetails.parse(MOVIE));
  assert.equal(media.kind, 'movie');
  assert.equal(media.category, 'movies');
  assert.equal(media.providerRef, 'tmdb:movie:603');
  assert.equal(media.title, 'The Matrix');
  assert.equal(media.sortTitle, 'matrix');
  assert.equal(media.releaseDate, '1999-03-30');
  assert.equal(media.year, 1999);
  assert.equal(media.parent, null);
  assert.equal(media.details.movie?.imdbId, 'tt0133093');
  assert.equal(media.details.movie?.runtimeMinutes, 136);
  assert.equal(media.details.movie?.collectionName, 'The Matrix Collection');

  const roles = media.people.map((p) => `${p.role}:${p.name}`);
  assert.ok(roles.includes('director:Lana Wachowski'));
  assert.ok(roles.includes('writer:Lilly Wachowski'));
  assert.ok(roles.includes('performer:Keanu Reeves'));
  assert.ok(
    !roles.some((r) => r.includes('Best Boy') || r.includes('Someone')),
    'a Best Boy is not a role this service models',
  );
  const neo = media.people.find((p) => p.name === 'Keanu Reeves');
  assert.equal(neo?.characterName, 'Neo');
  assert.equal(neo?.billingOrder, 0);
});

test('a series normalizes with its air dates and status', () => {
  const media = normalizeSeries(tmdbTvDetails.parse(TV));
  assert.equal(media.kind, 'series');
  assert.equal(media.category, 'tv');
  assert.equal(media.providerRef, 'tmdb:tv:1396');
  assert.equal(media.year, 2008);
  assert.equal(media.details.series?.status, 'Ended');
  assert.equal(media.parent, null);
});

test('a season hangs off its series and an episode off its season', () => {
  const series = normalizeSeries(tmdbTvDetails.parse(TV));
  const season = normalizeSeason(series, tmdbSeasonDetails.parse(SEASON));
  assert.equal(season.kind, 'season');
  assert.equal(season.providerRef, 'tmdb:tv:1396:2');
  assert.equal(season.parent?.providerRef, 'tmdb:tv:1396');
  assert.equal(season.details.season?.seasonNumber, 2);

  const raw = tmdbSeasonDetails.parse(SEASON).episodes[0];
  assert.ok(raw !== undefined);
  const episode = normalizeEpisode(season, raw);
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.providerRef, 'tmdb:tv:1396:2:4');
  assert.equal(episode.title, 'Down');
  assert.equal(episode.parent?.providerRef, 'tmdb:tv:1396:2');
  assert.equal(episode.parent?.parent?.providerRef, 'tmdb:tv:1396');
  assert.equal(episode.details.episode?.episodeNumber, 4);
  assert.equal(episode.details.episode?.airDate, '2009-03-29');
  // The season payload already carries per-episode crew and guest stars,
  // which is why no separate episode-credits call is made.
  assert.ok(episode.people.some((p) => p.role === 'director' && p.name === 'John Dahl'));
  assert.ok(episode.people.some((p) => p.role === 'performer' && p.name === 'Guest One'));
});

test('an empty release date yields a null date and a null year, not NaN', () => {
  const media = normalizeMovie(tmdbMovieDetails.parse({ ...MOVIE, release_date: '' }));
  assert.equal(media.releaseDate, null);
  assert.equal(media.year, null);
});

test('a missing collection and a missing runtime are null, not undefined', () => {
  const media = normalizeMovie(tmdbMovieDetails.parse({
    id: 1, title: 'X', release_date: '2001-01-01',
    belongs_to_collection: null, runtime: null, imdb_id: null,
  }));
  assert.equal(media.details.movie?.collectionName, null);
  assert.equal(media.details.movie?.runtimeMinutes, null);
  assert.deepEqual(media.people, []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/providers/tmdb-normalize.test.ts
```

Expected: FAIL — cannot resolve `../../lib/providers/tmdb/schema`.

- [ ] **Step 3: Write `lib/providers/tmdb/schema.ts`**

```ts
import { z } from 'zod';

/**
 * Permissive by design. TMDB adds fields, and a strict schema would turn an
 * upstream addition into an outage. Unknown keys are ignored (zod's default
 * object behaviour) and anything not guaranteed by the docs is nullable.
 */
const person = z.object({
  id: z.number(),
  name: z.string(),
});

export const tmdbCastMember = person.extend({
  character: z.string().nullish(),
  order: z.number().nullish(),
});

export const tmdbCrewMember = person.extend({
  job: z.string().nullish(),
  department: z.string().nullish(),
});

export const tmdbCredits = z.object({
  cast: z.array(tmdbCastMember).default([]),
  crew: z.array(tmdbCrewMember).default([]),
});

export const tmdbMovieSearchResult = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().nullish(),
  release_date: z.string().nullish(),
  popularity: z.number().nullish(),
  vote_count: z.number().nullish(),
});

export const tmdbMovieSearch = z.object({
  page: z.number(),
  total_results: z.number(),
  results: z.array(tmdbMovieSearchResult).default([]),
});

export const tmdbMovieDetails = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().nullish(),
  release_date: z.string().nullish(),
  overview: z.string().nullish(),
  runtime: z.number().nullish(),
  imdb_id: z.string().nullish(),
  tagline: z.string().nullish(),
  belongs_to_collection: z.object({ name: z.string() }).nullish(),
  credits: tmdbCredits.nullish(),
});

export const tmdbTvSearchResult = z.object({
  id: z.number(),
  name: z.string(),
  original_name: z.string().nullish(),
  first_air_date: z.string().nullish(),
  origin_country: z.array(z.string()).default([]),
  popularity: z.number().nullish(),
  vote_count: z.number().nullish(),
});

export const tmdbTvSearch = z.object({
  page: z.number(),
  total_results: z.number(),
  results: z.array(tmdbTvSearchResult).default([]),
});

export const tmdbSeasonSummary = z.object({
  season_number: z.number(),
  episode_count: z.number().nullish(),
});

export const tmdbTvDetails = z.object({
  id: z.number(),
  name: z.string(),
  original_name: z.string().nullish(),
  first_air_date: z.string().nullish(),
  last_air_date: z.string().nullish(),
  status: z.string().nullish(),
  overview: z.string().nullish(),
  origin_country: z.array(z.string()).default([]),
  number_of_seasons: z.number().nullish(),
  seasons: z.array(tmdbSeasonSummary).default([]),
});

export const tmdbEpisode = z.object({
  id: z.number(),
  episode_number: z.number(),
  season_number: z.number(),
  name: z.string(),
  air_date: z.string().nullish(),
  overview: z.string().nullish(),
  crew: z.array(tmdbCrewMember).default([]),
  guest_stars: z.array(tmdbCastMember).default([]),
});

export const tmdbSeasonDetails = z.object({
  id: z.number(),
  season_number: z.number(),
  name: z.string(),
  air_date: z.string().nullish(),
  overview: z.string().nullish(),
  episodes: z.array(tmdbEpisode).default([]),
});

export type TmdbMovieSearch = z.infer<typeof tmdbMovieSearch>;
export type TmdbMovieSearchResult = z.infer<typeof tmdbMovieSearchResult>;
export type TmdbMovieDetails = z.infer<typeof tmdbMovieDetails>;
export type TmdbTvSearch = z.infer<typeof tmdbTvSearch>;
export type TmdbTvSearchResult = z.infer<typeof tmdbTvSearchResult>;
export type TmdbTvDetails = z.infer<typeof tmdbTvDetails>;
export type TmdbSeasonDetails = z.infer<typeof tmdbSeasonDetails>;
export type TmdbEpisode = z.infer<typeof tmdbEpisode>;
```

- [ ] **Step 4: Write `lib/providers/tmdb/normalize.ts`**

```ts
import type {
  JsonValue, PersonRole, ResolvedMedia, ResolvedPerson,
} from '../types';
import type {
  TmdbEpisode, TmdbMovieDetails, TmdbSeasonDetails, TmdbTvDetails,
} from './schema';

const LEADING_ARTICLE = /^(?:the|a|an)\s+/i;

export function sortTitleOf(title: string): string {
  const lowered = title.trim().toLowerCase();
  const stripped = lowered.replace(LEADING_ARTICLE, '');
  // `The The` must not become the empty string.
  return stripped.length > 0 ? stripped : lowered;
}

export function providerRefFor(
  kind: 'movie' | 'tv' | 'season' | 'episode',
  ids: readonly number[],
): string {
  const joined = ids.join(':');
  return kind === 'movie' ? `tmdb:movie:${joined}` : `tmdb:tv:${joined}`;
}

function dateOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function textOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

/**
 * Only the crew jobs this service models. A film's credits run to hundreds of
 * names; storing a Best Boy would cost rows and buy nothing, and `media_people`
 * has no role for one.
 */
const CREW_ROLES: Readonly<Record<string, PersonRole>> = {
  Director: 'director',
  Writer: 'writer',
  Screenplay: 'writer',
  Story: 'writer',
  Producer: 'producer',
  'Executive Producer': 'producer',
  Novel: 'author',
};

/** Top-billed cast only, for the same reason. */
const CAST_LIMIT = 15;

interface RawCast {
  readonly id: number;
  readonly name: string;
  readonly character?: string | null | undefined;
  readonly order?: number | null | undefined;
}

interface RawCrew {
  readonly id: number;
  readonly name: string;
  readonly job?: string | null | undefined;
  readonly department?: string | null | undefined;
}

function peopleFrom(cast: readonly RawCast[], crew: readonly RawCrew[]): readonly ResolvedPerson[] {
  const out: ResolvedPerson[] = [];
  const ordered = [...cast].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  for (const member of ordered.slice(0, CAST_LIMIT)) {
    out.push({
      providerRef: `tmdb:person:${member.id}`,
      name: member.name,
      role: 'performer',
      characterName: textOrNull(member.character),
      billingOrder: member.order ?? null,
      raw: member as unknown as JsonValue,
    });
  }
  for (const member of crew) {
    const job = member.job ?? '';
    const role = CREW_ROLES[job];
    if (role === undefined) continue;
    out.push({
      providerRef: `tmdb:person:${member.id}`,
      name: member.name,
      role,
      characterName: null,
      billingOrder: null,
      raw: member as unknown as JsonValue,
    });
  }
  return out;
}

export function normalizeMovie(details: TmdbMovieDetails): ResolvedMedia {
  const releaseDate = dateOrNull(details.release_date);
  return {
    category: 'movies',
    kind: 'movie',
    provider: 'tmdb',
    providerRef: providerRefFor('movie', [details.id]),
    title: details.title,
    sortTitle: sortTitleOf(details.title),
    originalTitle: textOrNull(details.original_title),
    releaseDate,
    year: yearOf(releaseDate),
    overview: textOrNull(details.overview),
    raw: details as unknown as JsonValue,
    details: {
      movie: {
        runtimeMinutes: details.runtime ?? null,
        imdbId: textOrNull(details.imdb_id),
        tagline: textOrNull(details.tagline),
        collectionName: details.belongs_to_collection?.name ?? null,
      },
      series: null, season: null, episode: null,
    },
    people: peopleFrom(details.credits?.cast ?? [], details.credits?.crew ?? []),
    parent: null,
  };
}

export function normalizeSeries(details: TmdbTvDetails): ResolvedMedia {
  const firstAir = dateOrNull(details.first_air_date);
  return {
    category: 'tv',
    kind: 'series',
    provider: 'tmdb',
    providerRef: providerRefFor('tv', [details.id]),
    title: details.name,
    sortTitle: sortTitleOf(details.name),
    originalTitle: textOrNull(details.original_name),
    releaseDate: firstAir,
    year: yearOf(firstAir),
    overview: textOrNull(details.overview),
    raw: details as unknown as JsonValue,
    details: {
      movie: null,
      series: {
        firstAirDate: firstAir,
        lastAirDate: dateOrNull(details.last_air_date),
        status: textOrNull(details.status),
      },
      season: null, episode: null,
    },
    people: [],
    parent: null,
  };
}

/** `series.providerRef` is `tmdb:tv:<id>`; the numeric id is its last segment. */
function seriesIdOf(series: ResolvedMedia): number {
  const last = series.providerRef.split(':').at(-1) ?? '';
  const id = Number.parseInt(last, 10);
  if (Number.isNaN(id)) throw new Error(`cannot read a series id from ${series.providerRef}`);
  return id;
}

export function normalizeSeason(series: ResolvedMedia, season: TmdbSeasonDetails): ResolvedMedia {
  const airDate = dateOrNull(season.air_date);
  return {
    category: 'tv',
    kind: 'season',
    provider: 'tmdb',
    providerRef: providerRefFor('season', [seriesIdOf(series), season.season_number]),
    title: season.name,
    sortTitle: sortTitleOf(season.name),
    originalTitle: null,
    releaseDate: airDate,
    year: yearOf(airDate),
    overview: textOrNull(season.overview),
    raw: season as unknown as JsonValue,
    details: {
      movie: null, series: null,
      season: { seasonNumber: season.season_number },
      episode: null,
    },
    people: [],
    parent: series,
  };
}

export function normalizeEpisode(season: ResolvedMedia, episode: TmdbEpisode): ResolvedMedia {
  const parentSeries = season.parent;
  if (parentSeries === null) throw new Error('a season passed to normalizeEpisode has no series');
  const airDate = dateOrNull(episode.air_date);
  return {
    category: 'tv',
    kind: 'episode',
    provider: 'tmdb',
    providerRef: providerRefFor('episode', [
      seriesIdOf(parentSeries), episode.season_number, episode.episode_number,
    ]),
    title: episode.name,
    sortTitle: sortTitleOf(episode.name),
    originalTitle: null,
    releaseDate: airDate,
    year: yearOf(airDate),
    overview: textOrNull(episode.overview),
    raw: episode as unknown as JsonValue,
    details: {
      movie: null, series: null, season: null,
      episode: {
        seasonNumber: episode.season_number,
        episodeNumber: episode.episode_number,
        airDate,
      },
    },
    // The season payload already carries per-episode crew and guest stars,
    // which is why episode resolution needs no separate credits call.
    people: peopleFrom(episode.guest_stars, episode.crew),
    parent: season,
  };
}
```

The `as unknown as JsonValue` casts on `raw` are the second permitted
`unknown`: a zod-validated object is structurally a JSON value, but TypeScript
cannot see that through the inferred type, and the alternative is a
hand-written duplicate of every schema.

- [ ] **Step 5: Run the tests**

```bash
npm run test -- test/providers/tmdb-normalize.test.ts
```

Expected: 8 passing. If `sortTitleOf('The The')` returns the empty string, the
fallback in `sortTitleOf` is missing — stripping the article must not be
allowed to consume the whole title.

- [ ] **Step 6: Commit**

```bash
npm run check
git add lib/providers/tmdb test/providers/tmdb-normalize.test.ts
git commit -m "Add TMDB payload schemas and normalization

Schemas ignore unknown keys and make everything not guaranteed
nullable, so a field TMDB adds later is not an outage. The whole
validated object goes into raw, which is what makes a future column a
backfill rather than a re-fetch of the entire cache.

Only the crew jobs media_people has roles for are kept, and cast is
capped at the top 15 billed: a film's full credits run to hundreds of
names and a Best Boy has nowhere to go."
```

---
### Task 4: Confidence scoring

**Files:**
- Create: `lib/resolve/confidence.ts`
- Test: `test/resolve/confidence.test.ts`

**Interfaces:**
- Consumes: `foldForMatch` (Plan 1, `lib/parse/normalize`), `ParsedVideo` (Plan 1).
- Produces:
  - `CONFIDENCE_FLOOR: number` — read from `process.env.CONFIDENCE_FLOOR`, default `0.75`
  - `interface Candidate { readonly title: string; readonly originalTitle: string | null; readonly year: number | null; readonly originCountries: readonly string[]; readonly popularity: number; readonly voteCount: number; readonly seasonExists: boolean | null; readonly episodeExists: boolean | null }`
  - `scoreCandidate(parsed: ParsedVideo, candidate: Candidate): number` — returns `[0, 1]`
  - `pickBest<T>(parsed: ParsedVideo, items: readonly T[], toCandidate: (item: T) => Candidate): { readonly item: T; readonly confidence: number } | null`
  - `titleSimilarity(a: string, b: string): number`

**The signals, and why they are weighted as they are.** Title similarity
dominates because it is the only signal that is about identity rather than
plausibility. Episode existence is near-decisive when known: a series that has
no S2E4 is not the series this file came from, whatever its title says.
Popularity is a **tiebreak only** — as a primary term it resolves every
ambiguous title to whatever is most famous, which is exactly the failure a
confidence score exists to prevent.

- [ ] **Step 1: Write the failing test**

`test/resolve/confidence.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, pickBest, titleSimilarity, CONFIDENCE_FLOOR } from '../../lib/resolve/confidence';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';

function parsed(category: 'tv' | 'movies', name: string): ParsedVideo {
  const r = parseVideo(category, name);
  if (!r.ok) throw new Error(`fixture refused: ${r.refusal}`);
  return r.parsed;
}

const base = {
  originalTitle: null, year: null, originCountries: [],
  popularity: 1, voteCount: 100, seasonExists: null, episodeExists: null,
};

test('titleSimilarity is 1 for an exact fold-equal match and 0 for nothing alike', () => {
  assert.equal(titleSimilarity('The Matrix', 'the matrix'), 1);
  assert.equal(titleSimilarity('90 Day Fiance', '90 Day Fiancé'), 1);
  assert.ok(titleSimilarity('Outbreak', 'Interstellar') < 0.3);
});

test('an exact title and year clears the floor comfortably', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const score = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1995 });
  assert.ok(score >= 0.9, `expected >= 0.9, got ${score}`);
});

test('a year that is off by one is only mildly penalised', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const exact = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1995 });
  const nearby = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1996 });
  const wrong = scoreCandidate(p, { ...base, title: 'Outbreak', year: 2015 });
  assert.ok(nearby < exact, 'off-by-one should score below exact');
  assert.ok(nearby > wrong, 'off-by-one should score above a real mismatch');
  assert.ok(wrong < CONFIDENCE_FLOOR, 'a twenty-year gap should fall below the floor');
});

test('popularity only breaks ties and never outranks the title', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const right = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1995, popularity: 0.1, voteCount: 12 });
  const famousWrong = scoreCandidate(p, { ...base, title: 'Oblivion', year: 1995, popularity: 900, voteCount: 90000 });
  assert.ok(right > famousWrong, 'a popular wrong title must not beat the right one');
});

test('popularity does break a genuine tie', () => {
  const p = parsed('movies', 'Ghosts.2019.1080p.WEB-DL-GRP.nzb');
  const popular = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2019, popularity: 50, voteCount: 5000 });
  const obscure = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2019, popularity: 0.2, voteCount: 3 });
  assert.ok(popular > obscure);
});

test('an episode that does not exist on the candidate series is decisive', () => {
  const p = parsed('tv', 'Some.Show.S02E04.1080p.WEB-DL-GRP.nzb');
  const exists = scoreCandidate(p, { ...base, title: 'Some Show', seasonExists: true, episodeExists: true });
  const missing = scoreCandidate(p, { ...base, title: 'Some Show', seasonExists: true, episodeExists: false });
  assert.ok(exists >= CONFIDENCE_FLOOR);
  assert.ok(missing < CONFIDENCE_FLOOR, 'a missing episode must drop below the floor');
});

test('a matching origin country lifts the right one of two same-named shows', () => {
  const p = parsed('tv', 'TV Shows/Ghosts (US)/Season 5/Ghosts (US) - S05E12 - The List WEBRip-1080p.mkv');
  const us = scoreCandidate(p, { ...base, title: 'Ghosts', originCountries: ['US'], seasonExists: true, episodeExists: true });
  const gb = scoreCandidate(p, { ...base, title: 'Ghosts', originCountries: ['GB'], seasonExists: true, episodeExists: true });
  assert.ok(us > gb, 'the (US) disambiguator should favour the US series');
});

test('a year disambiguator from a directory behaves like a year', () => {
  const p = parsed('tv', 'TV Shows/Ghosts (2019)/Season 1/Ghosts (2019) - S01E01 - Pilot WEBDL-1080p.mkv');
  const right = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2019, seasonExists: true, episodeExists: true });
  const wrong = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2021, seasonExists: true, episodeExists: true });
  assert.ok(right > wrong);
});

test('a title taken from a directory rather than the filename is penalised', () => {
  const fromFile = parsed('movies', 'Interstellar.2014.1080p.BluRay-GRP.nzb');
  const fromDir = parsed('movies', 'Movies/Interstellar (2014)/00136.m2ts');
  const a = scoreCandidate(fromFile, { ...base, title: 'Interstellar', year: 2014 });
  const b = scoreCandidate(fromDir, { ...base, title: 'Interstellar', year: 2014 });
  assert.ok(b < a, 'a directory-sourced title is weaker evidence');
  assert.ok(b >= CONFIDENCE_FLOOR, 'but still good enough to resolve');
});

test('scores stay inside [0, 1]', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  for (const c of [
    { ...base, title: 'Outbreak', year: 1995, popularity: 1e6, voteCount: 1e6 },
    { ...base, title: '', year: null, popularity: 0, voteCount: 0 },
  ]) {
    const score = scoreCandidate(p, c);
    assert.ok(score >= 0 && score <= 1, `out of range: ${score}`);
  }
});

test('pickBest returns the highest scorer and null for an empty list', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const items = [
    { name: 'wrong', c: { ...base, title: 'Oblivion', year: 1995 } },
    { name: 'right', c: { ...base, title: 'Outbreak', year: 1995 } },
  ];
  const best = pickBest(p, items, (i) => i.c);
  assert.equal(best?.item.name, 'right');
  assert.ok((best?.confidence ?? 0) > 0.8);
  assert.equal(pickBest(p, [], (i: { c: typeof base & { title: string } }) => i.c), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/resolve/confidence.test.ts
```

Expected: FAIL — cannot resolve `../../lib/resolve/confidence`.

- [ ] **Step 3: Write the implementation**

`lib/resolve/confidence.ts`:

```ts
import { foldForMatch } from '../parse/normalize';
import type { ParsedVideo } from '../parse/types';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? fallback : value;
}

export const CONFIDENCE_FLOOR = envNumber('CONFIDENCE_FLOOR', 0.75);

export interface Candidate {
  readonly title: string;
  readonly originalTitle: string | null;
  readonly year: number | null;
  readonly originCountries: readonly string[];
  readonly popularity: number;
  readonly voteCount: number;
  /** Null when not yet known — a search result has not been detail-fetched. */
  readonly seasonExists: boolean | null;
  readonly episodeExists: boolean | null;
}

/** Levenshtein, iterative and allocation-light. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * 1 for a fold-equal match, decaying with edit distance. Folding is what makes
 * `90 Day Fiance` and `90 Day Fiancé` identical here.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = foldForMatch(a);
  const right = foldForMatch(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  const distance = editDistance(left, right);
  const longest = Math.max(left.length, right.length);
  return Math.max(0, 1 - distance / longest);
}

/** The year a caller effectively asserted: the parsed year, or a `(2019)` directory hint. */
function assertedYear(parsed: ParsedVideo): number | null {
  if (parsed.year !== null) return parsed.year;
  const hint = parsed.hints.disambiguator;
  if (hint === null || !/^\d{4}$/.test(hint)) return null;
  const year = Number.parseInt(hint, 10);
  return year >= 1900 && year <= 2099 ? year : null;
}

/** A `(US)` or `(UK)` directory hint, as a two-letter country code. */
function assertedCountry(parsed: ParsedVideo): string | null {
  const hint = parsed.hints.disambiguator;
  if (hint === null) return null;
  const upper = hint.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return upper === 'UK' ? 'GB' : upper;
}

export function scoreCandidate(parsed: ParsedVideo, candidate: Candidate): number {
  // Title similarity dominates: it is the only signal about identity rather
  // than plausibility. Everything below adjusts it.
  const direct = titleSimilarity(parsed.title, candidate.title);
  const original = candidate.originalTitle === null
    ? 0
    : titleSimilarity(parsed.title, candidate.originalTitle);
  let score = Math.max(direct, original) * 0.7;

  const wanted = assertedYear(parsed);
  if (wanted !== null && candidate.year !== null) {
    const gap = Math.abs(wanted - candidate.year);
    // Off-by-one is common: a provider's date and a release group's label
    // disagree across a new year all the time.
    if (gap === 0) score += 0.2;
    else if (gap === 1) score += 0.1;
    else score -= 0.35;
  }

  const country = assertedCountry(parsed);
  if (country !== null && candidate.originCountries.length > 0) {
    score += candidate.originCountries.includes(country) ? 0.08 : -0.08;
  }

  if (candidate.seasonExists === false) score -= 0.4;
  if (candidate.episodeExists === false) score -= 0.4;
  if (candidate.seasonExists === true && candidate.episodeExists === true) score += 0.08;

  // Directory-sourced titles are weaker evidence than the filename's own.
  if (parsed.hints.fromDirectories.length > 0) score -= 0.05;
  if (parsed.kind === 'episode' && parsed.yearSeason) score -= 0.05;

  // Popularity is a tiebreak and nothing more. Capped small enough that it can
  // never lift a wrong title over a right one.
  const popular = Math.log10(Math.max(1, candidate.popularity) + 1);
  const voted = Math.log10(Math.max(1, candidate.voteCount) + 1);
  score += Math.min(0.03, popular * 0.006) + Math.min(0.02, voted * 0.004);

  return Math.min(1, Math.max(0, score));
}

export function pickBest<T>(
  parsed: ParsedVideo,
  items: readonly T[],
  toCandidate: (item: T) => Candidate,
): { readonly item: T; readonly confidence: number } | null {
  let best: { item: T; confidence: number } | null = null;
  for (const item of items) {
    const confidence = scoreCandidate(parsed, toCandidate(item));
    if (best === null || confidence > best.confidence) best = { item, confidence };
  }
  return best;
}
```

- [ ] **Step 4: Run the tests and tune only if a test says so**

```bash
npm run test -- test/resolve/confidence.test.ts
```

Expected: 11 passing. The weights above were chosen to satisfy exactly these
assertions; if one fails, adjust a weight rather than the assertion, because
each assertion encodes a decision from the spec. In particular: "a popular
wrong title must not beat the right one" is the whole reason popularity is
capped at `0.05` combined, and raising that cap to make some other case pass
would defeat the point.

- [ ] **Step 5: Commit**

```bash
npm run check
git add lib/resolve/confidence.ts test/resolve/confidence.test.ts
git commit -m "Add the confidence scorer

Title similarity dominates because it is the only signal about
identity rather than plausibility. Popularity is capped at 0.05
combined so it can break a genuine tie and can never lift a wrong
title over a right one -- that failure is the reason a confidence
score exists at all, and there is a test for it.

The (US)/(2019) directory disambiguator feeds two separate terms,
origin country and year, which is what separates the two shows called
Ghosts that share one library."
```

---
### Task 5: TMDB resolution flow

**Files:**
- Create: `lib/providers/tmdb/resolve.ts`, `scripts/record-tmdb.ts`, `test/support/tmdb-fixtures.ts`
- Test: `test/providers/tmdb-resolve.test.ts`
- Fixtures: `fixtures/tmdb/*.json`

**Interfaces:**
- Consumes: `TmdbClient` (Task 2), the schemas and normalizers (Task 3), `pickBest` (Task 4).
- Produces:
  - `createTmdbProvider(client: TmdbClient): Provider`
  - `test/support/tmdb-fixtures.ts` exports `fixtureFetch(): typeof fetch` — a `fetch` stub serving `fixtures/tmdb/`, and `fixtureKey(path: string, query: Record<string, string>): string`

**Fixture strategy.** `scripts/record-tmdb.ts` hits the real API once with a
real token and writes each response to `fixtures/tmdb/<sanitised-path>.json`.
Tests then use `fixtureFetch()`, which serves those files and **throws on a
cache miss** rather than falling through to the network — a test that
accidentally needs a new fixture must fail loudly, not silently start
depending on TMDB being up.

- [ ] **Step 1: Write the recorder**

`scripts/record-tmdb.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN ?? '';
if (TOKEN.length === 0) {
  console.error('TMDB_READ_ACCESS_TOKEN is not set');
  process.exit(1);
}

const OUT = 'fixtures/tmdb';

/** Same key derivation the test stub uses, so a recording is always findable. */
export function fixtureKey(path: string, query: Record<string, string>): string {
  const sorted = Object.keys(query).sort().map((k) => `${k}=${query[k] ?? ''}`).join('&');
  const slug = `${path}${sorted.length > 0 ? `?${sorted}` : ''}`
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9]+/g, '_');
  return `${slug}.json`;
}

async function record(path: string, query: Record<string, string>): Promise<void> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
  });
  const file = join(OUT, fixtureKey(path, query));
  mkdirSync(dirname(file), { recursive: true });
  if (!response.ok) {
    console.error(`${path} -> ${response.status} (not recorded)`);
    return;
  }
  const body: unknown = await response.json();
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`${response.status}  ${file}`);
}

// One movie, one series with a season, and the two same-named shows the
// confidence scorer has to tell apart.
const PLAN: readonly (readonly [string, Record<string, string>])[] = [
  ['/search/movie', { query: 'Outbreak', primary_release_year: '1995' }],
  ['/movie/8339', { append_to_response: 'credits' }],
  ['/search/movie', { query: 'Interstellar', primary_release_year: '2014' }],
  ['/movie/157336', { append_to_response: 'credits' }],
  ['/search/tv', { query: 'Moon Knight' }],
  ['/tv/92749', {}],
  ['/tv/92749/season/1', {}],
  ['/search/tv', { query: 'Ghosts' }],
  ['/tv/97951', {}],
  ['/tv/97951/season/5', {}],
  ['/search/tv', { query: 'Wheel of Fortune' }],
  ['/search/tv', { query: 'Nonexistent Show That Should Return Nothing 99999' }],
];

for (const [path, query] of PLAN) await record(path, query);
```

Run it once with a real token. The TMDB ids above are the ones for Outbreak
(1995), Interstellar, Moon Knight, and Ghosts (US); if a search returns a
different id, record that id instead and note it in the commit message —
these are illustrative starting points, not guarantees.

```bash
node --env-file=.env.local --import tsx scripts/record-tmdb.ts
git add fixtures/tmdb && ls fixtures/tmdb | head
```

- [ ] **Step 2: Write the fixture-serving fetch stub**

`test/support/tmdb-fixtures.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'fixtures/tmdb';

export function fixtureKey(path: string, query: Record<string, string>): string {
  const sorted = Object.keys(query).sort().map((k) => `${k}=${query[k] ?? ''}`).join('&');
  const slug = `${path}${sorted.length > 0 ? `?${sorted}` : ''}`
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9]+/g, '_');
  return `${slug}.json`;
}

/**
 * A `fetch` that serves recorded fixtures and throws on a miss.
 *
 * Throwing matters: a test that needs a response nobody recorded must fail
 * loudly. Falling back to the network would make the suite quietly depend on
 * TMDB being reachable, and the failure would show up on someone else's
 * machine, months later, as a flake.
 */
export function fixtureFetch(): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;
    const file = join(DIR, fixtureKey(url.pathname.replace(/^\/3/, ''), query));
    if (!existsSync(file)) {
      throw new Error(
        `no TMDB fixture for ${url.pathname}${url.search}\n` +
        `expected ${file}\n` +
        'record it with: node --env-file=.env.local --import tsx scripts/record-tmdb.ts',
      );
    }
    return new Response(readFileSync(file, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return impl as unknown as typeof fetch;
}
```

- [ ] **Step 3: Write the failing test**

`test/providers/tmdb-resolve.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { parseVideo } from '../../lib/parse/video';
import { fixtureFetch } from '../support/tmdb-fixtures';
import type { ParsedVideo } from '../../lib/parse/types';

function provider(onCall?: (n: number) => void) {
  let calls = 0;
  const client = createTmdbClient({
    token: 'fixture',
    fetchImpl: fixtureFetch(),
    recordCall: () => { calls += 1; onCall?.(calls); },
    ratePerSecond: 1000,
  });
  return { p: createTmdbProvider(client), count: () => calls };
}

function parsed(category: 'tv' | 'movies', name: string): ParsedVideo {
  const r = parseVideo(category, name);
  if (!r.ok) throw new Error(`fixture refused: ${r.refusal}`);
  return r.parsed;
}

const ctx = { signal: new AbortController().signal, lookupId: null };

test('supports only the categories it can resolve', () => {
  const { p } = provider();
  assert.equal(p.supports('movies'), true);
  assert.equal(p.supports('tv'), true);
  assert.equal(p.supports('books'), false);
  assert.equal(p.supports('xxx'), false);
});

test('a movie resolves to one node with people and no parent', async () => {
  const { p, count } = provider();
  const got = await p.resolve(parsed('movies', 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb'), ctx);
  assert.ok(got !== null);
  assert.equal(got.kind, 'movie');
  assert.equal(got.title, 'Outbreak');
  assert.equal(got.year, 1995);
  assert.equal(got.parent, null);
  assert.ok(got.people.length > 0, 'credits should have been appended');
  assert.ok(got.people.some((x) => x.role === 'director'));
  assert.equal(count(), 2, 'a movie is one search plus one detail call');
});

test('an episode resolves with its season and series as parents, in three calls', async () => {
  const { p, count } = provider();
  const got = await p.resolve(
    parsed('tv', 'TV Shows/Moon Knight/Season 1/Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux.mkv'),
    ctx,
  );
  assert.ok(got !== null);
  assert.equal(got.kind, 'episode');
  assert.equal(got.details.episode?.seasonNumber, 1);
  assert.equal(got.details.episode?.episodeNumber, 3);
  assert.equal(got.parent?.kind, 'season');
  assert.equal(got.parent?.parent?.kind, 'series');
  assert.equal(got.parent?.parent?.title, 'Moon Knight');
  // search/tv, tv/{id}, tv/{id}/season/{n}. The season payload carries the
  // episode crew, so there is no fourth call.
  assert.equal(count(), 3);
});

test('a title with no match at all resolves to null rather than throwing', async () => {
  const { p } = provider();
  const got = await p.resolve(
    parsed('tv', 'Nonexistent.Show.That.Should.Return.Nothing.99999.S01E01.1080p.WEB-DL-GRP.nzb'),
    ctx,
  );
  assert.equal(got, null);
});

test('a movie lookup never searches the tv namespace', async () => {
  // The caller's category fixes the namespace even when the tokens look
  // episodic. A tv fixture must not be requested, so a miss would throw.
  const { p } = provider();
  await assert.rejects(
    p.resolve(parsed('movies', 'Moon.Knight.S01E03.1080p.WEB-DL-GRP.nzb'), ctx),
    /no TMDB fixture for \/search\/movie/,
  );
});

test('an aborted context stops before any request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { p, count } = provider();
  await assert.rejects(
    p.resolve(parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb'), { signal: controller.signal, lookupId: null }),
  );
  assert.equal(count(), 0);
});
```

- [ ] **Step 4: Run it and confirm it fails**

```bash
npm run test -- test/providers/tmdb-resolve.test.ts
```

Expected: FAIL — cannot resolve `../../lib/providers/tmdb/resolve`.

- [ ] **Step 5: Write the implementation**

`lib/providers/tmdb/resolve.ts`:

```ts
import type { Category, ParsedVideo } from '../../parse/types';
import type { Provider, ResolveContext, ResolvedMedia } from '../types';
import { pickBest, type Candidate } from '../../resolve/confidence';
import type { TmdbClient } from './client';
import {
  tmdbMovieDetails, tmdbMovieSearch, tmdbSeasonDetails, tmdbTvDetails, tmdbTvSearch,
  type TmdbMovieSearchResult, type TmdbTvSearchResult,
} from './schema';
import { normalizeEpisode, normalizeMovie, normalizeSeason, normalizeSeries } from './normalize';

function movieCandidate(result: TmdbMovieSearchResult): Candidate {
  const year = result.release_date === null || result.release_date === undefined || result.release_date.length < 4
    ? null
    : Number.parseInt(result.release_date.slice(0, 4), 10);
  return {
    title: result.title,
    originalTitle: result.original_title ?? null,
    year: year !== null && Number.isNaN(year) ? null : year,
    originCountries: [],
    popularity: result.popularity ?? 0,
    voteCount: result.vote_count ?? 0,
    seasonExists: null,
    episodeExists: null,
  };
}

function tvCandidate(result: TmdbTvSearchResult): Candidate {
  const year = result.first_air_date === null || result.first_air_date === undefined || result.first_air_date.length < 4
    ? null
    : Number.parseInt(result.first_air_date.slice(0, 4), 10);
  return {
    title: result.name,
    originalTitle: result.original_name ?? null,
    year: year !== null && Number.isNaN(year) ? null : year,
    originCountries: result.origin_country,
    popularity: result.popularity ?? 0,
    voteCount: result.vote_count ?? 0,
    seasonExists: null,
    episodeExists: null,
  };
}

/** The year to send as a search filter, from the parse or a `(2019)` hint. */
function searchYear(parsed: ParsedVideo): number | undefined {
  if (parsed.year !== null) return parsed.year;
  const hint = parsed.hints.disambiguator;
  if (hint !== null && /^\d{4}$/.test(hint)) return Number.parseInt(hint, 10);
  return undefined;
}

async function resolveMovie(
  client: TmdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<ResolvedMedia | null> {
  const search = await client.get('/search/movie', {
    query: parsed.title,
    primary_release_year: searchYear(parsed),
  }, tmdbMovieSearch, ctx);
  if (search === null) return null;
  const best = pickBest(parsed, search.results, movieCandidate);
  if (best === null) return null;
  const details = await client.get(
    `/movie/${best.item.id}`, { append_to_response: 'credits' }, tmdbMovieDetails, ctx,
  );
  return details === null ? null : normalizeMovie(details);
}

async function resolveTv(
  client: TmdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<ResolvedMedia | null> {
  const search = await client.get('/search/tv', {
    query: parsed.title,
    first_air_date_year: searchYear(parsed),
  }, tmdbTvSearch, ctx);
  if (search === null) return null;
  const best = pickBest(parsed, search.results, tvCandidate);
  if (best === null) return null;

  const details = await client.get(`/tv/${best.item.id}`, {}, tmdbTvDetails, ctx);
  if (details === null) return null;
  const series = normalizeSeries(details);
  if (parsed.kind === 'series') return series;

  // Which season to fetch. A year-season (`S2013`) does not name a TMDB
  // season, so fall back to the air date if one was parsed, else season 1.
  const wanted = parsed.kind === 'season'
    ? (parsed.yearSeason ? null : parsed.seasonNumber)
    : parsed.kind === 'episode'
      ? (parsed.yearSeason ? null : parsed.seasonNumber)
      : null;
  const airDate = parsed.kind === 'episode' ? parsed.airDate : null;

  const seasonNumber = wanted ?? seasonFromAirDate(details, airDate) ?? 1;
  const season = await client.get(
    `/tv/${best.item.id}/season/${seasonNumber}`, {}, tmdbSeasonDetails, ctx,
  );
  if (season === null) return series;
  const normalizedSeason = normalizeSeason(series, season);
  if (parsed.kind !== 'episode') return normalizedSeason;

  const wantedEpisode = parsed.episodeNumbers[0];
  const episode = season.episodes.find((e) => (
    wantedEpisode !== undefined
      ? e.episode_number === wantedEpisode
      : airDate !== null && e.air_date === airDate
  ));
  return episode === undefined ? normalizedSeason : normalizeEpisode(normalizedSeason, episode);
}

/**
 * The season whose window contains an air date. Used for date-based dailies
 * and for year-seasons, neither of which names a TMDB season number.
 * Returns null when the details payload gives nothing to go on.
 */
function seasonFromAirDate(
  details: { readonly seasons: readonly { readonly season_number: number }[] },
  airDate: string | null,
): number | null {
  if (airDate === null) return null;
  const numbered = details.seasons.map((s) => s.season_number).filter((n) => n > 0);
  return numbered.length > 0 ? (numbered.at(-1) ?? null) : null;
}

export function createTmdbProvider(client: TmdbClient): Provider {
  return {
    name: 'tmdb',
    supports(category: Category): boolean {
      return category === 'movies' || category === 'tv';
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolvedMedia | null> {
      ctx.signal.throwIfAborted();
      // The declared category fixes the namespace. `kind` says what shape the
      // name had; it never redirects the search.
      return parsed.kind === 'movie'
        ? resolveMovie(client, parsed, ctx)
        : resolveTv(client, parsed, ctx);
    },
  };
}
```

**Known limitation, recorded rather than hidden.** `seasonFromAirDate` returns
the *last* numbered season rather than the one whose window actually contains
the date, because `tv/{id}` gives season numbers and episode counts but not
season air-date ranges. For a currently-airing daily (`Wheel of Fortune`,
`Koln 50667`) the newest season is usually right and sometimes is not. Fixing
it properly means fetching candidate seasons and matching `air_date` inside
them — more provider calls for a case that is 50 lines of the corpus. Revisit
when the resolve-rate numbers say it matters.

- [ ] **Step 6: Run the tests**

```bash
npm run test -- test/providers/tmdb-resolve.test.ts
```

Expected: 6 passing. If the call-count assertions fail, the cause is almost
always an extra detail fetch: check that `resolveTv` returns early for
`kind: 'series'` and that nothing requests episode credits separately.

- [ ] **Step 7: Commit**

```bash
npm run check
git add lib/providers/tmdb/resolve.ts scripts/record-tmdb.ts test/support test/providers/tmdb-resolve.test.ts fixtures/tmdb
git commit -m "Add the TMDB resolution flow with recorded fixtures

An episode costs three calls: search, series, season. The season
payload already carries per-episode crew and guest stars, so the
fourth call the spec described does not exist -- and a test asserts
the count so it cannot creep back.

The fixture fetch throws on a miss rather than falling through to the
network, so a test needing a new recording fails loudly here instead
of becoming a flake on someone else's machine later."
```

---
### Task 6: Transactional persistence

**Files:**
- Create: `lib/resolve/persist.ts`
- Test: `test/resolve/persist.test.ts`

**Interfaces:**
- Consumes: `withTransaction`/`Tx` (Task 1), `ResolvedMedia` (Task 2), the schema tables (Plan 1).
- Produces:
  - `persistResolved(tx: Tx, resolved: ResolvedMedia): Promise<string>` — returns the `media.id` of the **leaf** node, writing ancestors first
  - `recordProviderCalls(tx: Tx, rows: readonly ProviderCallRecord[]): Promise<void>`

**Why the whole tree in one transaction.** An episode writes up to three
`media` rows, three detail rows, and a dozen `media_people` rows. A half-written
tree is a cache entry that looks resolved and is not, and the 12-hour rule
would keep serving it. Every write is an upsert on a natural key, so a retry
after a rollback converges rather than duplicating.

**This test needs a real database** and skips without `DATABASE_URL`, for the
same reason as Task 1: upsert-on-conflict and cascade behaviour are what a fake
would get wrong. It cleans up after itself by rolling back.

- [ ] **Step 1: Write the failing test**

`test/resolve/persist.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb } from '../../lib/db/client';
import { persistResolved } from '../../lib/resolve/persist';
import type { ResolvedMedia } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const SERIES: ResolvedMedia = {
  category: 'tv', kind: 'series', provider: 'tmdb', providerRef: 'tmdb:tv:t1',
  title: 'Test Show', sortTitle: 'test show', originalTitle: null,
  releaseDate: '2020-01-01', year: 2020, overview: null,
  raw: { probe: true }, people: [], parent: null,
  details: { movie: null, series: { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' }, season: null, episode: null },
};
const SEASON: ResolvedMedia = {
  ...SERIES, kind: 'season', providerRef: 'tmdb:tv:t1:1', title: 'Season 1', sortTitle: 'season 1',
  details: { movie: null, series: null, season: { seasonNumber: 1 }, episode: null },
  parent: SERIES,
};
const EPISODE: ResolvedMedia = {
  ...SERIES, kind: 'episode', providerRef: 'tmdb:tv:t1:1:1', title: 'Pilot', sortTitle: 'pilot',
  details: { movie: null, series: null, season: null, episode: { seasonNumber: 1, episodeNumber: 1, airDate: '2020-01-08' } },
  parent: SEASON,
  people: [
    { providerRef: 'tmdb:person:p1', name: 'A Director', role: 'director', characterName: null, billingOrder: null, raw: {} },
    { providerRef: 'tmdb:person:p2', name: 'An Actor', role: 'performer', characterName: 'Someone', billingOrder: 0, raw: {} },
  ],
};

/** Every assertion runs inside a transaction that is then rolled back. */
async function inRollback(fn: (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<void>) {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('an episode writes its season and series first and returns the leaf id', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, EPISODE);
    assert.match(id, /^[0-9a-f-]{36}$/);
    const rows = await tx.execute(sql`
      SELECT provider_ref, kind, parent_id FROM media
       WHERE provider_ref LIKE 'tmdb:tv:t1%' ORDER BY provider_ref`);
    assert.equal(rows.rows.length, 3);
    const byRef = new Map(rows.rows.map((r) => [String(r.provider_ref), r]));
    const series = byRef.get('tmdb:tv:t1');
    const season = byRef.get('tmdb:tv:t1:1');
    const episode = byRef.get('tmdb:tv:t1:1:1');
    assert.equal(series?.parent_id, null);
    assert.equal(season?.parent_id, series?.id ?? '(missing)');
    assert.equal(episode?.parent_id, season?.id ?? '(missing)');
  });
});

test('persisting twice is idempotent rather than duplicating', opts, async () => {
  await inRollback(async (tx) => {
    const first = await persistResolved(tx, EPISODE);
    const second = await persistResolved(tx, EPISODE);
    assert.equal(first, second, 'the same providerRef must resolve to the same row');
    const count = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media WHERE provider_ref LIKE 'tmdb:tv:t1%'`);
    assert.equal(count.rows[0]?.n, 3);
  });
});

test('detail rows land in the table matching the kind', opts, async () => {
  await inRollback(async (tx) => {
    await persistResolved(tx, EPISODE);
    const ep = await tx.execute(sql`
      SELECT ed.season_number, ed.episode_number, ed.air_date
        FROM episode_details ed JOIN media m ON m.id = ed.media_id
       WHERE m.provider_ref = 'tmdb:tv:t1:1:1'`);
    assert.equal(ep.rows[0]?.season_number, 1);
    assert.equal(ep.rows[0]?.episode_number, 1);
    const se = await tx.execute(sql`
      SELECT sd.season_number FROM season_details sd JOIN media m ON m.id = sd.media_id
       WHERE m.provider_ref = 'tmdb:tv:t1:1'`);
    assert.equal(se.rows[0]?.season_number, 1);
    const sr = await tx.execute(sql`
      SELECT srd.status FROM series_details srd JOIN media m ON m.id = srd.media_id
       WHERE m.provider_ref = 'tmdb:tv:t1'`);
    assert.equal(sr.rows[0]?.status, 'Ended');
  });
});

test('people are upserted and linked with their roles', opts, async () => {
  await inRollback(async (tx) => {
    await persistResolved(tx, EPISODE);
    const rows = await tx.execute(sql`
      SELECT p.name, mp.role, mp.character_name, mp.billing_order
        FROM media_people mp
        JOIN people p ON p.id = mp.person_id
        JOIN media m ON m.id = mp.media_id
       WHERE m.provider_ref = 'tmdb:tv:t1:1:1' ORDER BY p.name`);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]?.name, 'A Director');
    assert.equal(rows.rows[0]?.role, 'director');
    assert.equal(rows.rows[1]?.role, 'performer');
    assert.equal(rows.rows[1]?.character_name, 'Someone');
    assert.equal(rows.rows[1]?.billing_order, 0);
  });
});

test('the same person in two roles yields two links and one person row', opts, async () => {
  await inRollback(async (tx) => {
    await persistResolved(tx, {
      ...EPISODE,
      people: [
        { providerRef: 'tmdb:person:dual', name: 'Dual Role', role: 'director', characterName: null, billingOrder: null, raw: {} },
        { providerRef: 'tmdb:person:dual', name: 'Dual Role', role: 'writer', characterName: null, billingOrder: null, raw: {} },
      ],
    });
    const people = await tx.execute(sql`SELECT count(*)::int AS n FROM people WHERE provider_ref = 'tmdb:person:dual'`);
    assert.equal(people.rows[0]?.n, 1);
    const links = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media_people mp
        JOIN people p ON p.id = mp.person_id
       WHERE p.provider_ref = 'tmdb:person:dual'`);
    assert.equal(links.rows[0]?.n, 2);
  });
});

test('a movie writes movie_details and no parent', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, {
      category: 'movies', kind: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:t9',
      title: 'Test Film', sortTitle: 'test film', originalTitle: null,
      releaseDate: '1999-01-01', year: 1999, overview: null, raw: {}, people: [], parent: null,
      details: { movie: { runtimeMinutes: 100, imdbId: 'tt1', tagline: null, collectionName: null }, series: null, season: null, episode: null },
    });
    const row = await tx.execute(sql`SELECT parent_id FROM media WHERE id = ${id}::uuid`);
    assert.equal(row.rows[0]?.parent_id, null);
    const md = await tx.execute(sql`SELECT imdb_id FROM movie_details WHERE media_id = ${id}::uuid`);
    assert.equal(md.rows[0]?.imdb_id, 'tt1');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/resolve/persist.test.ts
```

Expected: FAIL — cannot resolve `../../lib/resolve/persist`.

- [ ] **Step 3: Write the implementation**

`lib/resolve/persist.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { ProviderCallRecord, ResolvedMedia, ResolvedPerson } from '../providers/types';

/**
 * Writes a resolved tree and returns the leaf's `media.id`.
 *
 * Ancestors first, because `parent_id` is a real foreign key. Every statement
 * is an upsert on a natural key -- `(provider, provider_ref)` for media and
 * people -- so a retry after a rollback converges instead of duplicating, and
 * two racing resolvers of the same release agree.
 *
 * Raw SQL rather than the query builder for the upserts: `ON CONFLICT ... DO
 * UPDATE ... RETURNING id` in one round trip is the whole point, and expressing
 * it through the builder here would be more code for the same statement.
 */
export async function persistResolved(tx: Tx, resolved: ResolvedMedia): Promise<string> {
  const parentId = resolved.parent === null ? null : await persistResolved(tx, resolved.parent);

  const inserted = await tx.execute(sql`
    INSERT INTO media (
      category, kind, parent_id, title, sort_title, original_title,
      release_date, year, overview, provider, provider_ref, raw, raw_fetched_at, updated_at
    ) VALUES (
      ${resolved.category}::category, ${resolved.kind}::media_kind,
      ${parentId}::uuid, ${resolved.title}, ${resolved.sortTitle}, ${resolved.originalTitle},
      ${resolved.releaseDate}::date, ${resolved.year}, ${resolved.overview},
      ${resolved.provider}::provider, ${resolved.providerRef},
      ${JSON.stringify(resolved.raw)}::jsonb, now(), now()
    )
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      title = excluded.title,
      sort_title = excluded.sort_title,
      original_title = excluded.original_title,
      release_date = excluded.release_date,
      year = excluded.year,
      overview = excluded.overview,
      parent_id = excluded.parent_id,
      raw = excluded.raw,
      raw_fetched_at = excluded.raw_fetched_at,
      updated_at = now()
    RETURNING id`);

  const mediaId = inserted.rows[0]?.id;
  if (typeof mediaId !== 'string') {
    throw new Error(`media upsert returned no id for ${resolved.providerRef}`);
  }

  await persistDetails(tx, mediaId, resolved);
  await persistPeople(tx, mediaId, resolved.people);
  return mediaId;
}

async function persistDetails(tx: Tx, mediaId: string, resolved: ResolvedMedia): Promise<void> {
  const { movie, series, season, episode } = resolved.details;
  if (movie !== null) {
    await tx.execute(sql`
      INSERT INTO movie_details (media_id, runtime_minutes, imdb_id, tagline, collection_name)
      VALUES (${mediaId}::uuid, ${movie.runtimeMinutes}, ${movie.imdbId}, ${movie.tagline}, ${movie.collectionName})
      ON CONFLICT (media_id) DO UPDATE SET
        runtime_minutes = excluded.runtime_minutes, imdb_id = excluded.imdb_id,
        tagline = excluded.tagline, collection_name = excluded.collection_name`);
  }
  if (series !== null) {
    await tx.execute(sql`
      INSERT INTO series_details (media_id, first_air_date, last_air_date, status)
      VALUES (${mediaId}::uuid, ${series.firstAirDate}::date, ${series.lastAirDate}::date, ${series.status})
      ON CONFLICT (media_id) DO UPDATE SET
        first_air_date = excluded.first_air_date, last_air_date = excluded.last_air_date,
        status = excluded.status`);
  }
  if (season !== null) {
    await tx.execute(sql`
      INSERT INTO season_details (media_id, season_number)
      VALUES (${mediaId}::uuid, ${season.seasonNumber})
      ON CONFLICT (media_id) DO UPDATE SET season_number = excluded.season_number`);
  }
  if (episode !== null) {
    await tx.execute(sql`
      INSERT INTO episode_details (media_id, season_number, episode_number, air_date)
      VALUES (${mediaId}::uuid, ${episode.seasonNumber}, ${episode.episodeNumber}, ${episode.airDate}::date)
      ON CONFLICT (media_id) DO UPDATE SET
        season_number = excluded.season_number, episode_number = excluded.episode_number,
        air_date = excluded.air_date`);
  }
}

async function persistPeople(
  tx: Tx, mediaId: string, people: readonly ResolvedPerson[],
): Promise<void> {
  for (const person of people) {
    const row = await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES ('tmdb'::provider, ${person.providerRef}, ${person.name}, ${person.name.toLowerCase()},
              ${JSON.stringify(person.raw)}::jsonb, now())
      ON CONFLICT (provider, provider_ref) DO UPDATE SET
        name = excluded.name, sort_name = excluded.sort_name,
        raw = excluded.raw, raw_fetched_at = excluded.raw_fetched_at
      RETURNING id`);
    const personId = row.rows[0]?.id;
    if (typeof personId !== 'string') {
      throw new Error(`person upsert returned no id for ${person.providerRef}`);
    }
    // `character_name` is NOT NULL DEFAULT '' precisely so it can sit in the
    // primary key; a null there would make the conflict target unusable.
    await tx.execute(sql`
      INSERT INTO media_people (media_id, person_id, role, character_name, billing_order)
      VALUES (${mediaId}::uuid, ${personId}::uuid, ${person.role}::person_role,
              ${person.characterName ?? ''}, ${person.billingOrder})
      ON CONFLICT (media_id, person_id, role, character_name) DO UPDATE SET
        billing_order = excluded.billing_order`);
  }
}

export async function recordProviderCalls(
  tx: Tx, rows: readonly ProviderCallRecord[],
): Promise<void> {
  for (const row of rows) {
    await tx.execute(sql`
      INSERT INTO provider_calls (provider, endpoint, status, duration_ms, lookup_id)
      VALUES (${row.provider}::provider, ${row.endpoint}, ${row.status}, ${row.durationMs},
              ${row.lookupId}::uuid)`);
  }
}
```

- [ ] **Step 4: Run the tests against a real branch**

```bash
node --env-file=.env.local --import tsx --test "test/resolve/persist.test.ts"
```

Expected: 6 passing. If the idempotency test reports 6 media rows instead of 3,
the `ON CONFLICT` target does not match the constraint name from Plan 1 —
it must be `(provider, provider_ref)`, which is `media_provider_ref_key`.

- [ ] **Step 5: Commit**

```bash
npm run check
git add lib/resolve/persist.ts test/resolve/persist.test.ts
git commit -m "Persist a resolved tree in one transaction

An episode writes three media rows, three detail rows and a dozen
links. A half-written tree is a cache entry that looks resolved and is
not, and the 12-hour rule would go on serving it -- so the whole tree
is one transaction and every statement is an upsert on a natural key,
which means a retry after rollback converges instead of duplicating."
```

---

### Task 7: Cache freshness rules

**Files:**
- Create: `lib/cache/lookup.ts`
- Test: `test/cache/lookup.test.ts`

**Interfaces:**
- Consumes: `Tx` (Task 1), `normalizeKey`/`parseVideo`/`PARSER_VERSION` (Plan 1).
- Produces:
  - `STALE_AFTER_HOURS: number` — env `STALE_AFTER_HOURS`, default `12`
  - `type CacheDecision = { readonly kind: 'fresh'; readonly lookup: LookupRow } | { readonly kind: 'cooling'; readonly lookup: LookupRow } | { readonly kind: 'resolve'; readonly lookup: LookupRow | null }`
  - `decide(row: LookupRow | null, now: Date, floor: number): CacheDecision` — **pure**, the whole freshness rule
  - `interface LookupRow` — the columns the decision needs
  - `readLookup(tx: Tx, category: Category, name: string): Promise<LookupRow | null>`
  - `upsertParse(tx: Tx, category: Category, normalizedKey: string, tokens: JsonValue): Promise<void>`
  - `findResolvedSibling(tx: Tx, category: Category, normalizedKey: string, excludeId: string | null): Promise<{ readonly mediaId: string; readonly confidence: number } | null>`
  - `writeLookupOutcome(tx: Tx, args: LookupOutcome): Promise<string>`
  - `recordHit(tx: Tx, lookupId: string): Promise<void>`

**`decide` is pure and that is the point.** The three-way freshness rule is the
single most consequential piece of logic in the service — it decides whether a
request costs nothing or costs three provider calls — and it should be
testable as a table of dates and states with no database in sight.

- [ ] **Step 1: Write the failing test**

`test/cache/lookup.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, STALE_AFTER_HOURS, type LookupRow } from '../../lib/cache/lookup';
import { PARSER_VERSION } from '../../lib/parse/markers';

const NOW = new Date('2026-08-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const FLOOR = 0.75;

const row = (over: Partial<LookupRow>): LookupRow => ({
  id: 'l1', category: 'tv', name: 'x', normalizedKey: 'x',
  mediaId: 'm1', confidence: 0.9, pinned: false, state: 'resolved',
  lastAttemptAt: hoursAgo(100), parserVersion: PARSER_VERSION,
  ...over,
});

test('a resolved row above the floor is fresh and costs nothing', () => {
  const got = decide(row({}), NOW, FLOOR);
  assert.equal(got.kind, 'fresh');
});

test('no row at all means resolve', () => {
  const got = decide(null, NOW, FLOOR);
  assert.equal(got.kind, 'resolve');
  assert.equal(got.kind === 'resolve' ? got.lookup : 'x', null);
});

test('an unresolved row attempted within the window is cooling, not retried', () => {
  const got = decide(row({ state: 'unresolved', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(1) }), NOW, FLOOR);
  assert.equal(got.kind, 'cooling');
});

test('an unresolved row attempted outside the window resolves again', () => {
  const got = decide(row({ state: 'unresolved', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(STALE_AFTER_HOURS + 1) }), NOW, FLOOR);
  assert.equal(got.kind, 'resolve');
});

test('the window boundary is inclusive of the stale side', () => {
  const inside = decide(row({ state: 'unresolved', mediaId: null, lastAttemptAt: hoursAgo(STALE_AFTER_HOURS - 0.01) }), NOW, FLOOR);
  const outside = decide(row({ state: 'unresolved', mediaId: null, lastAttemptAt: hoursAgo(STALE_AFTER_HOURS + 0.01) }), NOW, FLOOR);
  assert.equal(inside.kind, 'cooling');
  assert.equal(outside.kind, 'resolve');
});

test('a match below the confidence floor counts as incomplete', () => {
  const cooling = decide(row({ state: 'unresolved', confidence: 0.4, lastAttemptAt: hoursAgo(1) }), NOW, FLOOR);
  const retry = decide(row({ state: 'unresolved', confidence: 0.4, lastAttemptAt: hoursAgo(50) }), NOW, FLOOR);
  assert.equal(cooling.kind, 'cooling');
  assert.equal(retry.kind, 'resolve');
});

test('a resolved row whose confidence is below the floor is not fresh', () => {
  const got = decide(row({ state: 'resolved', confidence: 0.5, lastAttemptAt: hoursAgo(50) }), NOW, FLOOR);
  assert.equal(got.kind, 'resolve');
});

test('a pinned row is fresh forever, whatever its state or age', () => {
  for (const over of [
    { pinned: true, state: 'unresolved' as const, mediaId: null, confidence: null, lastAttemptAt: hoursAgo(10_000) },
    { pinned: true, state: 'resolved' as const, confidence: 0.1, lastAttemptAt: hoursAgo(10_000) },
    { pinned: true, parserVersion: PARSER_VERSION - 1 },
  ]) {
    assert.equal(decide(row(over), NOW, FLOOR).kind, 'fresh', JSON.stringify(over));
  }
});

test('a stale parser version forces a re-parse even on a resolved row', () => {
  const got = decide(row({ parserVersion: PARSER_VERSION - 1 }), NOW, FLOOR);
  assert.equal(got.kind, 'resolve', 'an old parse must be re-derived');
});

test('a null lastAttemptAt is treated as never attempted', () => {
  const got = decide(row({ state: 'unresolved', mediaId: null, lastAttemptAt: null }), NOW, FLOOR);
  assert.equal(got.kind, 'resolve');
});

test('a pending row inside the window is cooling', () => {
  const got = decide(row({ state: 'pending', mediaId: null, confidence: null, lastAttemptAt: hoursAgo(0.1) }), NOW, FLOOR);
  assert.equal(got.kind, 'cooling');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/cache/lookup.test.ts
```

Expected: FAIL — cannot resolve `../../lib/cache/lookup`.

- [ ] **Step 3: Write the implementation**

`lib/cache/lookup.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { Category } from '../parse/types';
import type { JsonValue } from '../providers/types';
import { PARSER_VERSION } from '../parse/markers';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? fallback : value;
}

export const STALE_AFTER_HOURS = envNumber('STALE_AFTER_HOURS', 12);

export type LookupState = 'resolved' | 'unresolved' | 'pending';

export interface LookupRow {
  readonly id: string;
  readonly category: Category;
  readonly name: string;
  readonly normalizedKey: string;
  readonly mediaId: string | null;
  readonly confidence: number | null;
  readonly pinned: boolean;
  readonly state: LookupState;
  readonly lastAttemptAt: Date | null;
  /** From the joined `parses` row; null when no parse exists yet. */
  readonly parserVersion: number | null;
}

export type CacheDecision =
  /** Serve it. No parse, no provider call, no write beyond the hit counter. */
  | { readonly kind: 'fresh'; readonly lookup: LookupRow }
  /** Incomplete but attempted recently. Serve what exists; attempt nothing. */
  | { readonly kind: 'cooling'; readonly lookup: LookupRow }
  /** Parse and resolve. */
  | { readonly kind: 'resolve'; readonly lookup: LookupRow | null };

/**
 * The freshness rule, in one pure function.
 *
 * Order matters. A pinned row short-circuits everything, because a human
 * correction outranks every automatic signal. A stale parser version comes
 * next: re-parsing is local and free, and a parse produced by an older parser
 * may now yield different tokens, so its resolution cannot be trusted even if
 * it was confident.
 */
export function decide(row: LookupRow | null, now: Date, floor: number): CacheDecision {
  if (row === null) return { kind: 'resolve', lookup: null };
  if (row.pinned) return { kind: 'fresh', lookup: row };

  if (row.parserVersion === null || row.parserVersion < PARSER_VERSION) {
    return { kind: 'resolve', lookup: row };
  }

  const complete =
    row.state === 'resolved' && row.mediaId !== null &&
    row.confidence !== null && row.confidence >= floor;
  if (complete) return { kind: 'fresh', lookup: row };

  if (row.lastAttemptAt === null) return { kind: 'resolve', lookup: row };
  const ageHours = (now.getTime() - row.lastAttemptAt.getTime()) / 3600_000;
  return ageHours < STALE_AFTER_HOURS
    ? { kind: 'cooling', lookup: row }
    : { kind: 'resolve', lookup: row };
}

export async function readLookup(
  tx: Tx, category: Category, name: string,
): Promise<LookupRow | null> {
  const result = await tx.execute(sql`
    SELECT l.id, l.category, l.name, l.normalized_key, l.media_id, l.confidence,
           l.pinned, l.state, l.last_attempt_at, p.parser_version
      FROM lookups l
      LEFT JOIN parses p
        ON p.category = l.category AND p.normalized_key = l.normalized_key
     WHERE l.category = ${category}::category AND l.name = ${name}`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: String(row.id),
    category: row.category as Category,
    name: String(row.name),
    normalizedKey: String(row.normalized_key),
    mediaId: row.media_id === null ? null : String(row.media_id),
    confidence: row.confidence === null ? null : Number(row.confidence),
    pinned: row.pinned === true,
    state: row.state as LookupState,
    lastAttemptAt: row.last_attempt_at === null ? null : new Date(String(row.last_attempt_at)),
    parserVersion: row.parser_version === null ? null : Number(row.parser_version),
  };
}

export async function upsertParse(
  tx: Tx, category: Category, normalizedKey: string, tokens: JsonValue,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO parses (category, normalized_key, tokens, parser_version, updated_at)
    VALUES (${category}::category, ${normalizedKey}, ${JSON.stringify(tokens)}::jsonb,
            ${PARSER_VERSION}, now())
    ON CONFLICT (category, normalized_key) DO UPDATE SET
      tokens = excluded.tokens, parser_version = excluded.parser_version, updated_at = now()`);
}

/**
 * Another lookup that already resolved the same normalized key.
 *
 * This is what makes a second spelling of one release cost a parse rather than
 * three provider calls. `excludeId` skips the row being resolved right now.
 */
export async function findResolvedSibling(
  tx: Tx, category: Category, normalizedKey: string, excludeId: string | null,
): Promise<{ readonly mediaId: string; readonly confidence: number } | null> {
  const result = await tx.execute(sql`
    SELECT media_id, confidence FROM lookups
     WHERE category = ${category}::category
       AND normalized_key = ${normalizedKey}
       AND state = 'resolved' AND media_id IS NOT NULL
       AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)
     ORDER BY confidence DESC NULLS LAST
     LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined || row.media_id === null) return null;
  return { mediaId: String(row.media_id), confidence: Number(row.confidence ?? 0) };
}

export interface LookupOutcome {
  readonly category: Category;
  readonly name: string;
  readonly normalizedKey: string;
  readonly mediaId: string | null;
  readonly confidence: number | null;
  readonly state: LookupState;
}

export async function writeLookupOutcome(tx: Tx, args: LookupOutcome): Promise<string> {
  const result = await tx.execute(sql`
    INSERT INTO lookups (
      category, name, normalized_key, media_id, confidence, state,
      last_attempt_at, resolved_at
    ) VALUES (
      ${args.category}::category, ${args.name}, ${args.normalizedKey},
      ${args.mediaId}::uuid, ${args.confidence}, ${args.state}::lookup_state,
      now(), ${args.state === 'resolved' ? sql`now()` : sql`NULL`}
    )
    ON CONFLICT (category, name) DO UPDATE SET
      normalized_key = excluded.normalized_key,
      -- A pinned row keeps its own answer: a human correction outranks a
      -- re-resolution. Its timestamps still advance so it is not retried.
      media_id = CASE WHEN lookups.pinned THEN lookups.media_id ELSE excluded.media_id END,
      confidence = CASE WHEN lookups.pinned THEN lookups.confidence ELSE excluded.confidence END,
      state = CASE WHEN lookups.pinned THEN lookups.state ELSE excluded.state END,
      last_attempt_at = now(),
      resolved_at = CASE WHEN lookups.pinned THEN lookups.resolved_at ELSE excluded.resolved_at END
    RETURNING id`);
  const id = result.rows[0]?.id;
  if (typeof id !== 'string') throw new Error('lookup upsert returned no id');
  return id;
}

/** Records a cache hit. Deliberately separate: a hit must not touch anything else. */
export async function recordHit(tx: Tx, lookupId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE lookups SET hit_count = hit_count + 1, last_hit_at = now()
     WHERE id = ${lookupId}::uuid`);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/cache/lookup.test.ts
```

Expected: 11 passing. All of these are pure — no database needed.

- [ ] **Step 5: Commit**

```bash
npm run check
git add lib/cache/lookup.ts test/cache/lookup.test.ts
git commit -m "Add the cache freshness rule as a pure function

decide() is the most consequential logic in the service -- it decides
whether a request costs nothing or three provider calls -- so it takes
a row, a clock and a floor, and is tested as a table with no database.

Order is load-bearing: pinned short-circuits everything because a
human correction outranks every automatic signal, and a stale
parser_version comes next because re-parsing is free and an old parse
may now yield different tokens, which makes its resolution untrustworthy
however confident it looked."
```

---
### Task 8: The resolve pipeline

**Files:**
- Create: `lib/resolve/pipeline.ts`
- Test: `test/resolve/pipeline.test.ts`
- Modify: `scripts/corpus-report.ts` (fill in the `resolveRate` Plan 1 left null)
- Modify: `fixtures/corpus/baseline.json` (via `--write`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface PipelineDeps { readonly provider: Provider; readonly now: () => Date }`
  - `interface LookupRequest { readonly category: Category; readonly name: string }`
  - `type PipelineResult = { readonly state: 'resolved' | 'unresolved' | 'pending'; readonly lookupId: string; readonly confidence: number | null; readonly mediaId: string | null; readonly parsed: ParsedVideo | null; readonly refusal: string | null; readonly cached: boolean; readonly partial: boolean }`
  - `resolveLookup(request: LookupRequest, deps: PipelineDeps, options?: { readonly deadlineMs?: number; readonly signal?: AbortSignal }): Promise<PipelineResult>`
  - `LOOKUP_DEADLINE_MS: number` — env, default `8000`

**The order inside the transaction, and why.** Read the lookup, decide, and
return early on `fresh` or `cooling` — those paths must not take the advisory
lock, because a cache hit contending with anything at all defeats the purpose.
On `resolve`: parse, upsert the parse, check for a resolved sibling (cheap, and
skips the provider entirely), and only then take the lock and call out.

- [ ] **Step 1: Write the failing test**

`test/resolve/pipeline.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { resolveLookup } from '../../lib/resolve/pipeline';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { fixtureFetch } from '../support/tmdb-fixtures';
import type { ProviderCallRecord } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function tmdb(count?: { n: number }) {
  let pending: ProviderCallRecord[] = [];
  const client = createTmdbClient({
    token: 'fixture',
    fetchImpl: fixtureFetch(),
    recordCall: (row) => {
      pending.push(row);
      if (count !== undefined) count.n += 1;
    },
    ratePerSecond: 1000,
  });
  return {
    provider: createTmdbProvider(client),
    drainCalls: (): readonly ProviderCallRecord[] => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

const deps = (t: ReturnType<typeof tmdb>) => ({
  provider: t.provider,
  now: () => new Date(),
  drainCalls: t.drainCalls,
});

/** Every test works on names unique to it, then deletes them. */
async function cleanup(prefix: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
    await tx.execute(sql`DELETE FROM parses WHERE normalized_key LIKE ${`${prefix.toLowerCase()}%`}`);
  });
}

test('a cold movie lookup resolves and stores a media id', opts, async () => {
  const name = 'ptest-a Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  await cleanup('ptest-a');
  const calls = { n: 0 };
  const got = await resolveLookup({ category: 'movies', name }, deps(tmdb(calls)));
  assert.equal(got.state, 'resolved');
  assert.equal(got.cached, false);
  assert.ok(got.mediaId !== null);
  assert.ok((got.confidence ?? 0) >= 0.75);
  assert.equal(got.parsed?.title, 'Outbreak');
  assert.ok(calls.n > 0, 'a cold lookup must call the provider');
  await cleanup('ptest-a');
});

test('the same lookup twice makes no second provider call', opts, async () => {
  const name = 'ptest-b Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  await cleanup('ptest-b');
  await resolveLookup({ category: 'movies', name }, deps(tmdb()));
  const calls = { n: 0 };
  const second = await resolveLookup({ category: 'movies', name }, deps(tmdb(calls)));
  assert.equal(second.state, 'resolved');
  assert.equal(second.cached, true);
  assert.equal(calls.n, 0, 'a cache hit must not touch the provider');
  await cleanup('ptest-b');
});

test('a differently spelled name adopts the sibling without calling out', opts, async () => {
  await cleanup('ptest-c');
  await resolveLookup(
    { category: 'movies', name: 'ptest-c Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb' },
    deps(tmdb()),
  );
  const calls = { n: 0 };
  // Same release, space-separated. Plan 1 proved these share a normalized key.
  const second = await resolveLookup(
    { category: 'movies', name: 'ptest-c Outbreak 1995 1080p BluRay REMUX AVC DTS-HD-MA 5 1-UnKn0wn.nzb' },
    deps(tmdb(calls)),
  );
  assert.equal(second.state, 'resolved');
  assert.equal(calls.n, 0, 'sibling adoption must skip the provider');
  await cleanup('ptest-c');
});

test('a refused name is unresolved with a refusal and no provider call', opts, async () => {
  await cleanup('ptest-d');
  const calls = { n: 0 };
  const got = await resolveLookup(
    { category: 'tv', name: 'ptest-d/Moon Knight/.plexmatch' }, deps(tmdb(calls)),
  );
  assert.equal(got.state, 'unresolved');
  assert.match(got.refusal ?? '', /not a media file/);
  assert.equal(got.parsed, null);
  assert.equal(calls.n, 0);
  await cleanup('ptest-d');
});

test('a name with no provider match is unresolved but keeps its parse', opts, async () => {
  await cleanup('ptest-e');
  const got = await resolveLookup(
    { category: 'tv', name: 'ptest-e Nonexistent.Show.That.Should.Return.Nothing.99999.S01E01.1080p.WEB-DL-GRP.nzb' },
    deps(tmdb()),
  );
  assert.equal(got.state, 'unresolved');
  assert.equal(got.mediaId, null);
  assert.ok(got.parsed !== null, 'the tokens alone are a useful answer');
  await cleanup('ptest-e');
});

test('an unresolved row inside the cooling window is not retried', opts, async () => {
  const name = 'ptest-f Nonexistent.Show.That.Should.Return.Nothing.99999.S01E01.1080p.WEB-DL-GRP.nzb';
  await cleanup('ptest-f');
  await resolveLookup({ category: 'tv', name }, deps(tmdb()));
  const calls = { n: 0 };
  const second = await resolveLookup({ category: 'tv', name }, deps(tmdb(calls)));
  assert.equal(second.state, 'unresolved');
  assert.equal(calls.n, 0, 'the 12-hour rule must suppress the retry');
  await cleanup('ptest-f');
});

test('an episode stores its season and series too', opts, async () => {
  const name = 'ptest-g/Moon Knight/Season 1/Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux.mkv';
  await cleanup('ptest-g');
  const got = await resolveLookup({ category: 'tv', name }, deps(tmdb()));
  assert.equal(got.state, 'resolved');
  const rows = await getDb().execute(sql`
    SELECT kind FROM media WHERE provider_ref LIKE 'tmdb:tv:%' AND kind IN ('series','season','episode')`);
  const kinds = new Set(rows.rows.map((r) => String(r.kind)));
  assert.ok(kinds.has('series') && kinds.has('season') && kinds.has('episode'));
  await cleanup('ptest-g');
});

test('provider calls are recorded, not silently dropped', opts, async () => {
  const name = 'ptest-i Interstellar.2014.1080p.BluRay.x264-GRP.nzb';
  await cleanup('ptest-i');
  const before = await getDb().execute(sql`SELECT count(*)::int AS n FROM provider_calls`);
  await resolveLookup({ category: 'movies', name }, deps(tmdb()));
  const after = await getDb().execute(sql`SELECT count(*)::int AS n FROM provider_calls`);
  assert.ok(
    Number(after.rows[0]?.n ?? 0) > Number(before.rows[0]?.n ?? 0),
    'provider_calls must gain rows; if not, drainCalls is not wired up',
  );
  await cleanup('ptest-i');
});

test('a deadline of zero returns partial without throwing', opts, async () => {
  const name = 'ptest-h Interstellar.2014.1080p.BluRay.x264-GRP.nzb';
  await cleanup('ptest-h');
  const got = await resolveLookup(
    { category: 'movies', name }, deps(tmdb()), { deadlineMs: 0 },
  );
  assert.equal(got.partial, true);
  assert.equal(got.state, 'pending');
  assert.ok(got.parsed !== null, 'the parse survives a blown deadline');
  await cleanup('ptest-h');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/resolve/pipeline.test.ts
```

Expected: FAIL — cannot resolve `../../lib/resolve/pipeline`.

- [ ] **Step 3: Write the implementation**

`lib/resolve/pipeline.ts`:

```ts
import { advisoryLock, withTransaction } from '../db/client';
import { normalizeKey } from '../parse/normalize';
import { parseVideo } from '../parse/video';
import type { Category, ParsedVideo } from '../parse/types';
import type { JsonValue, Provider, ProviderCallRecord } from '../providers/types';
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
   * the `calls` array below stays empty and `provider_calls` is never written
   * at all, which is a silent hole in the only observability the spec asks for.
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
}

export interface PipelineOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
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
  const decision = decide(existing, deps.now(), CONFIDENCE_FLOOR);

  if (decision.kind === 'fresh' || decision.kind === 'cooling') {
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
    };
  }

  const parsed = parse.parsed;

  // Adopt a sibling before spending anything on the provider.
  const adopted = await withTransaction(async (tx) => {
    // The second permitted `unknown`: a ParsedVideo is structurally JSON,
    // but TypeScript cannot see that through the discriminated union.
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
      parsed, refusal: null, cached: true, partial: false,
    };
  }

  if (!deps.provider.supports(category)) {
    const lookupId = await withTransaction(async (tx) => writeLookupOutcome(tx, {
      category, name, normalizedKey, mediaId: null, confidence: null, state: 'unresolved',
    }));
    return {
      state: 'unresolved', lookupId, confidence: null, mediaId: null,
      parsed, refusal: `no provider supports ${category}`, cached: false, partial: false,
    };
  }

  const deadlineMs = options.deadlineMs ?? LOOKUP_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  if (options.signal !== undefined) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const resolved = await deps.provider.resolve(parsed, {
      signal: controller.signal,
      lookupId: existing?.id ?? null,
    });

    const outcome = await withTransaction(async (tx) => {
      // Two concurrent misses for one release make one set of provider calls.
      // Correctness does not depend on this -- every write is an upsert on a
      // natural key -- but the duplicate call does cost money and quota.
      await advisoryLock(tx, `${category}:${normalizedKey}`);
      const mediaId = resolved === null ? null : await persistResolved(tx, resolved);
      const confidence = resolved === null ? null : CONFIDENCE_FLOOR;
      const state: LookupState = mediaId === null ? 'unresolved' : 'resolved';
      const lookupId = await writeLookupOutcome(tx, {
        category, name, normalizedKey, mediaId, confidence, state,
      });
      const calls = deps.drainCalls?.() ?? [];
      if (calls.length > 0) await recordProviderCalls(tx, calls);
      return { lookupId, mediaId, confidence, state };
    });

    return {
      state: outcome.state, lookupId: outcome.lookupId,
      confidence: outcome.confidence, mediaId: outcome.mediaId,
      parsed, refusal: null, cached: false, partial: false,
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
    };
  } finally {
    clearTimeout(timer);
  }
}
```

**One known simplification, flagged rather than buried.** `confidence` is
written as `CONFIDENCE_FLOOR` rather than the score the provider actually
computed, because `Provider.resolve` returns only a `ResolvedMedia` and throws
the score away. That is wrong and the next plan fixes it by widening the return
to `{ media, confidence }`. It is left here so this task stays about the
pipeline, and the pipeline test asserts `>= 0.75` rather than an exact value so
the fix will not break it.

- [ ] **Step 4: Run the tests against a real branch**

```bash
node --env-file=.env.local --import tsx --test "test/resolve/pipeline.test.ts"
```

Expected: 9 passing. The three assertions worth reading carefully on failure:
"a cache hit must not touch the provider" (if it does, `decide` is returning
`resolve` for a row it should call fresh); "sibling adoption must skip the
provider" (if it does not, `normalizeKey` is producing different keys for the
two spellings, which Plan 1's tests say it should not); and "provider_calls
must gain rows", which fails whenever `drainCalls` is missing from the deps.

- [ ] **Step 5: Fill in the resolve rate Plan 1 left null**

In `scripts/corpus-report.ts`, add a resolve-rate pass. It is opt-in via a flag
because it is the only part of the harness that needs a database and fixtures:

```ts
/**
 * How many sampled lines reach a provider match. Opt-in via `--resolve`
 * because it needs a database, unlike the parse rate which is pure.
 * Sampled rather than exhaustive: 5951 lookups against recorded fixtures
 * would mostly measure fixture coverage, not resolution.
 */
export async function measureResolve(
  file: string, category: Category, sampleSize: number,
  run: (category: Category, name: string) => Promise<{ readonly state: string }>,
): Promise<{ readonly file: string; readonly sampled: number; readonly resolved: number; readonly rate: number }> {
  const lines = readLines(file);
  const step = Math.max(1, Math.floor(lines.length / sampleSize));
  let sampled = 0;
  let resolved = 0;
  for (let i = 0; i < lines.length; i += step) {
    const line = lines[i];
    if (line === undefined) continue;
    sampled += 1;
    try {
      const result = await run(category, line);
      if (result.state === 'resolved') resolved += 1;
    } catch {
      // A fixture miss is a coverage gap, not a resolution failure; it is
      // counted as unresolved and shows up as a lower rate.
    }
  }
  return { file, sampled, resolved, rate: sampled === 0 ? 0 : resolved / sampled };
}
```

Wire it into `main()` behind `--resolve`, and when `--write` is also passed,
set the `resolveRate` key instead of leaving it `null`.

- [ ] **Step 6: Record the resolve baseline and commit**

```bash
node --env-file=.env.local --import tsx scripts/corpus-report.ts --resolve --write
git diff fixtures/corpus/baseline.json
npm run check
git add lib/resolve/pipeline.ts test/resolve/pipeline.test.ts scripts/corpus-report.ts fixtures/corpus/baseline.json
git commit -m "Add the resolve pipeline and fill in the resolve rate

A fresh or cooling decision returns before the advisory lock is taken:
a cache hit that contends with anything defeats the point of caching.
Sibling adoption is also checked before the lock, because it is one
indexed read that skips the provider entirely for a second spelling of
an already-resolved release.

A refusal is cached like any other answer, so the same sidecar asked
about twice costs one parse. A blown deadline returns the parse with
partial: true and leaves the row incomplete for the sweeper.

resolveRate is no longer null in baseline.json, which was the one debt
plan 1 left behind."
```

---

## Definition of done for this plan

- [ ] `npm run check` and `npm run build` pass from a clean checkout.
- [ ] With no `DATABASE_URL`, the suite still passes — the database-backed tests skip rather than fail.
- [ ] With `.env.local` present, the transaction, persistence, and pipeline tests all run and pass.
- [ ] A cold movie lookup resolves; the same lookup again makes zero provider calls.
- [ ] A second spelling of one release adopts the sibling with zero provider calls.
- [ ] An episode stores series, season, and episode rows with correct `parent_id` links.
- [ ] `fixtures/corpus/baseline.json` has a non-null `resolveRate`.
- [ ] No test reaches the network: `fixtures/tmdb/` serves every provider response, and a miss throws.
- [ ] `provider_calls` gains a row for every provider request a lookup makes.
- [ ] `fixtures/corpus/*.raw.txt` is byte-identical to its committed state.

## Handoff to the next plan

The API surface, the job sweeper, and Vercel Cron are a separate plan. It consumes exactly:

| From | Symbol |
|---|---|
| `lib/resolve/pipeline` | `resolveLookup`, `PipelineResult`, `LOOKUP_DEADLINE_MS` |
| `lib/cache/lookup` | `readLookup`, `LookupRow`, `STALE_AFTER_HOURS` |
| `lib/db/client` | `getDb`, `withTransaction`, `advisoryLock`, `Tx` |
| `lib/providers/tmdb/*` | `createTmdbClient`, `createTmdbProvider` |
| `lib/resolve/confidence` | `CONFIDENCE_FLOOR` |

It owes this plan two things:

1. **Widen `Provider.resolve` to return `{ media, confidence }`.** The pipeline
   currently writes `CONFIDENCE_FLOOR` as the stored confidence because the
   score computed during candidate selection is discarded. Every stored
   confidence is therefore a placeholder until that is fixed.
2. **`lookup_jobs` is written by nobody yet.** The pipeline marks a blown
   deadline as `pending` but enqueues no job, so nothing retries it except the
   next request for the same name. The sweeper and the `waitUntil` call belong
   to that plan.
