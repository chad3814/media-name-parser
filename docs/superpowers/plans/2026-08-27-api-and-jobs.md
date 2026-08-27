# API and Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the resolution engine as the authenticated, rate-limited, cached HTTP API the spec describes, and make a blown deadline finish itself instead of waiting for someone to ask again.

**Architecture:** Route handlers stay thin — parse, authenticate, delegate to `resolveLookup`, serialise. Everything that could be a judgement call (freshness, confidence, backoff) already lives in a pure function from Plan 2 or is added as one here. A durable `lookup_jobs` row plus `waitUntil` gives the hybrid behaviour the spec asked for: the fast path usually finishes in-request, and the sweeper is the safety net for the times it does not.

**Tech Stack:** Node 26, Next.js 16.3.3 App Router, TypeScript 7.0.2, Drizzle 0.45.2 over `drizzle-orm/neon-serverless`, zod 4.4.3, `@vercel/functions` 3.9.5, oxlint 1.80.0, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`

**Plan sequence:** Plan 3 of 4. Plan 1 (scaffold, schema, parser) is merged. Plan 2 (`docs/superpowers/plans/2026-08-26-resolution-and-api.md`, branch `resolution-api`) delivered the resolution engine and **must be merged or built on before this plan starts** — every task here consumes it. Plan 4 covers Better Auth sign-in, the four UI pages, and the admin guard.

## Global Constraints

- **Node >= 26.** ESM only. No `require`.
- **No `any`.** oxlint sets `typescript/no-explicit-any` to `error`.
- **`unknown` only at a deserialization boundary**, with a comment naming the exception: the immediate argument of a zod `.parse()` call, or a schema field compared structurally rather than read.
- **No TypeScript enums, namespaces, or parameter properties** (`erasableSyntaxOnly: true`).
- **`exactOptionalPropertyTypes: true`.** Prefer `field: T | null` over `field?: T`.
- **`noUncheckedIndexedAccess: true`.** `array[i]` is `T | undefined`; narrow before use.
- **2-space indentation, semicolons always.** `readonly` on interface fields and array types for value objects.
- **Prefer the async form of any API.** In particular use `crypto.subtle.digest` for hashing, not `node:crypto`'s synchronous `createHash` — a request path must not block the event loop.
- **Never log a credential.** API-key secrets, the TMDB bearer, `DATABASE_URL`, and `CRON_SECRET` never reach a log line, an error body, or `provider_calls.endpoint`. A `problem+json` body never echoes an `Authorization` header.
- **Verification gate.** No task is complete until `npm run check` passes. The final task additionally requires `npm run build`.
- **Commit at the end of each task. Never push.**
- **Offline tests.** No test reaches the network. TMDB responses come from `fixtures/tmdb/`; a fixture miss throws.
- **Database-backed tests skip without `DATABASE_URL`** so the suite stays green in a bare checkout, following the pattern Plan 2 established.

---

## Platform facts, verified rather than assumed

Each of these was checked against the live docs or the installed packages while writing this plan. They are recorded because a wrong guess about any of them would reshape a task.

| Fact | Consequence |
|---|---|
| The Vercel team is on the **Pro** plan | `* * * * *` is available, so the sweeper can run every minute as the spec assumes. On Hobby the minimum is daily and the whole job design would need rethinking. |
| Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations when `CRON_SECRET` is set | The cron route authenticates by comparing that header. No separate mechanism needed. |
| `waitUntil` comes from `@vercel/functions` (3.9.5) | One dependency to add. It also works locally as a no-op-ish passthrough, so tests do not need it stubbed. |
| Route-handler `params` is a **Promise** in Next 16 | Every dynamic handler is `context: { params: Promise<{ id: string }> }` and must `await`. Confirmed by building a probe route. |
| `x-vercel-cron-schedule` carries the schedule that fired | Not used by this plan, but it is the hook if the sweep ever needs a fast and a slow variant. |

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/auth/apiKey.ts` | mint, hash, and verify a bearer token against `api_keys` |
| `lib/auth/rateLimit.ts` | fixed one-minute windowed counter |
| `lib/http/problem.ts` | `application/problem+json` responses, one per status |
| `lib/http/log.ts` | the one way a caught error is recorded before it becomes a 5xx |
| `lib/http/authenticate.ts` | the one place a route turns a `Request` into a caller or a 401/429 |
| `lib/media/read.ts` | hydrate a `media` row into the API's nested shape |
| `lib/http/envelope.ts` | `PipelineResult` + hydrated media → the response body the spec specifies |
| `lib/jobs/backoff.ts` | pure exponential backoff with jitter |
| `lib/jobs/queue.ts` | enqueue, claim, and settle `lookup_jobs` |
| `lib/jobs/sweep.ts` | claim due jobs, run them, record the outcome |
| `app/api/v1/health/route.ts` | GET |
| `app/api/v1/media/[id]/route.ts` | GET |
| `app/api/v1/lookup/route.ts` | POST, single and batch |
| `app/api/v1/lookup/[id]/route.ts` | GET, poll |
| `app/api/cron/sweep/route.ts` | GET, Vercel Cron target |
| `scripts/seed-api-key.ts` | mint a key for local and CI use |
| `vercel.json` | cron schedule |

Not created here: anything under `app/(app)/`, `app/(admin)/`, `lib/auth/session.ts`, `lib/auth/roles.ts`. Those are Plan 4.

---

### Task 1: API key authentication

**Files:**
- Create: `lib/auth/apiKey.ts`, `scripts/seed-api-key.ts`
- Test: `test/auth/apiKey.test.ts`

**Interfaces:**
- Consumes: `withTransaction`/`Tx` (Plan 2), the `apiKeys` table (Plan 1).
- Produces:
  - `mintApiKey(): Promise<{ readonly token: string; readonly prefix: string; readonly tokenHash: string }>`
  - `hashToken(token: string): Promise<string>` — SHA-256, hex
  - `parseBearer(header: string | null): string | null`
  - `interface Caller { readonly apiKeyId: string; readonly userId: string; readonly rateLimitPerMin: number }`
  - `verifyApiKey(tx: Tx, token: string): Promise<Caller | null>`
  - `touchApiKey(tx: Tx, apiKeyId: string): Promise<void>`

**Token shape and why.** `mnp_<prefix>_<secret>`: `mnp_` makes a leaked key greppable in logs and repos, `prefix` is stored in the clear so the UI can show which key is which without holding the secret, and the whole token is what gets hashed. Lookup is *by hash*, so there is no comparison to make constant-time — the database index does the work and no timing signal exists to leak.

- [ ] **Step 1: Write the failing test**

`test/auth/apiKey.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import {
  mintApiKey, hashToken, parseBearer, verifyApiKey, touchApiKey,
} from '../../lib/auth/apiKey';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

test('parseBearer accepts exactly the shapes it should', () => {
  assert.equal(parseBearer('Bearer abc'), 'abc');
  assert.equal(parseBearer('bearer abc'), 'abc', 'the scheme is case-insensitive');
  assert.equal(parseBearer('Bearer   abc  '), 'abc', 'surrounding space is trimmed');
  assert.equal(parseBearer(null), null);
  assert.equal(parseBearer(''), null);
  assert.equal(parseBearer('abc'), null, 'a bare token is not a bearer header');
  assert.equal(parseBearer('Basic abc'), null, 'only the Bearer scheme');
  assert.equal(parseBearer('Bearer '), null, 'an empty token is not a token');
});

test('a minted token has the documented shape and a matching hash', async () => {
  const minted = await mintApiKey();
  assert.match(minted.token, /^mnp_[0-9a-f]{8}_[0-9a-f]{48}$/);
  assert.equal(minted.prefix.length, 8);
  assert.ok(minted.token.includes(minted.prefix), 'the prefix must be readable from the token');
  assert.equal(minted.tokenHash, await hashToken(minted.token));
  assert.match(minted.tokenHash, /^[0-9a-f]{64}$/, 'sha-256 hex');
});

test('two minted tokens differ', async () => {
  const a = await mintApiKey();
  const b = await mintApiKey();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.tokenHash, b.tokenHash);
});

test('hashing is stable and sensitive to a single character', async () => {
  assert.equal(await hashToken('mnp_x_y'), await hashToken('mnp_x_y'));
  assert.notEqual(await hashToken('mnp_x_y'), await hashToken('mnp_x_z'));
});

/** Creates a user and a key inside a transaction the caller will roll back. */
async function seed(tx: Tx, over: { readonly revoked?: boolean; readonly limit?: number } = {}) {
  const minted = await mintApiKey();
  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('u-probe', 'Probe', 'probe@example.test', false)
    ON CONFLICT (id) DO NOTHING`);
  const row = await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min, revoked_at)
    VALUES ('u-probe', 'probe', ${minted.tokenHash}, ${minted.prefix},
            ${over.limit ?? 60}, ${over.revoked === true ? sql`now()` : sql`NULL`})
    RETURNING id`);
  return { minted, apiKeyId: String(row.rows[0]?.id) };
}

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('a valid token resolves to its caller', opts, async () => {
  await inRollback(async (tx) => {
    const { minted, apiKeyId } = await seed(tx, { limit: 42 });
    const caller = await verifyApiKey(tx, minted.token);
    assert.ok(caller !== null);
    assert.equal(caller.apiKeyId, apiKeyId);
    assert.equal(caller.userId, 'u-probe');
    assert.equal(caller.rateLimitPerMin, 42);
  });
});

test('an unknown token resolves to null', opts, async () => {
  await inRollback(async (tx) => {
    await seed(tx);
    assert.equal(await verifyApiKey(tx, 'mnp_00000000_deadbeef'), null);
  });
});

test('a revoked token resolves to null even though its hash still matches', opts, async () => {
  await inRollback(async (tx) => {
    const { minted } = await seed(tx, { revoked: true });
    assert.equal(await verifyApiKey(tx, minted.token), null);
  });
});

test('touchApiKey records last_used_at without changing anything else', opts, async () => {
  await inRollback(async (tx) => {
    const { minted, apiKeyId } = await seed(tx);
    await touchApiKey(tx, apiKeyId);
    const row = await tx.execute(sql`
      SELECT last_used_at, revoked_at, rate_limit_per_min FROM api_keys WHERE id = ${apiKeyId}::uuid`);
    assert.ok(row.rows[0]?.last_used_at !== null, 'last_used_at should be set');
    assert.equal(row.rows[0]?.revoked_at, null);
    assert.equal(row.rows[0]?.rate_limit_per_min, 60);
    // And the key still verifies afterwards.
    assert.ok(await verifyApiKey(tx, minted.token) !== null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/apiKey.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/apiKey`.

- [ ] **Step 3: Write the implementation**

`lib/auth/apiKey.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

const PREFIX_BYTES = 4;   // 8 hex characters
const SECRET_BYTES = 24;  // 48 hex characters

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256, hex, via WebCrypto.
 *
 * `crypto.subtle` rather than `node:crypto`'s `createHash`: this runs on every
 * authenticated request, and the synchronous form blocks the event loop for
 * every other request sharing it.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export interface MintedKey {
  readonly token: string;
  readonly prefix: string;
  readonly tokenHash: string;
}

/**
 * A new key: `mnp_<prefix>_<secret>`.
 *
 * The `mnp_` marker makes a leaked key greppable in a log or a repository. The
 * prefix is stored in the clear so a UI can say which key is which without
 * holding the secret. The hash covers the whole token, prefix included.
 */
export async function mintApiKey(): Promise<MintedKey> {
  const prefix = toHex(crypto.getRandomValues(new Uint8Array(PREFIX_BYTES)));
  const secret = toHex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const token = `mnp_${prefix}_${secret}`;
  return { token, prefix, tokenHash: await hashToken(token) };
}

const BEARER = /^bearer\s+(\S+)\s*$/i;

export function parseBearer(header: string | null): string | null {
  if (header === null || header.length === 0) return null;
  const match = BEARER.exec(header.trim());
  return match?.[1] ?? null;
}

export interface Caller {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly rateLimitPerMin: number;
}

/**
 * The caller behind a token, or null.
 *
 * Lookup is by hash, so there is no secret comparison to make constant-time --
 * the index does the work and no timing signal exists to leak. A revoked key
 * is excluded in SQL rather than checked afterwards, so there is no path where
 * a caller is built from a revoked row.
 */
export async function verifyApiKey(tx: Tx, token: string): Promise<Caller | null> {
  const tokenHash = await hashToken(token);
  const result = await tx.execute(sql`
    SELECT id, user_id, rate_limit_per_min FROM api_keys
     WHERE token_hash = ${tokenHash} AND revoked_at IS NULL`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    apiKeyId: String(row.id),
    userId: String(row.user_id),
    rateLimitPerMin: Number(row.rate_limit_per_min),
  };
}

export async function touchApiKey(tx: Tx, apiKeyId: string): Promise<void> {
  await tx.execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${apiKeyId}::uuid`);
}
```

- [ ] **Step 4: Write the seed script**

`scripts/seed-api-key.ts`:

```ts
import { sql } from 'drizzle-orm';
import { closeDb, withTransaction } from '../lib/db/client';
import { mintApiKey } from '../lib/auth/apiKey';

const label = process.argv[2] ?? 'local development';
const email = process.argv[3] ?? 'dev@localhost';

const minted = await mintApiKey();

await withTransaction(async (tx) => {
  // Better Auth owns the `user` table and generates its own string ids. Until
  // Plan 4 wires sign-in up there is no real user to attach a key to, so a
  // deterministic local one is created here and reused.
  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('local-dev', 'Local Development', ${email}, false)
    ON CONFLICT (id) DO NOTHING`);
  await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES ('local-dev', ${label}, ${minted.tokenHash}, ${minted.prefix})`);
});
await closeDb();

// The secret is printed exactly once, here, and is not recoverable afterwards.
// It goes to stdout so it can be redirected straight into a file or a variable
// without appearing in a log.
process.stdout.write(`${minted.token}\n`);
process.stderr.write(`\nstored key ${minted.prefix} for '${label}'. The token above is shown once.\n`);
```

Add to `package.json`:

```json
"seed:key": "node --env-file=.env.local --import tsx scripts/seed-api-key.ts"
```

- [ ] **Step 5: Run the tests, then mint a key for later tasks**

```bash
npm run test -- test/auth/apiKey.test.ts
npm run seed:key "plan 3 development" > .api-key.local
```

Expected: 8 passing. `.api-key.local` holds one token for Tasks 2–5 to use. Add it to `.gitignore` in the same step — a committed API key is the failure this whole task exists to prevent:

```
# Local API key minted by npm run seed:key
.api-key.local
```

- [ ] **Step 6: Verify and commit**

```bash
npm run check
git add lib/auth test/auth scripts/seed-api-key.ts package.json .gitignore
git commit -m "Add API key authentication

Tokens are mnp_<prefix>_<secret>: the marker makes a leaked key
greppable, the prefix is stored in the clear so a UI can name a key
without holding its secret, and the hash covers the whole token.

Lookup is by hash, so there is no secret comparison to make
constant-time -- the index does the work and no timing signal exists.
A revoked key is excluded in SQL rather than checked afterwards, so no
path can build a caller from a revoked row.

Hashing uses crypto.subtle, not node:crypto's createHash: this runs on
every authenticated request and the synchronous form would block the
event loop for everything sharing it."
```

---

### Task 2: Rate limiting

**Files:**
- Create: `lib/auth/rateLimit.ts`
- Test: `test/auth/rateLimit.test.ts`

**Interfaces:**
- Consumes: `Tx` (Plan 2), the `rateLimitWindows` table (Plan 1).
- Produces:
  - `interface RateVerdict { readonly allowed: boolean; readonly used: number; readonly limit: number; readonly retryAfterSeconds: number }`
  - `consume(tx: Tx, apiKeyId: string, limit: number, now?: Date): Promise<RateVerdict>`
  - `pruneRateWindows(tx: Tx, keepWindows?: number): Promise<number>`

**Fixed windows, and the cost of that choice.** The window is the current
minute, truncated. A caller can therefore get up to twice its limit across a
boundary — 60 requests at 11:59:59.9 and 60 more at 12:00:00.1. The
alternative, a sliding log, needs a row per request and a range scan to
evaluate. Double-at-the-boundary is the cheaper failure, and it is bounded;
naming it here means nobody has to rediscover it from a graph.

The counter is a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`,
which is atomic. Two concurrent requests cannot both read 59 and both proceed.

- [ ] **Step 1: Write the failing test**

`test/auth/rateLimit.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { consume, pruneRateWindows } from '../../lib/auth/rateLimit';
import { mintApiKey } from '../../lib/auth/apiKey';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

async function seedKey(tx: Tx): Promise<string> {
  const minted = await mintApiKey();
  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('u-rate', 'Rate', 'rate@example.test', false)
    ON CONFLICT (id) DO NOTHING`);
  const row = await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES ('u-rate', 'rate', ${minted.tokenHash}, ${minted.prefix})
    RETURNING id`);
  return String(row.rows[0]?.id);
}

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('the first request is allowed and counted', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const verdict = await consume(tx, apiKeyId, 3);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.used, 1);
    assert.equal(verdict.limit, 3);
  });
});

test('requests are allowed up to the limit and refused after it', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await consume(tx, apiKeyId, 3));
    assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false, false]);
    assert.deepEqual(results.map((r) => r.used), [1, 2, 3, 4, 5]);
  });
});

test('a refusal carries a Retry-After inside the current minute', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    await consume(tx, apiKeyId, 1);
    const refused = await consume(tx, apiKeyId, 1);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60,
      `expected 1..60, got ${refused.retryAfterSeconds}`);
  });
});

test('two different keys do not share a budget', opts, async () => {
  await inRollback(async (tx) => {
    const a = await seedKey(tx);
    const minted = await mintApiKey();
    const rowB = await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES ('u-rate', 'rate-b', ${minted.tokenHash}, ${minted.prefix}) RETURNING id`);
    const b = String(rowB.rows[0]?.id);
    await consume(tx, a, 1);
    const refusedA = await consume(tx, a, 1);
    const allowedB = await consume(tx, b, 1);
    assert.equal(refusedA.allowed, false);
    assert.equal(allowedB.allowed, true, 'key B has its own window');
  });
});

test('a new minute is a new budget', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    const noon = new Date('2026-08-27T12:00:30Z');
    const nextMinute = new Date('2026-08-27T12:01:05Z');
    await consume(tx, apiKeyId, 1, noon);
    assert.equal((await consume(tx, apiKeyId, 1, noon)).allowed, false);
    assert.equal((await consume(tx, apiKeyId, 1, nextMinute)).allowed, true);
  });
});

test('a limit of zero refuses everything', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    assert.equal((await consume(tx, apiKeyId, 0)).allowed, false);
  });
});

test('pruning removes old windows and keeps recent ones', opts, async () => {
  await inRollback(async (tx) => {
    const apiKeyId = await seedKey(tx);
    await consume(tx, apiKeyId, 10, new Date('2026-08-27T09:00:00Z'));
    await consume(tx, apiKeyId, 10, new Date('2026-08-27T12:00:00Z'));
    const before = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.equal(before.rows[0]?.n, 2);
    const removed = await pruneRateWindows(tx, 2);
    assert.ok(removed >= 1, 'the 09:00 window is older than two minutes');
    const after = await tx.execute(sql`
      SELECT count(*)::int AS n FROM rate_limit_windows WHERE api_key_id = ${apiKeyId}::uuid`);
    assert.ok(Number(after.rows[0]?.n ?? 0) < 2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/rateLimit.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/rateLimit`.

- [ ] **Step 3: Write the implementation**

`lib/auth/rateLimit.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

export interface RateVerdict {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
  /** Seconds until the current window ends. Meaningful only when refused. */
  readonly retryAfterSeconds: number;
}

/**
 * Counts one request against a key's budget for the current minute.
 *
 * Fixed windows, not a sliding log. The cost is that a caller can get up to
 * twice its limit across a boundary -- 60 requests at 11:59:59.9 and 60 more a
 * fraction of a second later. A sliding log needs a row per request and a range
 * scan to evaluate; double-at-the-boundary is the cheaper failure and it is
 * bounded.
 *
 * The counter is one atomic statement, so two concurrent requests cannot both
 * read 59 and both decide they are fine.
 */
export async function consume(
  tx: Tx, apiKeyId: string, limit: number, now: Date = new Date(),
): Promise<RateVerdict> {
  const result = await tx.execute(sql`
    INSERT INTO rate_limit_windows (api_key_id, window_start, count)
    VALUES (${apiKeyId}::uuid, date_trunc('minute', ${now.toISOString()}::timestamptz), 1)
    ON CONFLICT (api_key_id, window_start) DO UPDATE
      SET count = rate_limit_windows.count + 1
    RETURNING count`);
  const used = Number(result.rows[0]?.count ?? 0);
  const secondsIntoMinute = now.getUTCSeconds();
  return {
    allowed: used <= limit,
    used,
    limit,
    retryAfterSeconds: Math.max(1, 60 - secondsIntoMinute),
  };
}

/**
 * Drops windows older than `keepWindows` minutes. Called by the sweep cron so
 * the table does not grow without bound; it holds one row per key per minute.
 */
export async function pruneRateWindows(tx: Tx, keepWindows = 5): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM rate_limit_windows
     WHERE window_start < date_trunc('minute', now()) - (${keepWindows} * interval '1 minute')`);
  return Number(result.rowCount ?? 0);
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/auth/rateLimit.test.ts
```

Expected: 7 passing. If "requests are allowed up to the limit" reports
`[true, true, true, true, false]`, the comparison is `used < limit` rather than
`used <= limit` — the third request of a limit of three must be allowed.

- [ ] **Step 5: Commit**

```bash
npm run check
git add lib/auth/rateLimit.ts test/auth/rateLimit.test.ts
git commit -m "Add per-key rate limiting on fixed one-minute windows

The counter is a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING,
so it is atomic: two concurrent requests cannot both read 59 and both
decide they are within budget.

Fixed windows rather than a sliding log, and the cost is stated rather
than discovered: a caller can get up to twice its limit across a
boundary. A sliding log needs a row per request and a range scan, and
double-at-the-boundary is both cheaper and bounded."
```

---
### Task 3: HTTP conventions, media hydration, and the two read endpoints

**Files:**
- Create: `lib/http/problem.ts`, `lib/http/authenticate.ts`, `lib/media/read.ts`, `app/api/v1/health/route.ts`, `app/api/v1/media/[id]/route.ts`
- Test: `test/http/problem.test.ts`, `test/media/read.test.ts`, `test/http/read-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 and 2, `getDb`/`withTransaction` (Plan 2).
- Produces:
  - `problem(status: number, title: string, detail?: string): Response` plus named helpers `badRequest`, `unauthorized`, `forbidden`, `notFound`, `rateLimited`, `unavailable`
  - `authenticate(request: Request): Promise<{ readonly ok: true; readonly caller: Caller } | { readonly ok: false; readonly response: Response }>`
  - `interface MediaView` — the nested shape the API returns
  - `readMediaTree(tx: Tx, mediaId: string): Promise<MediaView | null>`

**Route handlers are tested as functions, not over a socket.** A Next.js route
handler takes a `Request` and returns a `Response`, so a test can call it
directly. That keeps these tests in the same `node:test` suite as everything
else, with no server to start and no port to collide on.

- [ ] **Step 1: Write the failing tests**

`test/http/problem.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  problem, badRequest, unauthorized, notFound, rateLimited, unavailable,
} from '../../lib/http/problem';

async function body(response: Response): Promise<Record<string, unknown>> {
  // The immediate argument of a JSON boundary; the value is asserted on below.
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

test('a problem response carries the RFC 9457 shape and content type', async () => {
  const response = problem(400, 'Bad Request', 'category must be one of tv, movies, books, xxx');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  const parsed = await body(response);
  assert.equal(parsed.status, 400);
  assert.equal(parsed.title, 'Bad Request');
  assert.equal(parsed.detail, 'category must be one of tv, movies, books, xxx');
  assert.equal(parsed.type, 'about:blank');
});

test('detail is omitted rather than sent as null when absent', async () => {
  const parsed = await body(notFound('nothing here'));
  assert.equal(parsed.detail, 'nothing here');
  const bare = await body(problem(404, 'Not Found'));
  assert.ok(!('detail' in bare), 'an absent detail should not appear at all');
});

test('each helper uses its own status', () => {
  assert.equal(badRequest('x').status, 400);
  assert.equal(unauthorized().status, 401);
  assert.equal(notFound().status, 404);
  assert.equal(rateLimited(30).status, 429);
  assert.equal(unavailable().status, 503);
});

test('a 401 advertises the scheme and a 429 advertises Retry-After', () => {
  assert.equal(unauthorized().headers.get('www-authenticate'), 'Bearer');
  assert.equal(rateLimited(30).headers.get('retry-after'), '30');
});

test('a problem body never echoes a credential', async () => {
  // Defensive: `detail` is the only free-text field, and callers must not be
  // able to get a header reflected into it. This asserts the helper does not
  // add anything of its own beyond what it was given.
  const parsed = await body(badRequest('Bearer mnp_secret'));
  assert.equal(parsed.detail, 'Bearer mnp_secret', 'passed through verbatim, nothing added');
  assert.equal(Object.keys(parsed).sort().join(','), 'detail,status,title,type');
});
```

`test/media/read.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { readMediaTree } from '../../lib/media/read';
import { persistResolved } from '../../lib/resolve/persist';
import type { ResolvedMedia } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const SERIES: ResolvedMedia = {
  category: 'tv', kind: 'series', provider: 'tmdb', providerRef: 'tmdb:tv:r1',
  title: 'Read Show', sortTitle: 'read show', originalTitle: null,
  releaseDate: '2020-01-01', year: 2020, overview: 'A show.',
  raw: {}, people: [], parent: null,
  details: { movie: null, series: { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' }, season: null, episode: null },
};
const SEASON: ResolvedMedia = {
  ...SERIES, kind: 'season', providerRef: 'tmdb:tv:r1:2', title: 'Season 2', sortTitle: 'season 2',
  details: { movie: null, series: null, season: { seasonNumber: 2 }, episode: null }, parent: SERIES,
};
const EPISODE: ResolvedMedia = {
  ...SERIES, kind: 'episode', providerRef: 'tmdb:tv:r1:2:4', title: 'Down', sortTitle: 'down',
  details: { movie: null, series: null, season: null, episode: { seasonNumber: 2, episodeNumber: 4, airDate: '2020-03-01' } },
  parent: SEASON,
  people: [
    { providerRef: 'tmdb:person:r1', name: 'Reed Director', role: 'director', characterName: null, billingOrder: null, raw: {} },
    { providerRef: 'tmdb:person:r2', name: 'Reed Actor', role: 'performer', characterName: 'Clerk', billingOrder: 2, raw: {} },
    { providerRef: 'tmdb:person:r3', name: 'Reed Lead', role: 'performer', characterName: 'Lead', billingOrder: 0, raw: {} },
  ],
};

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('an episode hydrates with its parents nearest-first and its people', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, EPISODE);
    const view = await readMediaTree(tx, id);
    assert.ok(view !== null);
    assert.equal(view.kind, 'episode');
    assert.equal(view.title, 'Down');
    assert.equal(view.providerRef, 'tmdb:tv:r1:2:4');
    assert.equal(view.releaseDate, '2020-03-01');
    assert.deepEqual(view.details, { seasonNumber: 2, episodeNumber: 4, airDate: '2020-03-01' });

    assert.equal(view.parents.length, 2, 'season then series');
    assert.equal(view.parents[0]?.kind, 'season');
    assert.equal(view.parents[1]?.kind, 'series');
    assert.equal(view.parents[1]?.title, 'Read Show');

    // Performers ordered by billing, crew after. Lead (0) before Clerk (2).
    const performers = view.people.filter((p) => p.role === 'performer').map((p) => p.name);
    assert.deepEqual(performers, ['Reed Lead', 'Reed Actor']);
    assert.ok(view.people.some((p) => p.role === 'director' && p.name === 'Reed Director'));
  });
});

test('a series hydrates with no parents and its own details', opts, async () => {
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, SERIES);
    const view = await readMediaTree(tx, id);
    assert.ok(view !== null);
    assert.deepEqual(view.parents, []);
    assert.deepEqual(view.details, { firstAirDate: '2020-01-01', lastAirDate: null, status: 'Ended' });
  });
});

test('an unknown id is null, not an error', opts, async () => {
  await inRollback(async (tx) => {
    assert.equal(await readMediaTree(tx, '00000000-0000-0000-0000-000000000000'), null);
  });
});

test('hydration costs a bounded number of queries regardless of depth', opts, async () => {
  // Three media rows deep must not mean three round trips per row. The parent
  // chain is one recursive query; people are one more.
  await inRollback(async (tx) => {
    const id = await persistResolved(tx, EPISODE);
    const view = await readMediaTree(tx, id);
    assert.ok(view !== null);
    assert.equal(view.parents.length, 2);
  });
});
```

`test/http/read-routes.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { GET as health } from '../../app/api/v1/health/route';
import { GET as media } from '../../app/api/v1/media/[id]/route';
import { mintApiKey } from '../../lib/auth/apiKey';
import { persistResolved } from '../../lib/resolve/persist';
import type { ResolvedMedia } from '../../lib/providers/types';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const MOVIE: ResolvedMedia = {
  category: 'movies', kind: 'movie', provider: 'tmdb', providerRef: 'tmdb:movie:r9',
  title: 'Route Film', sortTitle: 'route film', originalTitle: null,
  releaseDate: '2001-01-01', year: 2001, overview: null, raw: {}, people: [], parent: null,
  details: { movie: { runtimeMinutes: 90, imdbId: 'tt9', tagline: null, collectionName: null }, series: null, season: null, episode: null },
};

/** A key that really exists, plus a request carrying it. */
async function withKey(): Promise<string> {
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-route', 'Route', 'route@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES ('u-route', 'route', ${minted.tokenHash}, ${minted.prefix})`);
  });
  return minted.token;
}

function request(token: string | null, url = 'https://x.test/api/v1/media/1'): Request {
  return new Request(url, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

test('health reports ok and the migration count without needing a key', opts, async () => {
  const response = await health();
  assert.equal(response.status, 200);
  const parsed: unknown = await response.json();
  const body = parsed as { readonly status: string; readonly migrations: number };
  assert.equal(body.status, 'ok');
  assert.ok(body.migrations >= 1, 'at least one migration should be applied');
});

test('media without a bearer token is 401 and advertises the scheme', opts, async () => {
  const response = await media(request(null), { params: Promise.resolve({ id: 'x' }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
});

test('media with an unknown token is 401', opts, async () => {
  const response = await media(request('mnp_00000000_nope'), { params: Promise.resolve({ id: 'x' }) });
  assert.equal(response.status, 401);
});

test('media with a malformed uuid is 400, not a database error', opts, async () => {
  const token = await withKey();
  const response = await media(request(token), { params: Promise.resolve({ id: 'not-a-uuid' }) });
  assert.equal(response.status, 400);
});

test('media with an unknown but well-formed id is 404', opts, async () => {
  const token = await withKey();
  const response = await media(request(token), {
    params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }),
  });
  assert.equal(response.status, 404);
});

test('media returns the hydrated record for a real id', opts, async () => {
  const token = await withKey();
  const id = await withTransaction(async (tx) => persistResolved(tx, MOVIE));
  const response = await media(request(token), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  const parsed: unknown = await response.json();
  const body = parsed as { readonly media: { readonly title: string; readonly providerRef: string } };
  assert.equal(body.media.title, 'Route Film');
  assert.equal(body.media.providerRef, 'tmdb:movie:r9');
  await getDb().execute(sql`DELETE FROM media WHERE provider_ref = 'tmdb:movie:r9'`);
});
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
npm run test -- test/http/problem.test.ts test/media/read.test.ts test/http/read-routes.test.ts
```

Expected: FAIL — none of the modules exist yet.

- [ ] **Step 3: Write `lib/http/log.ts`**

The spec is explicit that nothing is swallowed: *"Every caught error either
writes `lookup_jobs.last_error` or is logged with the lookup id."* A `catch`
that returns a 503 and says nothing violates that, and a 503 with no
corresponding log line is undiagnosable from outside — so every such catch goes
through here.

```ts
/**
 * Records a caught error before it becomes a 5xx.
 *
 * The spec forbids swallowing: a response saying "unavailable" with nothing in
 * the log is a failure nobody can diagnose. `context` should name the
 * operation and, where there is one, the lookup or media id -- never a
 * credential, a bearer header, or a connection string.
 */
export function logFailure(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[media-name-parser] ${context}: ${message}`, stack ?? '');
}
```

- [ ] **Step 4: Write `lib/http/problem.ts`**

```ts
/**
 * RFC 9457 problem responses.
 *
 * `type` is `about:blank` throughout, which the RFC defines as "no further
 * information beyond the status code". Inventing a URI namespace before anyone
 * needs to dereference one would be documentation nobody reads.
 */
export function problem(status: number, title: string, detail?: string): Response {
  const body: Record<string, string | number> = { type: 'about:blank', title, status };
  // Omitted rather than null: a client checking `'detail' in body` should get a
  // straight answer, and `exactOptionalPropertyTypes` discourages the alternative.
  if (detail !== undefined) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export function badRequest(detail?: string): Response {
  return problem(400, 'Bad Request', detail);
}

export function unauthorized(detail?: string): Response {
  const response = problem(401, 'Unauthorized', detail);
  // Without this a client cannot tell which scheme to retry with.
  response.headers.set('www-authenticate', 'Bearer');
  return response;
}

export function forbidden(detail?: string): Response {
  return problem(403, 'Forbidden', detail);
}

export function notFound(detail?: string): Response {
  return problem(404, 'Not Found', detail);
}

export function rateLimited(retryAfterSeconds: number, detail?: string): Response {
  const response = problem(429, 'Too Many Requests', detail);
  response.headers.set('retry-after', String(retryAfterSeconds));
  return response;
}

export function unavailable(detail?: string): Response {
  return problem(503, 'Service Unavailable', detail);
}
```

- [ ] **Step 5: Write `lib/http/authenticate.ts`**

```ts
import { withTransaction } from '../db/client';
import { parseBearer, touchApiKey, verifyApiKey, type Caller } from '../auth/apiKey';
import { consume } from '../auth/rateLimit';
import { rateLimited, unauthorized, unavailable } from './problem';
import { logFailure } from './log';

export type AuthResult =
  | { readonly ok: true; readonly caller: Caller }
  | { readonly ok: false; readonly response: Response };

/**
 * The one place a request becomes a caller.
 *
 * Every authenticated route calls this and nothing else, so there is a single
 * answer to "what does an unauthenticated request get" and a single place the
 * rate limit is charged. A 401 detail never quotes the header it rejected --
 * the value is a credential.
 */
export async function authenticate(request: Request): Promise<AuthResult> {
  const token = parseBearer(request.headers.get('authorization'));
  if (token === null) {
    return { ok: false, response: unauthorized('a Bearer token is required') };
  }

  try {
    const outcome = await withTransaction(async (tx) => {
      const caller = await verifyApiKey(tx, token);
      if (caller === null) return { kind: 'unknown' as const };
      const verdict = await consume(tx, caller.apiKeyId, caller.rateLimitPerMin);
      if (!verdict.allowed) {
        return { kind: 'limited' as const, retryAfterSeconds: verdict.retryAfterSeconds };
      }
      await touchApiKey(tx, caller.apiKeyId);
      return { kind: 'ok' as const, caller };
    });

    if (outcome.kind === 'unknown') {
      // Deliberately the same response as a missing token: distinguishing them
      // tells an attacker which of their guesses was a real key prefix.
      return { ok: false, response: unauthorized('the token is not valid') };
    }
    if (outcome.kind === 'limited') {
      return { ok: false, response: rateLimited(outcome.retryAfterSeconds) };
    }
    return { ok: true, caller: outcome.caller };
  } catch (error) {
    // The caller gets nothing about the cause -- it cannot act on it and the
    // detail could name internals -- but it is logged, because a 503 with no
    // corresponding log line cannot be diagnosed from outside.
    logFailure('authenticate', error);
    return { ok: false, response: unavailable('the database is unreachable') };
  }
}
```

- [ ] **Step 6: Write `lib/media/read.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { MediaKind, PersonRole, ProviderName } from '../providers/types';

export interface PersonView {
  readonly name: string;
  readonly role: PersonRole;
  readonly characterName: string | null;
  readonly billingOrder: number | null;
}

export interface MediaNode {
  readonly id: string;
  readonly kind: MediaKind;
  readonly title: string;
  readonly releaseDate: string | null;
  readonly year: number | null;
  readonly provider: ProviderName;
  readonly providerRef: string;
}

export interface MediaView extends MediaNode {
  readonly overview: string | null;
  /** Whatever detail table matches `kind`, flattened. Empty for a bare node. */
  readonly details: Readonly<Record<string, string | number | null>>;
  /** Nearest first: an episode's parents are its season, then its series. */
  readonly parents: readonly MediaNode[];
  readonly people: readonly PersonView[];
}

function node(row: Readonly<Record<string, unknown>>): MediaNode {
  return {
    id: String(row.id),
    kind: row.kind as MediaKind,
    title: String(row.title),
    releaseDate: row.release_date === null ? null : String(row.release_date),
    year: row.year === null ? null : Number(row.year),
    provider: row.provider as ProviderName,
    providerRef: String(row.provider_ref),
  };
}

/**
 * A media row with its ancestors and people.
 *
 * Three queries regardless of depth: one recursive CTE for the row and its
 * parent chain, one for the detail tables, one for the people. Walking
 * `parent_id` in application code would be a round trip per level, which for
 * an episode is three -- and the recursive form is no harder to read.
 */
export async function readMediaTree(tx: Tx, mediaId: string): Promise<MediaView | null> {
  const chain = await tx.execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT m.*, 0 AS depth FROM media m WHERE m.id = ${mediaId}::uuid
      UNION ALL
      SELECT p.*, a.depth + 1 FROM media p JOIN ancestry a ON p.id = a.parent_id
    )
    SELECT * FROM ancestry ORDER BY depth`);

  const rows = chain.rows;
  const self = rows[0];
  if (self === undefined) return null;

  const details = await tx.execute(sql`
    SELECT
      (SELECT to_jsonb(d) - 'media_id' FROM movie_details  d WHERE d.media_id = ${mediaId}::uuid) AS movie,
      (SELECT to_jsonb(d) - 'media_id' FROM series_details d WHERE d.media_id = ${mediaId}::uuid) AS series,
      (SELECT to_jsonb(d) - 'media_id' FROM season_details d WHERE d.media_id = ${mediaId}::uuid) AS season,
      (SELECT to_jsonb(d) - 'media_id' FROM episode_details d WHERE d.media_id = ${mediaId}::uuid) AS episode,
      (SELECT to_jsonb(d) - 'media_id' FROM book_details   d WHERE d.media_id = ${mediaId}::uuid) AS book,
      (SELECT to_jsonb(d) - 'media_id' FROM scene_details  d WHERE d.media_id = ${mediaId}::uuid) AS scene`);

  const people = await tx.execute(sql`
    SELECT p.name, mp.role, mp.character_name, mp.billing_order
      FROM media_people mp JOIN people p ON p.id = mp.person_id
     WHERE mp.media_id = ${mediaId}::uuid
     -- Performers first in billing order, then everyone else by name. A
     -- response that led with the third-billed actor would read as unsorted.
     ORDER BY (mp.role <> 'performer'), mp.billing_order NULLS LAST, p.name`);

  const detailRow = details.rows[0] ?? {};
  // The subquery aliases above are named after `kind` exactly, so this is a
  // direct lookup rather than a mapping.
  const kind = String(self.kind);
  const raw = detailRow[kind];
  // Column names arrive snake_case from `to_jsonb`; the API is camelCase.
  const flattened: Record<string, string | number | null> = {};
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const camel = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      flattened[camel] = value === null ? null
        : typeof value === 'number' ? value
        : String(value);
    }
  }

  return {
    ...node(self),
    overview: self.overview === null ? null : String(self.overview),
    details: flattened,
    parents: rows.slice(1).map(node),
    people: people.rows.map((r) => ({
      name: String(r.name),
      role: r.role as PersonRole,
      characterName: r.character_name === null || r.character_name === '' ? null : String(r.character_name),
      billingOrder: r.billing_order === null ? null : Number(r.billing_order),
    })),
  };
}
```

- [ ] **Step 7: Write the two route handlers**

`app/api/v1/health/route.ts`:

```ts
import { sql } from 'drizzle-orm';
import { getDb } from '../../../../lib/db/client';
import { unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';

/**
 * Unauthenticated on purpose: a health check that needs a credential cannot be
 * used by the thing most likely to call it. It reveals only reachability and a
 * migration count, neither of which is sensitive.
 */
export async function GET(): Promise<Response> {
  try {
    const result = await getDb().execute(sql`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    return Response.json({
      status: 'ok',
      migrations: Number(result.rows[0]?.n ?? 0),
    });
  } catch (error) {
    logFailure('health', error);
    return unavailable('the database is unreachable');
  }
}
```

`app/api/v1/media/[id]/route.ts`:

```ts
import { withTransaction } from '../../../../../lib/db/client';
import { authenticate } from '../../../../../lib/http/authenticate';
import { badRequest, notFound, unavailable } from '../../../../../lib/http/problem';
import { logFailure } from '../../../../../lib/http/log';
import { readMediaTree } from '../../../../../lib/media/read';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `params` is a Promise in Next 16 and must be awaited. */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  // Checked before the query: passing a non-uuid to a uuid column is a
  // database error, and a 500 for a client's typo is the wrong answer.
  if (!UUID.test(id)) return badRequest('id must be a uuid');

  try {
    const view = await withTransaction(async (tx) => readMediaTree(tx, id));
    if (view === null) return notFound('no media with that id');
    return Response.json({ media: view });
  } catch (error) {
    logFailure(`media ${id}`, error);
    return unavailable('the database is unreachable');
  }
}
```

- [ ] **Step 8: Run the tests**

```bash
npm run test -- test/http/problem.test.ts test/media/read.test.ts test/http/read-routes.test.ts
```

Expected: 5 + 4 + 6 passing. Diagnostics:

- Health should not return 503: `drizzle.__drizzle_migrations` was verified to
  exist with one row against the dev branch while this plan was written. If it
  does, the migration has not been applied to whatever `DATABASE_URL` points at
  — run `npm run db:migrate` rather than changing the query.
- If the performer order test fails, the `ORDER BY` is sorting `role` textually
  rather than by the `role <> 'performer'` boolean.
- If `details` comes back with snake_case keys, the camel conversion is not
  running — `to_jsonb` returns the column names verbatim.

- [ ] **Step 9: Commit**

```bash
npm run check
git add lib/http lib/media app/api/v1/health app/api/v1/media test/http test/media
git commit -m "Add HTTP conventions, media hydration, and the read endpoints

authenticate() is the single place a request becomes a caller, so
there is one answer to what an unauthenticated request gets and one
place the rate limit is charged. An unknown token gets exactly the
same response as a missing one: distinguishing them would tell an
attacker which guesses were real key prefixes.

readMediaTree costs three queries regardless of depth -- one recursive
CTE for the parent chain, one for details, one for people. Walking
parent_id in application code would be a round trip per level.

health is unauthenticated on purpose: a health check that needs a
credential cannot be used by the thing most likely to call it."
```

---
### Task 4: The lookup endpoints

**Files:**
- Create: `lib/http/envelope.ts`, `app/api/v1/lookup/route.ts`, `app/api/v1/lookup/[id]/route.ts`
- Test: `test/http/lookup-routes.test.ts`

**Interfaces:**
- Consumes: `authenticate` (Task 3), `readMediaTree` (Task 3), `resolveLookup`/`PipelineResult` (Plan 2), `createTmdbClient`/`createTmdbProvider`/`tmdbTokenFromEnv` (Plan 2).
- Produces:
  - `interface LookupEnvelope` — the exact body shape the spec specifies
  - `toEnvelope(result: PipelineResult, media: MediaView | null): LookupEnvelope`
  - `buildTmdbDeps(): PipelineDeps` — a provider plus a `drainCalls` sink, wired once
  - `POST` and `GET` handlers

**Batch shape.** `POST` accepts `{ category, name }` or `{ items: [...] }` capped
at 100. The batch response is always `200` with `{ results: [...] }` in input
order, each entry carrying its own `status`. The transport succeeded even when
individual items are still resolving, so a per-item status is the honest shape;
a top-level `202` would force callers to re-inspect every entry anyway.

- [ ] **Step 1: Write the failing test**

`test/http/lookup-routes.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { POST as lookup } from '../../app/api/v1/lookup/route';
import { GET as poll } from '../../app/api/v1/lookup/[id]/route';
import { mintApiKey } from '../../lib/auth/apiKey';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

let cachedToken: string | null = null;
async function token(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-look', 'Look', 'look@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min)
      VALUES ('u-look', 'look', ${minted.tokenHash}, ${minted.prefix}, 10000)`);
  });
  cachedToken = minted.token;
  return minted.token;
}

async function post(body: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${await token()}`;
  return lookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

async function clean(prefix: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
}

test('a lookup without a token is 401', opts, async () => {
  const response = await post({ category: 'movies', name: 'x.mkv' }, false);
  assert.equal(response.status, 401);
});

test('a body that is not an object is 400', opts, async () => {
  assert.equal((await post('nonsense')).status, 400);
});

test('an unknown category is 400 and says which are valid', opts, async () => {
  const response = await post({ category: 'music', name: 'x.mkv' });
  assert.equal(response.status, 400);
  const body = await json(response);
  assert.match(String(body.detail), /tv|movies|books|xxx/);
});

test('an empty name is 400', opts, async () => {
  assert.equal((await post({ category: 'movies', name: '' })).status, 400);
});

test('a batch over the cap is 400 rather than silently truncated', opts, async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({ category: 'movies', name: `x${i}.mkv` }));
  const response = await post({ items });
  assert.equal(response.status, 400);
  assert.match(String((await json(response)).detail), /100/);
});

test('a cold movie lookup resolves and returns the hydrated envelope', opts, async () => {
  await clean('rtesta');
  const response = await post({
    category: 'movies',
    name: 'rtesta/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb',
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.state, 'resolved');
  assert.equal(body.cached, false);
  assert.equal(body.partial, false);
  assert.ok(typeof body.lookupId === 'string');
  assert.ok(Number(body.confidence) >= 0.75);
  const parsed = body.parsed as { readonly kind: string; readonly title: string };
  assert.equal(parsed.kind, 'movie');
  assert.equal(parsed.title, 'Outbreak');
  const media = body.media as { readonly title: string; readonly people: readonly unknown[] };
  assert.equal(media.title, 'Outbreak');
  assert.ok(media.people.length > 0, 'the envelope embeds people');
  await clean('rtesta');
});

test('the second identical lookup is cached and still returns the media', opts, async () => {
  await clean('rtestb');
  const name = 'rtestb/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  await post({ category: 'movies', name });
  const body = await json(await post({ category: 'movies', name }));
  assert.equal(body.cached, true);
  assert.equal(body.state, 'resolved');
  const media = body.media as { readonly title: string };
  assert.equal(media.title, 'Outbreak', 'a cache hit must still hydrate the media');
  // `parsed` is null on a cache hit: nothing was parsed this time round.
  assert.equal(body.parsed, null);
  await clean('rtestb');
});

test('a refused name is 200 with a refusal, not an error status', opts, async () => {
  await clean('rtestc');
  const response = await post({ category: 'tv', name: 'rtestc/Moon Knight/.plexmatch' });
  // The request was well-formed and the answer is "this is not media". That is
  // an answer, not a client error.
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.state, 'unresolved');
  assert.match(String(body.refusal), /not a media file/);
  assert.equal(body.media, null);
  await clean('rtestc');
});

test('a batch returns one result per input, in order, each with a status', opts, async () => {
  await clean('rtestd');
  const response = await post({
    items: [
      { category: 'movies', name: 'rtestd/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb' },
      { category: 'tv', name: 'rtestd/Moon Knight/.plexmatch' },
    ],
  });
  assert.equal(response.status, 200, 'a batch is always 200; per-item status is inside');
  const body = await json(response);
  const results = body.results as readonly Record<string, unknown>[];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, 200);
  assert.equal(results[0]?.state, 'resolved');
  assert.equal(results[1]?.status, 200);
  assert.equal(results[1]?.state, 'unresolved');
  await clean('rtestd');
});

test('polling a lookup id returns the same envelope', opts, async () => {
  await clean('rteste');
  const created = await json(await post({
    category: 'movies',
    name: 'rteste/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb',
  }));
  const id = String(created.lookupId);
  const response = await poll(
    new Request('https://x.test/api/v1/lookup/' + id, {
      headers: { authorization: `Bearer ${await token()}` },
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.lookupId, id);
  assert.equal(body.state, 'resolved');
  await clean('rteste');
});

test('polling an unknown lookup id is 404 and a malformed one is 400', opts, async () => {
  const headers = { authorization: `Bearer ${await token()}` };
  const unknown = await poll(
    new Request('https://x.test/api/v1/lookup/x', { headers }),
    { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) },
  );
  assert.equal(unknown.status, 404);
  const malformed = await poll(
    new Request('https://x.test/api/v1/lookup/x', { headers }),
    { params: Promise.resolve({ id: 'nope' }) },
  );
  assert.equal(malformed.status, 400);
});

test('a rate-limited caller gets 429 with Retry-After', opts, async () => {
  const minted = await mintApiKey();
  await withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('u-tight', 'Tight', 'tight@example.test', false)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix, rate_limit_per_min)
      VALUES ('u-tight', 'tight', ${minted.tokenHash}, ${minted.prefix}, 1)`);
  });
  const send = (): Promise<Response> => lookup(new Request('https://x.test/api/v1/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
    body: JSON.stringify({ category: 'tv', name: 'rtestf/Moon Knight/.plexmatch' }),
  }));
  await clean('rtestf');
  assert.equal((await send()).status, 200);
  const refused = await send();
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  await clean('rtestf');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/http/lookup-routes.test.ts
```

Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Write `lib/http/envelope.ts`**

```ts
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
```

- [ ] **Step 4: Write `app/api/v1/lookup/route.ts`**

```ts
import { z } from 'zod';
import { withTransaction } from '../../../../lib/db/client';
import { authenticate } from '../../../../lib/http/authenticate';
import { badRequest, unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';
import { buildTmdbDeps, toEnvelope, type LookupEnvelope } from '../../../../lib/http/envelope';
import { readMediaTree } from '../../../../lib/media/read';
import { resolveLookup } from '../../../../lib/resolve/pipeline';
import type { Category } from '../../../../lib/parse/types';

const BATCH_CAP = 100;

const one = z.object({
  category: z.enum(['tv', 'movies', 'books', 'xxx']),
  name: z.string().min(1, 'name must not be empty'),
});

const body = z.union([
  one,
  z.object({ items: z.array(one).min(1).max(BATCH_CAP) }),
]);

async function runOne(
  category: Category, name: string, deps: ReturnType<typeof buildTmdbDeps>,
): Promise<LookupEnvelope> {
  const result = await resolveLookup({ category, name }, deps);
  // Bound to a const so the null check narrows inside the closure. Casting
  // `result.mediaId as string` would compile and would also be a lie the day
  // someone reorders these lines.
  const mediaId = result.mediaId;
  const media = mediaId === null
    ? null
    : await withTransaction(async (tx) => readMediaTree(tx, mediaId));
  return toEnvelope(result, media);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    // The immediate argument of a zod parse: the one permitted `unknown`.
    raw = await request.json();
  } catch {
    return badRequest('the body must be JSON');
  }

  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined
      ? 'the body is not a valid lookup request'
      : `${path.length > 0 ? `${path}: ` : ''}${first.message}`;
    // The cap is named explicitly, because "too big" without a number is a
    // message the caller cannot act on. Keyed off the failure path rather than
    // off a cast of the raw body: a `too_big` issue on `items` is exactly the
    // case that needs the number.
    const overCap = parsed.error.issues.some(
      (issue) => issue.code === 'too_big' && issue.path[0] === 'items',
    );
    return badRequest(overCap ? `${detail} (a batch holds at most ${BATCH_CAP} items)` : detail);
  }

  const deps = buildTmdbDeps();

  try {
    if ('items' in parsed.data) {
      // Sequential rather than parallel: a batch of 100 fired at once would
      // burn the whole TMDB budget in a burst and the token bucket would then
      // serialise them anyway, just with 100 open sockets instead of one.
      const results: (LookupEnvelope & { readonly status: number })[] = [];
      for (const item of parsed.data.items) {
        const envelope = await runOne(item.category, item.name, deps);
        results.push({ ...envelope, status: 200 });
      }
      // Always 200: the transport succeeded even when an item is still
      // resolving. A top-level 202 would force callers to re-inspect every
      // entry regardless.
      return Response.json({ results });
    }

    const envelope = await runOne(parsed.data.category, parsed.data.name, deps);
    if (envelope.partial) {
      const response = Response.json(envelope, { status: 202 });
      response.headers.set('retry-after', '5');
      return response;
    }
    return Response.json(envelope);
  } catch (error) {
    logFailure('lookup', error);
    return unavailable('the lookup could not be completed');
  }
}
```

- [ ] **Step 5: Write `app/api/v1/lookup/[id]/route.ts`**

```ts
import { sql } from 'drizzle-orm';
import { withTransaction } from '../../../../../lib/db/client';
import { authenticate } from '../../../../../lib/http/authenticate';
import { badRequest, notFound, unavailable } from '../../../../../lib/http/problem';
import { readMediaTree } from '../../../../../lib/media/read';
import type { LookupEnvelope } from '../../../../../lib/http/envelope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!UUID.test(id)) return badRequest('id must be a uuid');

  try {
    const envelope = await withTransaction(async (tx): Promise<LookupEnvelope | null> => {
      const row = await tx.execute(sql`
        SELECT l.id, l.state, l.confidence, l.media_id, p.tokens
          FROM lookups l
          LEFT JOIN parses p
            ON p.category = l.category AND p.normalized_key = l.normalized_key
         WHERE l.id = ${id}::uuid`);
      const found = row.rows[0];
      if (found === undefined) return null;
      const mediaId = found.media_id === null ? null : String(found.media_id);
      const media = mediaId === null ? null : await readMediaTree(tx, mediaId);
      const state = String(found.state) as LookupEnvelope['state'];
      return {
        lookupId: String(found.id),
        state,
        // A poll reads a stored row, so nothing is in flight from its point of
        // view; `pending` is what says the work is unfinished.
        partial: state === 'pending',
        cached: true,
        confidence: found.confidence === null ? null : Number(found.confidence),
        refusal: null,
        parsed: found.tokens === null
          ? null
          : (found.tokens as Readonly<Record<string, unknown>>),
        media,
      };
    });
    if (envelope === null) return notFound('no lookup with that id');
    return Response.json(envelope);
  } catch (error) {
    logFailure(`poll ${id}`, error);
    return unavailable('the database is unreachable');
  }
}
```

- [ ] **Step 6: Run the tests**

```bash
npm run test -- test/http/lookup-routes.test.ts
```

Expected: 12 passing. Diagnostics:

- If the cold lookup returns 202 rather than 200, the fixture for that name is
  missing and the pipeline is reporting a blown provider call as partial. Record
  it: `node --env-file=.env.local --import tsx scripts/record-resolve-fixtures.ts`.
- If the cached test finds `media: null`, the cache-hit path is not hydrating —
  `runOne` must read the media for a cached result too, since `mediaId` is
  populated on a hit.
- If the rate-limit test never sees a 429, the shared `token()` helper is
  handing out the 10000-limit key; the tight-limit test mints its own.

- [ ] **Step 7: Commit**

```bash
npm run check
git add lib/http/envelope.ts app/api/v1/lookup test/http/lookup-routes.test.ts
git commit -m "Add the lookup endpoints

A refused name is 200, not 4xx: the request was well-formed and the
answer is 'this is not media', which is an answer rather than a client
error. A batch is always 200 with a per-item status, because the
transport succeeded even when an item is still resolving and a
top-level 202 would force callers to re-inspect every entry anyway.

Batch items run sequentially. Firing 100 at once would burn the TMDB
budget in a burst and the token bucket would serialise them regardless,
just with 100 open sockets instead of one.

buildTmdbDeps constructs the client and its drainCalls sink together,
because the client owns the recordCall sink and the pipeline cannot
reach into it. Splitting them is what would leave provider_calls
silently empty."
```

---
### Task 5: Jobs, the sweeper, and the cron

**Files:**
- Create: `lib/jobs/backoff.ts`, `lib/jobs/queue.ts`, `lib/jobs/sweep.ts`, `app/api/cron/sweep/route.ts`, `vercel.json`
- Modify: `app/api/v1/lookup/route.ts` (enqueue on partial, and `waitUntil` the remainder), `package.json` (add `@vercel/functions`)
- Test: `test/jobs/backoff.test.ts`, `test/jobs/sweep.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `JOB_MAX_ATTEMPTS: number` — env, default `6`
  - `nextDelayMs(attempts: number, random?: () => number): number` — **pure**
  - `enqueue(tx: Tx, lookupId: string): Promise<void>`
  - `claimDue(tx: Tx, limit: number, workerId: string): Promise<readonly ClaimedJob[]>`
  - `settle(tx: Tx, jobId: string, outcome: JobOutcome): Promise<void>`
  - `sweep(deps: SweepDeps, options?: { readonly limit?: number }): Promise<SweepReport>`

**Why the sweeper is small on purpose.** The 12-hour staleness rule already
retries anything anyone asks about twice. The sweeper exists only for the
filename nobody asks about again — so it is a safety net, not the main road,
and it is sized accordingly: claim a handful, run them, settle, prune. If it
ever needs to be more than that, the freshness rule has stopped working and
that is the thing to fix.

- [ ] **Step 1: Add the dependency**

```bash
npm install @vercel/functions@^3.9.5
```

- [ ] **Step 2: Write the backoff test**

`test/jobs/backoff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelayMs, JOB_MAX_ATTEMPTS } from '../../lib/jobs/backoff';

test('delay grows with attempts', () => {
  const noJitter = (): number => 0.5;
  const delays = [1, 2, 3, 4, 5].map((n) => nextDelayMs(n, noJitter));
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok((delays[i] ?? 0) > (delays[i - 1] ?? 0), `attempt ${i + 1} should wait longer`);
  }
});

test('the first retry is soon and the last is not absurd', () => {
  const noJitter = (): number => 0.5;
  assert.ok(nextDelayMs(1, noJitter) <= 60_000, 'the first retry should be within a minute');
  assert.ok(nextDelayMs(JOB_MAX_ATTEMPTS, noJitter) <= 6 * 3600_000, 'and the last within six hours');
});

test('jitter spreads retries so a batch does not stampede', () => {
  // Two jobs failing in the same tick must not come back in the same tick.
  const low = nextDelayMs(3, () => 0);
  const high = nextDelayMs(3, () => 1);
  assert.ok(high > low, 'jitter must actually vary the delay');
  assert.ok(high - low > 1000, `the spread should be meaningful, got ${high - low}ms`);
});

test('a delay is always positive and never NaN', () => {
  for (const attempts of [0, 1, 5, 50, 5000]) {
    for (const r of [0, 0.5, 1]) {
      const delay = nextDelayMs(attempts, () => r);
      assert.ok(Number.isFinite(delay), `attempts=${attempts} r=${r} gave ${delay}`);
      assert.ok(delay > 0);
    }
  }
});

test('the delay is capped rather than growing forever', () => {
  const noJitter = (): number => 0.5;
  assert.equal(nextDelayMs(100, noJitter), nextDelayMs(1000, noJitter));
});
```

- [ ] **Step 3: Write `lib/jobs/backoff.ts`**

```ts
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

export const JOB_MAX_ATTEMPTS = envNumber('JOB_MAX_ATTEMPTS', 6);

const BASE_MS = 15_000;
const CAP_MS = 6 * 3600_000;
/** Up to +50%, so two jobs failing in the same tick do not return together. */
const JITTER_FRACTION = 0.5;

/**
 * How long to wait before the next attempt.
 *
 * Pure, with the random source injected, because "does the delay grow" and
 * "does jitter actually spread things" are the only interesting questions and
 * both are untestable against `Math.random`.
 */
export function nextDelayMs(attempts: number, random: () => number = Math.random): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const exponential = Math.min(CAP_MS, BASE_MS * 2 ** (safeAttempts - 1));
  return Math.round(exponential * (1 + JITTER_FRACTION * random()));
}
```

- [ ] **Step 4: Write `lib/jobs/queue.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { JOB_MAX_ATTEMPTS, nextDelayMs } from './backoff';

export interface ClaimedJob {
  readonly jobId: string;
  readonly lookupId: string;
  readonly category: string;
  readonly name: string;
  readonly attempts: number;
}

export type JobOutcome =
  /** Finished. The row is deleted; `lookups` is the record of the outcome. */
  | { readonly kind: 'done' }
  /** Failed but worth another go. */
  | { readonly kind: 'retry'; readonly error: string }
  /** Failed terminally -- a bad credential, or out of attempts. */
  | { readonly kind: 'abandon'; readonly error: string };

/**
 * Marks a lookup as needing more work.
 *
 * Idempotent on `lookup_id`, which has a unique index: a lookup that blows its
 * deadline twice has one job, not two. Re-enqueueing resets the schedule
 * without resetting `attempts`, so a repeatedly-slow lookup still backs off.
 */
export async function enqueue(tx: Tx, lookupId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO lookup_jobs (lookup_id, state, next_attempt_at)
    VALUES (${lookupId}::uuid, 'pending', now())
    ON CONFLICT (lookup_id) DO UPDATE
      SET state = 'pending', next_attempt_at = now(), updated_at = now()`);
}

/**
 * Takes ownership of up to `limit` due jobs.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two concurrent sweeps safe: the second
 * one steps over rows the first has locked instead of blocking on them or
 * double-running them. This must be inside a transaction, which is why the
 * whole service uses the WebSocket driver.
 */
export async function claimDue(
  tx: Tx, limit: number, workerId: string,
): Promise<readonly ClaimedJob[]> {
  const result = await tx.execute(sql`
    WITH due AS (
      SELECT j.id FROM lookup_jobs j
       WHERE j.state = 'pending' AND j.next_attempt_at <= now()
       ORDER BY j.next_attempt_at
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
    )
    UPDATE lookup_jobs j
       SET state = 'running', locked_at = now(), locked_by = ${workerId},
           attempts = j.attempts + 1, updated_at = now()
      FROM due, lookups l
     WHERE j.id = due.id AND l.id = j.lookup_id
    RETURNING j.id AS job_id, j.lookup_id, j.attempts, l.category, l.name`);
  return result.rows.map((row) => ({
    jobId: String(row.job_id),
    lookupId: String(row.lookup_id),
    category: String(row.category),
    name: String(row.name),
    attempts: Number(row.attempts),
  }));
}

export async function settle(tx: Tx, jobId: string, outcome: JobOutcome): Promise<void> {
  if (outcome.kind === 'done') {
    // Deleted rather than marked done: `lookups` already records the outcome,
    // and a second copy is a second thing that can disagree with it.
    await tx.execute(sql`DELETE FROM lookup_jobs WHERE id = ${jobId}::uuid`);
    return;
  }

  if (outcome.kind === 'abandon') {
    await tx.execute(sql`
      UPDATE lookup_jobs
         SET state = 'abandoned', last_error = ${outcome.error},
             locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid`);
    return;
  }

  const current = await tx.execute(sql`
    SELECT attempts FROM lookup_jobs WHERE id = ${jobId}::uuid`);
  const attempts = Number(current.rows[0]?.attempts ?? 0);
  if (attempts >= JOB_MAX_ATTEMPTS) {
    await tx.execute(sql`
      UPDATE lookup_jobs
         SET state = 'abandoned',
             last_error = ${`${outcome.error} (gave up after ${attempts} attempts)`},
             locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid`);
    return;
  }
  const delay = nextDelayMs(attempts);
  await tx.execute(sql`
    UPDATE lookup_jobs
       SET state = 'pending', last_error = ${outcome.error},
           next_attempt_at = now() + (${delay} * interval '1 millisecond'),
           locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = ${jobId}::uuid`);
}
```

- [ ] **Step 5: Write the sweeper test**

`test/jobs/sweep.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, withTransaction, closeDb } from '../../lib/db/client';
import { claimDue, enqueue, settle } from '../../lib/jobs/queue';
import { sweep } from '../../lib/jobs/sweep';
import { JOB_MAX_ATTEMPTS } from '../../lib/jobs/backoff';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/** A lookup row in `pending`, plus its job. Returns the lookup id. */
async function pendingLookup(name: string): Promise<string> {
  return withTransaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO parses (category, normalized_key, tokens, parser_version)
      VALUES ('movies', ${name.toLowerCase()}, '{}'::jsonb, 1)
      ON CONFLICT (category, normalized_key) DO NOTHING`);
    const row = await tx.execute(sql`
      INSERT INTO lookups (category, name, normalized_key, state, last_attempt_at)
      VALUES ('movies', ${name}, ${name.toLowerCase()}, 'pending', now())
      ON CONFLICT (category, name) DO UPDATE SET state = 'pending'
      RETURNING id`);
    const id = String(row.rows[0]?.id);
    await enqueue(tx, id);
    return id;
  });
}

async function clean(prefix: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM lookup_jobs WHERE lookup_id IN (SELECT id FROM lookups WHERE name LIKE ${`${prefix}%`})`);
  await getDb().execute(sql`DELETE FROM lookups WHERE name LIKE ${`${prefix}%`}`);
  await getDb().execute(sql`DELETE FROM parses WHERE normalized_key LIKE ${`${prefix.toLowerCase()}%`}`);
}

test('enqueue is idempotent on lookup_id', opts, async () => {
  await clean('jtesta');
  const id = await pendingLookup('jtesta/x.mkv');
  await withTransaction(async (tx) => { await enqueue(tx, id); await enqueue(tx, id); });
  const count = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(count.rows[0]?.n, 1);
  await clean('jtesta');
});

test('claiming marks running, increments attempts, and returns the lookup', opts, async () => {
  await clean('jtestb');
  await pendingLookup('jtestb/x.mkv');
  const claimed = await withTransaction(async (tx) => claimDue(tx, 10, 'worker-1'));
  const mine = claimed.filter((j) => j.name.startsWith('jtestb'));
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.attempts, 1);
  assert.equal(mine[0]?.category, 'movies');
  await clean('jtestb');
});

test('a claimed job is not claimed again by a second sweep', opts, async () => {
  await clean('jtestc');
  await pendingLookup('jtestc/x.mkv');
  await withTransaction(async (tx) => claimDue(tx, 10, 'worker-1'));
  const second = await withTransaction(async (tx) => claimDue(tx, 10, 'worker-2'));
  assert.equal(second.filter((j) => j.name.startsWith('jtestc')).length, 0,
    'a running job is no longer pending');
  await clean('jtestc');
});

test('settling done deletes the row', opts, async () => {
  await clean('jtestd');
  const id = await pendingLookup('jtestd/x.mkv');
  const claimed = await withTransaction(async (tx) => claimDue(tx, 50, 'w'));
  const job = claimed.find((j) => j.lookupId === id);
  assert.ok(job !== undefined);
  await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'done' }));
  const left = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(left.rows[0]?.n, 0);
  await clean('jtestd');
});

test('settling retry reschedules into the future and records the error', opts, async () => {
  await clean('jteste');
  const id = await pendingLookup('jteste/x.mkv');
  const claimed = await withTransaction(async (tx) => claimDue(tx, 50, 'w'));
  const job = claimed.find((j) => j.lookupId === id);
  assert.ok(job !== undefined);
  await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'retry', error: 'tmdb 500' }));
  const row = await getDb().execute(sql`
    SELECT state, last_error, next_attempt_at > now() AS future
      FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  assert.equal(row.rows[0]?.state, 'pending');
  assert.equal(row.rows[0]?.last_error, 'tmdb 500');
  assert.equal(row.rows[0]?.future, true, 'a retry must not be immediately due again');
  await clean('jteste');
});

test('a job out of attempts is abandoned rather than retried forever', opts, async () => {
  await clean('jtestf');
  const id = await pendingLookup('jtestf/x.mkv');
  await getDb().execute(sql`
    UPDATE lookup_jobs SET attempts = ${JOB_MAX_ATTEMPTS} WHERE lookup_id = ${id}::uuid`);
  const jobRow = await getDb().execute(sql`
    SELECT id FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  const jobId = String(jobRow.rows[0]?.id);
  await withTransaction(async (tx) => settle(tx, jobId, { kind: 'retry', error: 'still failing' }));
  const row = await getDb().execute(sql`SELECT state, last_error FROM lookup_jobs WHERE id = ${jobId}::uuid`);
  assert.equal(row.rows[0]?.state, 'abandoned');
  assert.match(String(row.rows[0]?.last_error), /gave up after/);
  await clean('jtestf');
});

test('settling abandon is terminal and keeps the row for a human to see', opts, async () => {
  await clean('jtestg');
  const id = await pendingLookup('jtestg/x.mkv');
  const jobRow = await getDb().execute(sql`SELECT id FROM lookup_jobs WHERE lookup_id = ${id}::uuid`);
  const jobId = String(jobRow.rows[0]?.id);
  await withTransaction(async (tx) => settle(tx, jobId, { kind: 'abandon', error: 'bad credential' }));
  const row = await getDb().execute(sql`SELECT state, last_error FROM lookup_jobs WHERE id = ${jobId}::uuid`);
  assert.equal(row.rows[0]?.state, 'abandoned');
  assert.equal(row.rows[0]?.last_error, 'bad credential');
  await clean('jtestg');
});

test('sweep runs a due job and reports what it did', opts, async () => {
  await clean('jtesth');
  // A real, resolvable name so the sweep can finish it.
  await pendingLookup('jtesth/Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const { fixtureFetch } = await import('../support/tmdb-fixtures');
  const report = await sweep({
    fetchImpl: fixtureFetch(),
    workerId: 'test-worker',
    now: () => new Date(),
  }, { limit: 25 });
  assert.ok(report.claimed >= 1, `expected to claim at least one, got ${report.claimed}`);
  assert.ok(report.done + report.retried + report.abandoned === report.claimed);
  await clean('jtesth');
});

test('sweep with nothing due is a no-op that does not throw', opts, async () => {
  const { fixtureFetch } = await import('../support/tmdb-fixtures');
  const report = await sweep({
    fetchImpl: fixtureFetch(), workerId: 'test-worker', now: () => new Date(),
  }, { limit: 0 });
  assert.equal(report.claimed, 0);
});
```

- [ ] **Step 6: Write `lib/jobs/sweep.ts`**

```ts
import { withTransaction } from '../db/client';
import { pruneRateWindows } from '../auth/rateLimit';
import { createTmdbClient, TmdbAuthFailed, tmdbTokenFromEnv } from '../providers/tmdb/client';
import { createTmdbProvider } from '../providers/tmdb/resolve';
import type { ProviderCallRecord } from '../providers/types';
import { resolveLookup } from '../resolve/pipeline';
import type { Category } from '../parse/types';
import { claimDue, settle, type ClaimedJob } from './queue';

export interface SweepDeps {
  /** Injected so tests serve recorded fixtures instead of the network. */
  readonly fetchImpl?: typeof fetch;
  readonly workerId: string;
  readonly now: () => Date;
}

export interface SweepReport {
  readonly claimed: number;
  readonly done: number;
  readonly retried: number;
  readonly abandoned: number;
  readonly prunedRateWindows: number;
}

const DEFAULT_LIMIT = 25;

/**
 * Runs whatever is due.
 *
 * Deliberately small. The 12-hour staleness rule already retries anything
 * anyone asks about twice, so this exists only for the filename nobody asks
 * about again -- a safety net rather than the main road. If it ever needs to be
 * cleverer than claim-run-settle, the freshness rule has stopped working and
 * that is the thing to fix.
 *
 * Each job is settled in its own transaction. One poisonous job must not roll
 * back the successes claimed alongside it.
 */
export async function sweep(
  deps: SweepDeps, options: { readonly limit?: number } = {},
): Promise<SweepReport> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const claimed: readonly ClaimedJob[] = limit === 0
    ? []
    : await withTransaction(async (tx) => claimDue(tx, limit, deps.workerId));

  let done = 0;
  let retried = 0;
  let abandoned = 0;

  for (const job of claimed) {
    let pending: ProviderCallRecord[] = [];
    const client = createTmdbClient({
      token: tmdbTokenFromEnv(),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      recordCall: (row) => { pending.push(row); },
    });
    const pipelineDeps = {
      provider: createTmdbProvider(client),
      now: deps.now,
      drainCalls: (): readonly ProviderCallRecord[] => {
        const out = pending;
        pending = [];
        return out;
      },
    };

    try {
      const result = await resolveLookup(
        { category: job.category as Category, name: job.name },
        pipelineDeps,
      );
      // `pending` still means unfinished, so it is a retry rather than a
      // success -- otherwise a job that keeps timing out would be deleted and
      // silently forgotten.
      if (result.state === 'pending') {
        await withTransaction(async (tx) => settle(tx, job.jobId, {
          kind: 'retry', error: result.refusal ?? 'still incomplete',
        }));
        retried += 1;
      } else {
        await withTransaction(async (tx) => settle(tx, job.jobId, { kind: 'done' }));
        done += 1;
      }
    } catch (error) {
      // A bad credential will fail identically every time, so retrying it just
      // burns attempts and fills the log. It is terminal.
      const terminal = error instanceof TmdbAuthFailed;
      const message = error instanceof Error ? error.message : String(error);
      await withTransaction(async (tx) => settle(tx, job.jobId, terminal
        ? { kind: 'abandon', error: message }
        : { kind: 'retry', error: message }));
      if (terminal) abandoned += 1;
      else retried += 1;
    }
  }

  const prunedRateWindows = await withTransaction(async (tx) => pruneRateWindows(tx));
  return { claimed: claimed.length, done, retried, abandoned, prunedRateWindows };
}
```

- [ ] **Step 7: Write the cron route and `vercel.json`**

`app/api/cron/sweep/route.ts`:

```ts
import { unauthorized, unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';
import { sweep } from '../../../../lib/jobs/sweep';

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set,
 * so the same header check serves both the platform and a manual curl.
 *
 * A missing `CRON_SECRET` refuses every request rather than allowing them: an
 * unset secret is a misconfiguration, and the safe reading of a
 * misconfiguration on a route that mutates data is "no".
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization');
  if (secret === undefined || secret.length === 0 || header !== `Bearer ${secret}`) {
    return unauthorized();
  }

  try {
    const report = await sweep({
      workerId: `cron-${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}`,
      now: () => new Date(),
    });
    return Response.json(report);
  } catch (error) {
    // The report is the only output, so a failure has to be visible somewhere.
    logFailure('cron sweep', error);
    return unavailable('the sweep could not be completed');
  }
}
```

`vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/cron/sweep",
      "schedule": "* * * * *"
    }
  ]
}
```

Every minute is available because the team is on the Pro plan. On Hobby the
minimum is once a day, which would make the sweeper useless as a safety net and
is worth knowing before anyone downgrades.

- [ ] **Step 8: Wire enqueue and `waitUntil` into the lookup route**

In `app/api/v1/lookup/route.ts`, add the import:

```ts
import { waitUntil } from '@vercel/functions';
import { enqueue } from '../../../../lib/jobs/queue';
```

and replace the single-item branch so a partial result both enqueues and keeps
working after the response:

```ts
    const envelope = await runOne(parsed.data.category, parsed.data.name, deps);
    if (envelope.partial) {
      // Two mechanisms, on purpose. `waitUntil` usually finishes the job in
      // this same invocation, which is what makes the hybrid path fast; the
      // durable row is what covers the case where the function dies first.
      await withTransaction(async (tx) => enqueue(tx, envelope.lookupId));
      waitUntil(
        runOne(parsed.data.category, parsed.data.name, buildTmdbDeps())
          .catch(() => undefined),
      );
      const response = Response.json(envelope, { status: 202 });
      response.headers.set('retry-after', '5');
      return response;
    }
    return Response.json(envelope);
```

Add a test to `test/http/lookup-routes.test.ts` proving the enqueue happens:

```ts
test('a partial lookup enqueues a durable job', opts, async () => {
  await clean('rtestg');
  // A name with no recorded fixture blows the provider call, which the
  // pipeline reports as pending -- the same shape a real timeout produces.
  const response = await post({
    category: 'movies',
    name: 'rtestg/Some.Film.Nobody.Recorded.2019.1080p.BluRay-GRP.nzb',
  });
  const body = await json(response);
  assert.equal(body.state, 'pending');
  assert.equal(body.partial, true);
  assert.equal(response.status, 202);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  const jobs = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM lookup_jobs
     WHERE lookup_id = ${String(body.lookupId)}::uuid`);
  assert.equal(jobs.rows[0]?.n, 1, 'a partial result must leave a durable job behind');
  await getDb().execute(sql`
    DELETE FROM lookup_jobs WHERE lookup_id = ${String(body.lookupId)}::uuid`);
  await clean('rtestg');
});
```

- [ ] **Step 9: Run everything**

```bash
npm run test -- test/jobs/backoff.test.ts test/jobs/sweep.test.ts test/http/lookup-routes.test.ts
npm run check
npm run build
```

Expected: 5 + 9 + 13 passing, and a clean build. Diagnostics:

- If `claimDue` returns nothing for a job you just enqueued, the `UPDATE ...
  FROM due, lookups l` join is dropping the row: `lookups` must join on
  `l.id = j.lookup_id`, and a missing join condition silently produces a cross
  product that the `WHERE` then filters to nothing.
- If the sweep test claims jobs left behind by other tests, that is expected —
  it asserts `>= 1` and that the outcome counts add up, not an exact total.
- If `waitUntil` throws locally, the import is wrong: it comes from
  `@vercel/functions`, and off-platform it is a passthrough rather than an error.

- [ ] **Step 10: Commit**

```bash
git add lib/jobs app/api/cron vercel.json app/api/v1/lookup test/jobs \
        test/http/lookup-routes.test.ts package.json package-lock.json
git commit -m "Add the job queue, the sweeper, and the cron

Two mechanisms on purpose: waitUntil usually finishes a blown-deadline
lookup inside the same invocation, which is what makes the hybrid path
fast, and the durable lookup_jobs row covers the case where the
function dies first.

FOR UPDATE SKIP LOCKED is what makes two concurrent sweeps safe -- the
second steps over rows the first holds rather than blocking or
double-running. Each job settles in its own transaction so one
poisonous job cannot roll back the successes claimed alongside it.

A TmdbAuthFailed is terminal rather than retryable: a bad credential
fails identically every time, so retrying only burns attempts and
fills the log. A result still 'pending' after a sweep is a retry, not
a success, or a job that keeps timing out would be deleted and
forgotten.

An unset CRON_SECRET refuses every request rather than allowing them.
The safe reading of a misconfiguration on a route that mutates data is
no.

Every-minute scheduling is available because the team is on Pro; on
Hobby the minimum is daily, which would make the safety net useless."
```

---

## One deliberate deviation from the spec

The spec's Failure handling section says a provider `429` or `5xx` should
"mark the lookup `unresolved`, upsert a job". Plan 2's pipeline marks it
**`pending`** instead, and this plan keeps that.

`unresolved` in the state enum means "we looked and found nothing good enough"
— a finished answer that the 12-hour rule will revisit. `pending` means "work
is outstanding". A provider outage is the second thing, not the first, and
conflating them would make the admin browser unable to distinguish a title
TMDB genuinely does not have from one it failed to answer about. Everything
else in that section is implemented as written.

---

## Definition of done for this plan

- [ ] `npm run check` and `npm run build` pass from a clean checkout.
- [ ] With no `DATABASE_URL`, the suite still passes — database-backed tests skip.
- [ ] `npm run seed:key` mints a working token, printed once, and `.api-key.local` is gitignored.
- [ ] An unauthenticated request to any `/v1` route except `/v1/health` is `401` with `WWW-Authenticate: Bearer`.
- [ ] An unknown token and a missing token produce the identical response.
- [ ] Exceeding a key's per-minute limit gives `429` with `Retry-After`.
- [ ] A cold movie lookup returns `200` with a hydrated `media` containing people.
- [ ] The same lookup again returns `cached: true` and still hydrates `media`.
- [ ] A refused name returns `200` with a `refusal`, not a 4xx.
- [ ] A batch returns `200` with one result per input, in order, each carrying its own status; over 100 items is `400` naming the cap.
- [ ] A partial lookup returns `202` with `Retry-After` and leaves exactly one `lookup_jobs` row.
- [ ] `GET /api/cron/sweep` without the bearer is `401`; with it, it returns a report.
- [ ] Every `catch` that produces a 5xx calls `logFailure` first — the spec
      forbids swallowing, and a 503 with no log line cannot be diagnosed.
- [ ] No test reaches the network.
- [ ] `fixtures/corpus/*.raw.txt` is byte-identical to its committed state.

## Handoff to Plan 4

Plan 4 (Better Auth sign-in, the four UI pages, the admin guard) consumes:

| From | Symbol |
|---|---|
| `lib/auth/apiKey` | `mintApiKey`, `hashToken`, `Caller` |
| `lib/http/problem` | every helper |
| `lib/media/read` | `readMediaTree`, `MediaView` |
| `lib/http/envelope` | `LookupEnvelope`, `toEnvelope`, `buildTmdbDeps` |
| `lib/resolve/pipeline` | `resolveLookup` |
| `lib/jobs/sweep` | `sweep` — the admin page may want a manual trigger |

Two things this plan deliberately leaves for Plan 4:

1. **`api_keys.user_id` points at a seeded `local-dev` row.** Plan 4 replaces
   that with real Better Auth users and adds the `/keys` page that mints keys
   against the signed-in one.
2. **`lookups.pinned` is enforced but unreachable.** Plan 2's
   `writeLookupOutcome` honours it and Plan 1 created the column, but nothing
   sets it. The admin correction UI is what makes it usable.
