# Bulk Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the UI the spec describes: a corpus runner that measures the parser against a list of real names, and an admin cache browser that can find the rows worth looking at.

**Architecture:** Both pages are bulk surfaces over machinery that already exists. `/corpus` drives the existing batch path in `handleLookup` through a new session-gated route, chunked small enough to fit a function's time budget, with progress and aggregates computed in the browser. `/admin/cache` is a server component reading its filters from the URL, backed by one query module that returns a page and its total together.

**Tech Stack:** Node 26, Next.js 16.3.3 App Router, React 19.2, TypeScript 7.0.2, Tailwind 4.3.3, shadcn 4.19.0 primitives (including `select` and `textarea`, installed in Plan 5 and unused until now), Drizzle 0.45.2, zod 4.4.3, oxlint 1.80.0, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`

**Plan sequence:** Plan 6 of 6, and the last of the spec's original scope. Plans 1–5 are merged and pushed; `origin/main` is at `33a0a6d`. This plan delivers the two pages Plan 5 deferred — `/corpus` (spec line 585) and `/admin/cache` (spec line 589) — and with them the spec's success criterion 7.

## Before you start

Nothing is needed from the user. Every variable this plan touches is already set, and the dev database holds enough variety to exercise every filter: 106 lookups across two categories, all three states, both scored and unscored rows, and exactly one `categoryDisagreement` row.

**The dev `DATABASE_URL` was rotated** during Plan 5 after a reviewer interpolated it into a shell command that failed and echoed it. If a database command fails to authenticate, stop and report rather than investigating the connection string.

## Global Constraints

- **Node >= 26.** ESM only. No `require`.
- **No `any`.** oxlint sets `typescript/no-explicit-any` to `error`, and treats an **unused import** as an error too.
- **`unknown` only at a deserialization boundary**, with a comment naming which exception it is.
- **No TypeScript enums, namespaces, or parameter properties** (`erasableSyntaxOnly: true`).
- **`exactOptionalPropertyTypes: true`.** Prefer `field: T | null` over `field?: T`.
- **`noUncheckedIndexedAccess: true`.** `array[i]` is `T | undefined`; narrow before use.
- **2-space indentation, semicolons always.** `readonly` on interface fields and array types, **including component props**.
- **`import { useState, type FormEvent } from 'react'`, never `React.FormEvent`.** Likewise `import type { ReactNode }`.
- **Never wrap a control-flow throw in a `try`.** `redirect()`, `notFound()` from `next/navigation`, and **`headers()`** all signal by throwing — `headers()` is how a route gets marked dynamic during static generation. This mistake has been made twice on this project; the rule is about any function that throws to signal, not about `redirect` specifically.
- **Prefer the async form of any API.** No `*Sync` where anything waits on the event loop.
- **Every `catch` that produces a 5xx calls `logFailure`** from `lib/http/log.ts`.
- **No module may call `getAuth()` or `getDb()` at module scope.**
- **Offline tests. No test reaches the network.** No test may call TMDB. The dev cache holds resolved names; use one and assert `cached === true`.
- **Database-backed tests skip without `DATABASE_URL`**, and **clean up in a `finally`** — not after their assertions.
- **Never log or render a credential.** **Never read or print `.env.local`, and never interpolate a credential into a command line** — any command that fails echoes its whole argument list, which is how a password leaked during Plan 5.
- **To run one test file, do not use `npm run test -- <file>`.** The `test` script ends in a glob, and an appended path is *added* to it rather than replacing it — so that command silently runs the whole suite. Measured: `npm run test -- test/corpus/nonexistent.test.ts` ran all 329 tests. Use `node --env-file-if-exists=.env.local --import tsx --test <file>` instead, which runs only that file. This mattered because a RED step's failure was otherwise buried in 300+ passing tests.
- **Verification gate.** No task is complete until `npm run check` **and** `npm run build` both pass.
- **Commit at the end of each task. Never push.**

---

## Platform facts, measured rather than assumed

Every row was established by reading the shipped code or querying the dev database while writing this plan.

| Fact | Consequence |
|---|---|
| `handleLookup`'s batch path runs items **sequentially**, on purpose — a comment explains that 100 parallel requests would burn the TMDB budget in a burst | A batch's wall-clock is the **sum** of its items, not the max. This is the single most important fact in this plan. |
| The per-item deadline is `LOOKUP_DEADLINE_MS`, default **8000ms** | Worst case per item is ~8s, after which the item returns `partial: true`. |
| `BATCH_CAP` is **100** | 100 cold items is up to ~800s of wall clock. |
| `maxDuration` is declared per route and is **60** on `/api/ui/lookup` and the cron sweep. `vercel.json` contains only `crons` — no function config | **A 100-item batch cannot complete in 60s.** Chunking is not an optimisation here; it is the only way the page can work. |
| A batch returns **HTTP 200 always**, with body `{ results: (LookupEnvelope & { status: number })[] }`, where a per-item `status` is 202 when that item is `partial` | The page reads per-item status, never the response status, to tell finished from still-working. |
| A batch item that is `partial && !cached` is **enqueued** but deliberately **not continued** — the cron picks it up within the minute | A cold corpus run leaves work behind that finishes later. The page must say so rather than report a final resolved rate. |
| `/api/ui/lookup` **refuses** batch bodies, added in Plan 5 because `sessionGate` charges no rate limit | This plan adds a separate bulk route rather than deleting that check. Plan 5's comment asked for exactly that. |
| The TMDB client's token bucket is **in-process**, default 30/s, with a comment explaining why a distributed limiter is not bought yet | Provider pressure is bounded per instance, which is what makes a chunked corpus run acceptable without a session rate limiter. |
| `count(*) OVER ()` returns the unfiltered-by-LIMIT total alongside the page rows | One query for both, verified. |
| `categoryDisagreement` is **not a column** — it lives in `parses.tokens` (JSONB), joined on `(category, normalized_key)` | The filter needs the join. Verified working; the dev database has exactly **1** such row. |
| **`lookups_parse_fk` exists in the applied migration but not in `lib/db/schema.ts` or drizzle's snapshot** — `FOREIGN KEY (category, normalized_key) REFERENCES parses ON DELETE RESTRICT`, hand-added in Plan 1 beside `media_parent_id_fk` | **Every lookup is guaranteed a parse row; there are 0 orphans.** So LEFT and INNER join are equivalent today, fixtures must insert `parses` before `lookups`, and cleanup must delete in the opposite order or `RESTRICT` refuses. Found by Task 3's implementer, which correctly stopped rather than guessing. |
| **24 of 106 lookups have NULL confidence**: 23 `unresolved` and 1 `pending`. Only **2** of those are refused parses | A band filter written as `>= x` or `< x` silently hides **a quarter of the cache**. "No score" must be its own band. See the design note below. |
| Dev data: 67 `resolved` (0.774–1.000), 38 `unresolved` (0.000–0.728 where scored), 1 `pending`; tv 61 / movies 45 | Every filter has real rows to match and real rows to exclude. |
| `components/ui/select.tsx` and `textarea.tsx` were installed in Plan 5 and are still unimported; `select.tsx` is the only importer of `lucide-react` | This plan uses both, closing a follow-up item. |

---

## Two design notes that are the substance of this plan

### The confidence band must have a "none" band, and it is the interesting one

`confidence` is NULL for 24 of 106 rows. A NULL means no candidate was ever scored, and there are three ways to get there: the parse was refused (2 rows), the parse succeeded but no provider match was found (21 rows), or the lookup is still `pending` (1 row).

Written naively, a band filter drops all of them. `confidence >= 0.75` and `confidence < 0.75` between them return 82 rows out of 106, and nothing tells the admin about the missing 24. For a page whose entire purpose is finding rows worth looking at, **the unscored rows are the most interesting ones on it** — they are the failures.

So the band is a closed set with an explicit `none`, and `any` really means any:

| Band | Predicate | Dev rows |
|---|---|---|
| `any` | no predicate | 106 |
| `high` | `confidence >= 0.9` | measure it |
| `medium` | `confidence >= 0.75 AND confidence < 0.9` | measure it |
| `low` | `confidence IS NOT NULL AND confidence < 0.75` | 15 |
| `none` | `confidence IS NULL` | 24 |

`low` must say `IS NOT NULL` explicitly. Without it, `confidence < 0.75` is NULL for an unscored row, which SQL treats as not-true — so it would happen to work, and then someone would write `NOT (confidence >= 0.75)` somewhere else and get a different answer. Being explicit costs nothing and removes the question.

### A cold corpus run cannot finish inside one request, and the page must be honest about it

Items run sequentially at up to 8s each, and the function budget is 60s. So a chunk holds **5 items**: 40s of worst case, leaving room for the round trip. That is not a tuning choice to revisit — it falls out of the two numbers.

More importantly, an item that blows its deadline comes back `partial: true` with its parse intact and a job enqueued for the cron. It is **not** a failure and it is **not** a result yet. So:

- The aggregate resolved rate on a cold run is a **lower bound**, and the page says so while any item is still pending.
- Re-running the same corpus after the sweeper has caught up is how you get the real number — and the second run is fast, because every item is then a cache hit.
- The page reports `pending` as its own count, never folded into failures.

Getting this wrong would produce a measurement tool that quietly under-reports the parser's own resolve rate, which is the one number the page exists to show.

---

## Spec coverage

**Delivered here:** `/corpus` — paste or upload newline-delimited names for one category, run them as a batch, per-row results plus aggregate parsed %, resolved % and mean confidence (line 585). `/admin/cache` — paginated browser filterable by category, state, confidence band and `categoryDisagreement` (line 589). Success criterion 7 — a non-admin receives 403 from `/admin/cache`, and an admin can filter by confidence band and by `categoryDisagreement` (line 701).

**One divergence, stated rather than discovered.** The spec says `/admin` is guarded "by `requireAdmin()` in **both** the segment layout and each route handler". `/admin/cache` reads its data in the server component itself rather than through a route handler, so there is no handler to guard — the page guards itself, which is the same enforcement the spec is asking for. Plan 4 established this reading: a layout check controls navigation, not authorization, so the thing that serves data checks for itself. Here the page *is* the thing that serves data.

**Not delivered, and out of the spec's scope for this plan:** a session rate limiter (the chunk cap and the in-process token bucket bound provider pressure; a determined signed-in user can still loop, which is recorded as follow-up), and the `books`/`xxx` category slices, which the spec assigns to their own later specs.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/corpus/chunk.ts` | `CORPUS_CHUNK` — shared by the route and the browser, and dependency-free so the client can import it |
| `app/api/ui/corpus/route.ts` | session-gated batch lookup, capped at 5 items |
| `app/api/ui/lookup/route.ts` | **modified** — its refusal message points at the bulk route |
| `app/corpus/page.tsx` | the corpus runner's server half |
| `components/corpus-runner.tsx` | paste/upload, chunked submission, progress, per-row results, aggregates |
| `lib/corpus/aggregate.ts` | `summarise(rows)` — parsed %, resolved %, mean confidence, pending count |
| `lib/cache/browse.ts` | `browseCache(tx, filters)` — one query returning a page and its total |
| `app/(admin)/admin/cache/page.tsx` | the cache browser, guarded, reading filters from the URL |
| `components/cache-filters.tsx` | the filter form |
| `components/app-shell.tsx` | **modified** — a Corpus link |
| `app/(admin)/admin/page.tsx` | **modified** — links to the cache browser it has been promising |
| `test/corpus/aggregate.test.ts`, `test/cache/browse.test.ts`, `test/http/corpusRoute.test.ts`, `test/ui/corpusRunner.test.ts`, `test/ui/cachePage.test.ts` | the tests |

---

### Task 1: The corpus batch route

**Files:**
- Create: `lib/corpus/chunk.ts`, `app/api/ui/corpus/route.ts`
- Modify: `app/api/ui/lookup/route.ts` (message only)
- Test: `test/http/corpusRoute.test.ts`

**Interfaces:**
- Consumes: `handleLookup` (`lib/http/lookupHandler.ts`), `sessionGate` (`lib/http/gate.ts`), `buildTmdbDeps` (`lib/http/envelope.ts`), `badRequest` (`lib/http/problem.ts`).
- Produces:
  - `CORPUS_CHUNK = 5` from **`lib/corpus/chunk.ts`** — a module of its own, not the route. Task 2's browser component needs this number, and it is a *value*, so it cannot be imported as a type. Importing it from the route would pull `handleLookup`, Drizzle and the TMDB client into the client bundle — and would still build. A dependency-free module is the only safe home for it.
  - `POST /api/ui/corpus` — session-gated, batch only, at most `CORPUS_CHUNK` items

**Caught by the pre-flight scan, before any code was written.** An earlier draft of this plan had the route export `CORPUS_CHUNK` and the browser component import it from there. That is the same class of defect as a value import of `LookupEnvelope`, which Plan 5 guards against with a test: it works, it builds, and it silently ships server code to the browser.

**Why a separate route rather than lifting `/api/ui/lookup`'s refusal.** Plan 5 refused batches there and its comment asked that a later bulk page "lift this deliberately, with a limit attached, rather than by deleting the check". A separate route is how that is done without weakening the single-item route: this one has its own cap, its own `maxDuration`, and a name that says what it is. `/api/ui/lookup` stays single-item, and its refusal message is updated to name this route so the error is actionable rather than a dead end.

**Why the cap is 5 and not a rounder number.** Items run sequentially at up to 8s each and `maxDuration` is 60. 5 × 8 = 40s, leaving 20s for the round trip and any slow start. 10 would be 80s and would time out on a cold chunk — the request would die mid-batch, and the items already processed would have been written but never reported. **The cap is arithmetic, not taste.**

- [ ] **Step 1: Write the failing test**

`test/http/corpusRoute.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { ensureUser } from '../../lib/auth/users';
import { mintApiKey } from '../../lib/auth/apiKey';
import { POST as corpus } from '../../app/api/ui/corpus/route';
import { CORPUS_CHUNK } from '../../lib/corpus/chunk';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/** A name already resolved in the dev cache, so no test here calls TMDB. */
async function cachedName(): Promise<string> {
  const result = await getDb().execute(sql`
    SELECT name FROM lookups WHERE state = 'resolved' AND category = 'movies' LIMIT 1`);
  const row = result.rows[0];
  assert.ok(row !== undefined, 'the dev cache has no resolved movies row to reuse');
  return String(row.name);
}

function body(headers: Headers, names: readonly string[]): Request {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return new Request('http://localhost:3000/api/ui/corpus', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ items: names.map((name) => ({ category: 'movies', name })) }),
  });
}

test('the chunk size is small enough to fit the function budget', () => {
  // Arithmetic, not taste: items run sequentially at up to LOOKUP_DEADLINE_MS
  // (8s) each, and maxDuration is 60. This assertion is here so that raising
  // the cap without raising the budget fails loudly rather than timing out in
  // production on a cold chunk.
  assert.ok(CORPUS_CHUNK * 8 < 60, `${CORPUS_CHUNK} items of 8s does not fit in 60s`);
});

test('an anonymous request is refused', opts, async () => {
  const response = await corpus(body(new Headers(), ['Whatever.2010.mkv']));
  assert.equal(response.status, 401);
});

test('an api key is refused: this route is for people', opts, async () => {
  // A real minted key, not a made-up string -- an unminted token is refused by
  // either gate, so a fake one could not tell a wrongly wired route from a
  // correct one. This project has been bitten by exactly that.
  const email = 'corpus-key@example.test';
  try {
    const userId = await withTransaction(async (tx) => (await ensureUser(tx, email)).id);
    const minted = await mintApiKey();
    await withTransaction((tx) => tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES (${userId}, 'corpus route test', ${minted.tokenHash}, ${minted.prefix})`));
    const headers = new Headers({ authorization: `Bearer ${minted.token}` });
    assert.equal((await corpus(body(headers, ['Whatever.2010.mkv']))).status, 401);
  } finally {
    await deleteUser(email);
  }
});

test('a signed-in user gets one result per item', opts, async () => {
  const email = 'corpus-ok@example.test';
  try {
    const name = await cachedName();
    const response = await corpus(body(await signIn(email), [name, name]));
    assert.equal(response.status, 200, 'a batch response is always 200');
    const payload = await response.json() as {
      results: readonly { status: number; state: string; cached: boolean }[];
    };
    assert.equal(payload.results.length, 2);
    // Cached, therefore no provider call: this is what keeps the test offline.
    assert.equal(payload.results[0]?.cached, true);
    assert.equal(payload.results[0]?.status, 200);
  } finally {
    await deleteUser(email);
  }
});

test('a chunk over the cap is refused, and the message says the cap', opts, async () => {
  const email = 'corpus-cap@example.test';
  try {
    const names = Array.from({ length: CORPUS_CHUNK + 1 }, (_, i) => `Over.Cap.${i}.2010.mkv`);
    const response = await corpus(body(await signIn(email), names));
    assert.equal(response.status, 400);
    const problem = await response.json() as { detail?: string };
    // A cap without a number is a message the caller cannot act on.
    assert.ok(
      (problem.detail ?? '').includes(String(CORPUS_CHUNK)),
      `the detail should name the cap: ${problem.detail}`,
    );
  } finally {
    await deleteUser(email);
  }
});

test('a single-item body is refused: this route is the batch surface', opts, async () => {
  // The mirror of /api/ui/lookup refusing batches. Each route does one thing,
  // so a caller cannot half-use either.
  const email = 'corpus-single@example.test';
  try {
    const headers = new Headers(await signIn(email));
    headers.set('content-type', 'application/json');
    const response = await corpus(new Request('http://localhost:3000/api/ui/corpus', {
      method: 'POST',
      headers,
      body: JSON.stringify({ category: 'movies', name: 'Whatever.2010.mkv' }),
    }));
    assert.equal(response.status, 400);
  } finally {
    await deleteUser(email);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/http/corpusRoute.test.ts
```

Expected: FAIL — cannot resolve `../../app/api/ui/corpus/route`.

- [ ] **Step 3: Write the shared constant**

`lib/corpus/chunk.ts`. Its own module, with no imports at all, because Task 2's client component needs this value and anything it imports reaches the browser:

```ts
/**
 * How many names one corpus request may carry.
 *
 * Arithmetic rather than taste. `handleLookup` runs batch items sequentially --
 * deliberately, so a burst does not exhaust the TMDB budget -- and each item
 * has up to `LOOKUP_DEADLINE_MS` (8s) before it gives up and returns partial.
 * With `maxDuration` at 60, five items is 40s of worst case and leaves room for
 * the round trip. Ten would be 80s: the request would die mid-batch, and the
 * items it had already written would never be reported to the caller.
 *
 * This lives here rather than in the route because the browser must chunk to
 * the same number the route enforces, and `CORPUS_CHUNK` is a value -- so a
 * client component importing it from the route would drag `handleLookup`,
 * Drizzle and the TMDB client into the bundle. This module imports nothing, on
 * purpose. Keep it that way.
 */
export const CORPUS_CHUNK = 5;
```

- [ ] **Step 4: Write the route**

`app/api/ui/corpus/route.ts`:

```ts
import { handleLookup } from '../../../../lib/http/lookupHandler';
import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { sessionGate } from '../../../../lib/http/gate';
import { badRequest } from '../../../../lib/http/problem';
import { CORPUS_CHUNK } from '../../../../lib/corpus/chunk';

export const maxDuration = 60;

/**
 * The bulk lookup the corpus page calls.
 *
 * A separate route from `/api/ui/lookup` rather than a relaxation of it.
 * `sessionGate` charges no rate limit, so Plan 5 refused batch bodies on the
 * single-item route and asked that a bulk page "lift this deliberately, with a
 * limit attached, rather than by deleting the check". This is that: its own
 * cap, its own budget, and a name that says what it is.
 *
 * Batch only. A single-item body belongs on `/api/ui/lookup`, and a route that
 * accepted either would let a caller half-use both.
 */
export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.clone().json().catch(() => null);
  // `unknown` is the deserialization exception: `raw` is inspected for the
  // shape of its `items` key and never read as a typed value. The full
  // validation is `handleLookup`'s.
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) {
    return badRequest('this route takes a batch; a single lookup goes to /api/ui/lookup');
  }
  const items = (raw as { readonly items: unknown }).items;
  if (Array.isArray(items) && items.length > CORPUS_CHUNK) {
    return badRequest(`a corpus chunk holds at most ${CORPUS_CHUNK} names`);
  }
  return handleLookup(request, buildTmdbDeps, { gate: sessionGate });
}
```

**On reading the body twice.** `request.clone()` gives this route the body while leaving the original readable for `handleLookup`. Plan 5 used the same pattern on `/api/ui/lookup` and a review verified it does not hand the handler an empty body — but verify it again here, because the failure mode is silent: a single valid chunk must still return results, not an empty list.

- [ ] **Step 5: Point the single-item route at this one**

In `app/api/ui/lookup/route.ts`, change the refusal message so it names the alternative:

```ts
    return badRequest('batched lookups go to /api/ui/corpus');
```

Keep the docstring's reasoning and update its last sentence to say the bulk route exists rather than that a later plan should add one. **Change nothing else in that file.** If an existing test asserts the old message, update the test — but check first whether it asserts only the status, in which case leave it alone.

- [ ] **Step 6: Run the tests**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/http/corpusRoute.test.ts test/http/uiLookup.test.ts
```

Expected: 6 passing in the new file, and every existing `uiLookup` test still passing.

- [ ] **Step 7: Confirm the clone did not break the happy path**

The silent failure here is a route that validates correctly and then hands `handleLookup` a consumed body, producing an empty result list. The test above asserts `results.length === 2`, which covers it — but run it once more on its own and paste the assertion's outcome into your report, because "it passed as part of a suite" and "I watched this specific thing work" are different claims.

- [ ] **Step 8: Commit**

```bash
npm run check && npm run build
git add app/api/ui/corpus/route.ts app/api/ui/lookup/route.ts test/http/corpusRoute.test.ts
git commit -m "Add the session-gated corpus batch route

A separate route rather than a relaxation of /api/ui/lookup, which
refuses batches because sessionGate charges no rate limit. Plan 5 asked
that a bulk page lift that deliberately with a limit attached rather
than by deleting the check; this has its own cap, its own budget, and a
name that says what it is. The single-item route's refusal now names
this one, so the error is actionable instead of a dead end.

The cap of five is arithmetic, not taste. handleLookup runs batch items
sequentially so a burst cannot exhaust the TMDB budget, each item has up
to 8s before it returns partial, and maxDuration is 60: five items is
40s of worst case. Ten would be 80s, and the request would die
mid-batch with the items it had already written never reported. A test
asserts the arithmetic so raising the cap without raising the budget
fails loudly rather than in production.

Batch only, mirroring the single-item route, so a caller cannot
half-use either."
```

---
### Task 2: The corpus runner

**Files:**
- Create: `lib/corpus/aggregate.ts`, `app/corpus/page.tsx`, `components/corpus-runner.tsx`
- Modify: `components/app-shell.tsx` (a Corpus link)
- Test: `test/corpus/aggregate.test.ts`, `test/ui/corpusRunner.test.ts`

**Interfaces:**
- Consumes: `CORPUS_CHUNK` from **`lib/corpus/chunk.ts`** (Task 1 — *not* from the route; see below) and `POST /api/ui/corpus` (Task 1), `getCurrentUser` (`lib/auth/session.ts`), `CATEGORIES`/`Category` (`lib/parse/types.ts`), the `components/ui/*` primitives.
- Produces:
  - `interface CorpusRow { readonly name: string; readonly state: 'resolved' | 'unresolved' | 'pending'; readonly status: number; readonly cached: boolean; readonly confidence: number | null; readonly refusal: string | null }`
  - `interface CorpusSummary { readonly total: number; readonly parsed: number; readonly resolved: number; readonly pending: number; readonly refused: number; readonly cachedCount: number; readonly meanConfidence: number | null; readonly parsedRate: number; readonly resolvedRate: number; readonly complete: boolean }`
  - `summarise(rows: readonly CorpusRow[]): CorpusSummary`
  - `MAX_NAMES = 500`
  - `CorpusRunner` — a client component taking no props

**Why the arithmetic lives in its own module.** The page's whole purpose is three numbers, and there is no React renderer here to test a component's output. A pure `summarise` is testable exhaustively — including the cases that produce wrong numbers rather than crashes, which is the failure mode that matters for a measurement tool. Divide-by-zero on an empty run, a mean over an empty set, and a pending item counted as a failure all produce a plausible-looking number that is wrong.

**Why `pending` is its own count and never folded into failures.** An item that blew its 8-second deadline returns `partial: true` with its parse intact and a job enqueued for the cron. It is not a failure and not yet a result. Folding it into "unresolved" would make the page under-report the parser's own resolve rate — the single number it exists to show. So `complete` is false while any item is pending, and the page says the resolved rate is a lower bound until a re-run.

**Where `CORPUS_CHUNK` comes from, and why it matters.** Import it from `lib/corpus/chunk.ts`, **never from `app/api/ui/corpus/route.ts`.** It is a value, so it cannot be a type-only import, and a route module imports `handleLookup` — which reaches Drizzle and the TMDB client. A client component importing the route would ship all of that to the browser **and the build would still pass.** The pre-flight scan caught this in an earlier draft of this plan; a test below asserts the import's source and the absence of the route import.

**Why there is a cap on names.** The committed corpus fixtures total 5,951 lines. At 5 per chunk that is 1,190 requests, and a cold run of that is hours. `MAX_NAMES = 500` — 100 chunks — is enough to measure a parser against a real sample and short enough that a person will wait for it. A larger sweep belongs in `scripts/corpus-report.ts`, which already exists and runs offline.

- [ ] **Step 1: Write the failing aggregate test**

`test/corpus/aggregate.test.ts` — pure, no database, runs everywhere:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, MAX_NAMES, type CorpusRow } from '../../lib/corpus/aggregate';

function row(over: Partial<CorpusRow>): CorpusRow {
  return {
    name: 'x', state: 'resolved', status: 200, cached: false,
    confidence: 1, refusal: null, ...over,
  };
}

test('an empty run reports zeroes, not NaN', () => {
  // The failure mode for a measurement tool is a plausible wrong number, and
  // 0/0 is the classic one.
  const s = summarise([]);
  assert.equal(s.total, 0);
  assert.equal(s.parsedRate, 0);
  assert.equal(s.resolvedRate, 0);
  assert.equal(s.meanConfidence, null);
  assert.equal(s.complete, true, 'a run with nothing pending is complete');
});

test('rates are fractions of the total', () => {
  const s = summarise([
    row({ state: 'resolved', confidence: 1 }),
    row({ state: 'unresolved', confidence: 0.5 }),
    row({ state: 'unresolved', confidence: null, refusal: 'no title found' }),
    row({ state: 'resolved', confidence: 0.8 }),
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.resolved, 2);
  assert.equal(s.resolvedRate, 0.5);
  // Three of four parsed: the refused one did not.
  assert.equal(s.refused, 1);
  assert.equal(s.parsed, 3);
  assert.equal(s.parsedRate, 0.75);
});

test('the mean covers only scored rows', () => {
  // Treating a null as zero would drag the mean down and make an unscored
  // lookup look like a bad match rather than no match.
  const s = summarise([
    row({ confidence: 1 }),
    row({ confidence: 0.5 }),
    row({ confidence: null, state: 'unresolved' }),
  ]);
  assert.equal(s.meanConfidence, 0.75);
});

test('the mean is null when nothing was scored', () => {
  const s = summarise([row({ confidence: null, state: 'unresolved' })]);
  assert.equal(s.meanConfidence, null);
});

test('a pending item is counted as pending, never as a failure', () => {
  // An item that blew its deadline has its parse and an enqueued job. Folding
  // it into unresolved would under-report the resolve rate, which is the one
  // number this page exists to show.
  const s = summarise([
    row({ state: 'resolved' }),
    row({ state: 'pending', status: 202, confidence: null }),
  ]);
  assert.equal(s.pending, 1);
  assert.equal(s.resolved, 1);
  assert.equal(s.complete, false, 'a pending item means the run is not complete');
  // It parsed -- there is no refusal -- so it counts as parsed.
  assert.equal(s.parsed, 2);
  assert.equal(s.parsedRate, 1);
});

test('a 202 status marks a run incomplete even if state says otherwise', () => {
  // Belt and braces: the per-item status is the field the handler sets from
  // `partial`, so trust it as well as `state`.
  const s = summarise([row({ state: 'unresolved', status: 202 })]);
  assert.equal(s.pending, 1);
  assert.equal(s.complete, false);
});

test('cached items are counted, because a fast run is a cached run', () => {
  const s = summarise([row({ cached: true }), row({ cached: false })]);
  assert.equal(s.cachedCount, 1);
});

test('rates are exact for a third, not rounded into a wrong number', () => {
  const s = summarise([row({}), row({ state: 'unresolved' }), row({ state: 'unresolved' })]);
  // Rounding belongs in the view, not the arithmetic.
  assert.ok(Math.abs(s.resolvedRate - 1 / 3) < 1e-12);
});

test('the name cap is small enough that a person will wait for the run', () => {
  // 5951 corpus lines at 5 per chunk is 1190 requests; this keeps a run to 100.
  assert.ok(MAX_NAMES <= 500);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/corpus/aggregate.test.ts
```

Expected: FAIL — cannot resolve `../../lib/corpus/aggregate`.

- [ ] **Step 3: Write the aggregate module**

`lib/corpus/aggregate.ts`:

```ts
/**
 * The three numbers the corpus page exists to show, and the counts behind them.
 *
 * Its own module because there is no React renderer in this project, so
 * arithmetic inside a component would be untested — and the failure mode here
 * is not a crash but a plausible wrong number. A measurement tool that
 * under-reports is worse than one that breaks.
 */

export interface CorpusRow {
  readonly name: string;
  readonly state: 'resolved' | 'unresolved' | 'pending';
  readonly status: number;
  readonly cached: boolean;
  readonly confidence: number | null;
  readonly refusal: string | null;
}

export interface CorpusSummary {
  readonly total: number;
  readonly parsed: number;
  readonly resolved: number;
  readonly pending: number;
  readonly refused: number;
  readonly cachedCount: number;
  readonly meanConfidence: number | null;
  readonly parsedRate: number;
  readonly resolvedRate: number;
  /** False while any item is still resolving, which makes `resolvedRate` a floor. */
  readonly complete: boolean;
}

/**
 * How many names one run accepts.
 *
 * The committed fixtures total 5,951 lines; at `CORPUS_CHUNK` of 5 that is
 * 1,190 requests, and a cold run of that takes hours. 500 is 100 chunks --
 * enough to measure against a real sample, short enough that someone waits for
 * it. A full sweep belongs in `scripts/corpus-report.ts`, which runs offline.
 */
export const MAX_NAMES = 500;

export function summarise(rows: readonly CorpusRow[]): CorpusSummary {
  const total = rows.length;
  let parsed = 0;
  let resolved = 0;
  let pending = 0;
  let refused = 0;
  let cachedCount = 0;
  let scored = 0;
  let confidenceSum = 0;

  for (const row of rows) {
    if (row.refusal === null) parsed += 1; else refused += 1;
    if (row.state === 'resolved') resolved += 1;
    // Both signals, on purpose: `status` is what the handler sets from
    // `partial`, and `state` is what the pipeline stored. Either one meaning
    // "still working" makes the run incomplete.
    if (row.state === 'pending' || row.status === 202) pending += 1;
    if (row.cached) cachedCount += 1;
    if (row.confidence !== null) {
      scored += 1;
      confidenceSum += row.confidence;
    }
  }

  // Guarded rather than relying on the caller never passing an empty array:
  // 0/0 is NaN, and NaN formats as "NaN%" on a page whose job is numbers.
  const rate = (count: number): number => (total === 0 ? 0 : count / total);

  return {
    total,
    parsed,
    resolved,
    pending,
    refused,
    cachedCount,
    // Only scored rows. Treating a null as zero would make "no match found"
    // indistinguishable from "a bad match", which is the distinction the
    // parser is being measured on.
    meanConfidence: scored === 0 ? null : confidenceSum / scored,
    parsedRate: rate(parsed),
    resolvedRate: rate(resolved),
    complete: pending === 0,
  };
}
```

- [ ] **Step 4: Run the aggregate tests**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/corpus/aggregate.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Write the failing runner test**

`test/ui/corpusRunner.test.ts`. Source-level, following this project's convention where no renderer exists — **with an emptiness guard on every filter**, because a loop whose assertion sits inside it passes vacuously when nothing matches, and that shape has been corrected on this project more than once:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CorpusRunner } from '../../components/corpus-runner';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

const importLines = (text: string, path: string): readonly string[] =>
  text.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes(path));

test('the runner is a client component', async () => {
  assert.equal(typeof CorpusRunner, 'function');
  assert.ok((await source('components/corpus-runner.tsx')).startsWith("'use client'"));
});

test('the runner chunks to the number the route enforces', async () => {
  // A page that chunked to a different number than the route accepts would
  // 400 on every request, or silently send less than it could.
  const text = await source('components/corpus-runner.tsx');
  const lines = importLines(text, 'lib/corpus/chunk');
  assert.ok(lines.length > 0, 'expected CORPUS_CHUNK to come from lib/corpus/chunk');
  assert.ok(text.includes('CORPUS_CHUNK'), 'expected the imported constant to be used');
  // Not re-declared locally, which is how the two drift apart.
  assert.equal(/const\s+CORPUS_CHUNK\s*=/.test(text), false, 'must not redeclare the chunk size');
});

test('the runner does not import the route module', async () => {
  // CORPUS_CHUNK is a value, so it cannot be imported as a type. Taking it
  // from the route would pull handleLookup -- and therefore Drizzle and the
  // TMDB client -- into the browser bundle, and the build would still pass.
  // This is the assertion that stops that, since nothing else would notice.
  const text = await source('components/corpus-runner.tsx');
  const offending = text.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes('api/ui/corpus/route'));
  assert.deepEqual(offending, [], 'a client component must not import a route module');
});

test('the runner imports the shared category list rather than restating it', async () => {
  const text = await source('components/corpus-runner.tsx');
  const lines = importLines(text, 'lib/parse/types');
  assert.ok(lines.length > 0, 'expected CATEGORIES to be imported');
  assert.equal(/const\s+CATEGORIES\s*=\s*\[/.test(text), false, 'must not restate the categories');
});

test('the runner uses the tested aggregate rather than inlining arithmetic', async () => {
  // The three numbers are the point of the page; untested arithmetic in a
  // component is exactly what lib/corpus/aggregate.ts exists to avoid.
  const text = await source('components/corpus-runner.tsx');
  const lines = importLines(text, 'lib/corpus/aggregate');
  assert.ok(lines.length > 0, 'expected summarise to be imported');
  assert.ok(text.includes('summarise('), 'expected summarise to be called');
});

test('the page is a server component that guards itself', async () => {
  const text = await source('app/corpus/page.tsx');
  assert.equal(text.includes("'use client'"), false, 'the page must stay a server component');
  assert.ok(text.includes('getCurrentUser'), 'the page must read the session');
  assert.ok(text.includes("redirect('/sign-in')"), 'and redirect when there is none');
});
```

- [ ] **Step 6: Run it and confirm it fails**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/ui/corpusRunner.test.ts
```

Expected: FAIL — cannot resolve `../../components/corpus-runner`.

- [ ] **Step 7: Write the runner**

`components/corpus-runner.tsx`. The chunking loop is the substance; keep the markup plain.

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CATEGORIES, type Category } from '../lib/parse/types';
import { CORPUS_CHUNK } from '../lib/corpus/chunk';
import { summarise, MAX_NAMES, type CorpusRow } from '../lib/corpus/aggregate';

interface Envelope {
  readonly state: 'resolved' | 'unresolved' | 'pending';
  readonly status: number;
  readonly cached: boolean;
  readonly confidence: number | null;
  readonly refusal: string | null;
}

function split(text: string): readonly string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function CorpusRunner() {
  const [category, setCategory] = useState<Category>('movies');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<readonly CorpusRow[]>([]);
  const [done, setDone] = useState(0);
  const [target, setTarget] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const names = split(text);
    if (names.length === 0) {
      setError('Paste some names, or upload a file.');
      return;
    }
    if (names.length > MAX_NAMES) {
      setError(`That is ${names.length} names; this page runs at most ${MAX_NAMES} at a time.`);
      return;
    }

    setError(null);
    setRunning(true);
    setRows([]);
    setDone(0);
    setTarget(names.length);

    const collected: CorpusRow[] = [];
    try {
      // Chunked because handleLookup runs items sequentially at up to 8s each
      // and a function has 60s. Sent one chunk at a time rather than in
      // parallel, for the same reason the handler is sequential: a burst would
      // exhaust the provider budget that the pacing exists to protect.
      for (let start = 0; start < names.length; start += CORPUS_CHUNK) {
        const chunk = names.slice(start, start + CORPUS_CHUNK);
        const response = await fetch('/api/ui/corpus', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: chunk.map((name) => ({ category, name })) }),
        });
        if (response.status === 401) {
          setError('You are not signed in. Sign in and try again.');
          return;
        }
        if (!response.ok) {
          const problem = await response.json().catch(() => null) as { detail?: string } | null;
          setError(problem?.detail ?? `The run stopped at name ${start + 1} (${response.status}).`);
          return;
        }
        const payload = await response.json() as { results: readonly Envelope[] };
        chunk.forEach((name, index) => {
          const result = payload.results[index];
          if (result === undefined) return;
          collected.push({
            name,
            state: result.state,
            status: result.status,
            cached: result.cached,
            confidence: result.confidence,
            refusal: result.refusal,
          });
        });
        // Committed after every chunk so a long run shows its work, and a
        // failure part-way still reports what it measured.
        setRows([...collected]);
        setDone(collected.length);
      }
    } catch {
      setError('The run could not be completed. The results below are partial.');
    } finally {
      setRunning(false);
    }
  }

  const summary = summarise(rows);

  return (
    <div className="space-y-6">
      <form onSubmit={run} className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="file">Or upload a file</Label>
            <input
              id="file"
              type="file"
              accept=".txt,text/plain"
              className="block text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                void file.text().then((contents) => { setText(contents); });
              }}
            />
          </div>
          <Button type="submit" disabled={running}>
            {running ? `Running ${done}/${target}…` : 'Run'}
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="names">Names, one per line</Label>
          <Textarea
            id="names"
            rows={8}
            placeholder={'Interstellar.2014.1080p.BluRay.x264-GROUP.mkv\nGhosts (2019) - S05E01 - Fools WEBRip-1080p.mkv'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </form>

      {error === null ? null : <p role="alert" className="text-sm text-red-600">{error}</p>}

      {summary.total === 0 ? null : (
        <Card>
          <CardHeader><CardTitle className="text-base">Summary</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{summary.total} names</Badge>
              <Badge variant="outline">parsed {percent(summary.parsedRate)}</Badge>
              <Badge variant="outline">resolved {percent(summary.resolvedRate)}</Badge>
              <Badge variant="outline">
                mean confidence {summary.meanConfidence === null ? '—' : summary.meanConfidence.toFixed(3)}
              </Badge>
              <Badge variant="outline">{summary.cachedCount} cached</Badge>
              {summary.refused === 0 ? null : <Badge variant="outline">{summary.refused} refused</Badge>}
            </div>
            {summary.complete ? null : (
              <p className="text-muted-foreground">
                {summary.pending} {summary.pending === 1 ? 'name is' : 'names are'} still resolving —
                each blew its deadline and was queued for the background sweeper. The resolved rate
                above is a floor; run the same list again in a minute or two for the real number,
                and it will be fast because everything will be cached.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {summary.total === 0 ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.name}>
                <TableCell className="font-mono text-xs break-all">{row.name}</TableCell>
                <TableCell>
                  {row.status === 202 ? 'still working' : row.state}
                  {row.refusal === null ? null : (
                    <span className="text-muted-foreground"> — {row.refusal}</span>
                  )}
                </TableCell>
                <TableCell>{row.confidence === null ? '—' : row.confidence.toFixed(3)}</TableCell>
                <TableCell>{row.cached ? 'cached' : 'fetched'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

**Key the result rows on position, not name alone.** The committed fixtures contain duplicated lines — 41 in `movies.releases.raw.txt`, 5 in `tv.releases.raw.txt` — so pasting this project's own corpus produces duplicate React keys. That is not merely a warning: React reconciles by key, so two rows sharing one can swap or drop content as the list grows, which on a measurement page means showing a result against the wrong name. Use `` key={`${index}-${row.name}`} ``. **Do not deduplicate the input** — a corpus with repeats is legitimate to measure, and collapsing it would change the denominator of every number on the page.

- [ ] **Step 8: Write the page**

`app/corpus/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/session';
import { CorpusRunner } from '../../components/corpus-runner';

// Guards itself rather than trusting the shell: a layout does not re-run on
// client-side navigation. `redirect()` throws control flow, so it stays outside
// any try -- and so does `headers()`, which is how a route gets marked dynamic.
export default async function CorpusPage() {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Corpus runner</h1>
        <p className="text-sm text-muted-foreground">
          Paste or upload newline-delimited names for one category and run them as a batch. Names
          already in the cache answer instantly; cold ones may be queued for the background sweeper.
        </p>
      </div>
      <CorpusRunner />
    </div>
  );
}
```

- [ ] **Step 9: Add the Corpus link to the shell**

In `components/app-shell.tsx`, beside the existing links:

```tsx
            <Link href="/corpus" className="text-muted-foreground hover:text-foreground">Corpus</Link>
```

`typedRoutes: true` means this only typechecks once `app/corpus/page.tsx` exists — it does now, in this task. If `tsc` rejects it, run `npx next typegen` and clear `tsconfig.tsbuildinfo`; a stale incremental cache has produced a phantom `TS2322` about a new route twice on this project. **Do not cast or widen to make it pass.**

- [ ] **Step 10: Run everything, then exercise it**

```bash
npm run check
npm run build
```

Expected: 15 new tests (9 in the aggregate file, 6 in the runner file), the suite green with 0 skipped, and `/corpus` listed as `ƒ` (Dynamic).

Then drive a real run without a browser: obtain a session cookie the way `test/helpers/signIn.ts` does, and `curl` `POST /api/ui/corpus` with a chunk of **names already in the dev cache** (query `lookups` for `state = 'resolved'`). Confirm you get one result per name with `cached: true` — which is also what proves the run made no provider call. Report the status and the result count. Keep the cookie in a variable or scratch file; **never in a command argument.**

- [ ] **Step 11: Commit**

```bash
git add lib/corpus/aggregate.ts app/corpus/page.tsx components/corpus-runner.tsx \
        components/app-shell.tsx test/corpus/aggregate.test.ts test/ui/corpusRunner.test.ts
git commit -m "Add the corpus runner

The arithmetic lives in lib/corpus/aggregate.ts rather than in the
component, because there is no React renderer here and the failure mode
for a measurement tool is a plausible wrong number rather than a crash:
0/0 formatting as NaN%, a mean over an empty set, a null confidence
averaged as zero, or a pending item counted as a failure. Each has a
test.

A pending item is counted as pending and never as a failure. An item
that blew its 8s deadline has its parse and an enqueued job, so folding
it into unresolved would under-report the resolve rate -- the one number
this page exists to show. The summary says the rate is a floor while
anything is pending, and points out that a re-run will be fast because
everything will then be cached.

The browser chunks to CORPUS_CHUNK imported from the route rather than a
local copy, and a test asserts it is not redeclared: a page chunking to
a different number than the route enforces would 400 on every request.
Names are capped at 500 -- the committed fixtures are 5,951 lines, which
is 1,190 requests and hours cold; a full sweep belongs in the offline
script that already exists."
```

---
### Task 3: The cache query

**Files:**
- Create: `lib/cache/browse.ts`
- Test: `test/cache/browse.test.ts`

**Interfaces:**
- Consumes: `Tx` (`lib/db/client.ts`), `Category`/`CATEGORIES` (`lib/parse/types.ts`).
- Produces:
  - `type ConfidenceBand = 'any' | 'high' | 'medium' | 'low' | 'none'` and `CONFIDENCE_BANDS`
  - `type LookupState = 'resolved' | 'unresolved' | 'pending'` and `LOOKUP_STATES`
  - `interface CacheFilters { readonly category: Category | null; readonly state: LookupState | null; readonly band: ConfidenceBand; readonly disagreementOnly: boolean; readonly page: number; readonly perPage: number }`
  - `interface CacheRow { readonly id: string; readonly category: string; readonly name: string; readonly state: string; readonly confidence: number | null; readonly hitCount: number; readonly pinned: boolean; readonly disagreement: boolean; readonly createdAt: string; readonly lastAttemptAt: string | null }`
  - `interface CachePage { readonly rows: readonly CacheRow[]; readonly total: number; readonly page: number; readonly perPage: number; readonly pageCount: number }`
  - `PER_PAGE = 25`
  - `parseFilters(params: URLSearchParams): CacheFilters` — pure, total, never throws
  - `browseCache(tx: Tx, filters: CacheFilters): Promise<CachePage>`

**The band set is closed, and `none` is the point.** 24 of 106 dev rows have NULL confidence — 23 `unresolved` and 1 `pending`, of which only 2 are refused parses. So most unscored rows parsed fine and found no match. Those are the failures an admin is looking for, and a band filter written as `>= x` / `< x` hides all 24 without saying so. `low` says `IS NOT NULL` explicitly: SQL would treat `confidence < 0.75` as not-true for a NULL anyway, so it happens to work — and then the next person writes `NOT (confidence >= 0.75)` somewhere and gets a different answer. Explicit costs nothing.

**`parseFilters` must be total.** It reads a URL, which is user input: `?page=-3&band=banana&state=asleep` must produce valid filters, not an exception and not a SQL error. Every unrecognised value falls back, `page` clamps to at least 1, and `perPage` is not user-controlled at all.

**Pagination needs a stable sort.** `ORDER BY created_at DESC` alone is not a total order — rows sharing a timestamp can swap between pages, so a row is seen twice and another never. The tiebreak is `id`.

- [ ] **Step 1: Write the failing test**

`test/cache/browse.test.ts`. The `parseFilters` half is pure and runs everywhere. The query half uses the **`books` category as a fixture namespace** — the dev database has 61 `tv` and 45 `movies` rows and **zero** `books`, so fixtures are isolated without a name filter existing in production code:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import {
  parseFilters, browseCache, PER_PAGE, CONFIDENCE_BANDS,
  type CacheFilters,
} from '../../lib/cache/browse';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const base: CacheFilters = {
  category: null, state: null, band: 'any', disagreementOnly: false, page: 1, perPage: PER_PAGE,
};

// --- parseFilters: pure, no database ---------------------------------------

test('parseFilters defaults an empty query', () => {
  const f = parseFilters(new URLSearchParams());
  assert.deepEqual(f, base);
});

test('parseFilters reads every filter the spec names', () => {
  const f = parseFilters(new URLSearchParams(
    'category=tv&state=unresolved&band=none&disagreement=1&page=3'));
  assert.equal(f.category, 'tv');
  assert.equal(f.state, 'unresolved');
  assert.equal(f.band, 'none');
  assert.equal(f.disagreementOnly, true);
  assert.equal(f.page, 3);
});

test('parseFilters is total: nonsense falls back rather than throwing', () => {
  // A URL is user input. This must not throw and must not produce a value
  // that reaches SQL as-is.
  const f = parseFilters(new URLSearchParams('category=banana&state=asleep&band=chartreuse&page=-3'));
  assert.equal(f.category, null);
  assert.equal(f.state, null);
  assert.equal(f.band, 'any');
  assert.equal(f.page, 1, 'page clamps to at least 1');
});

test('parseFilters ignores a caller-supplied page size', () => {
  // Not user-controlled: a query asking for 100000 rows is a denial of service
  // with extra steps.
  const f = parseFilters(new URLSearchParams('perPage=100000'));
  assert.equal(f.perPage, PER_PAGE);
});

test('parseFilters treats a repeated parameter as its first value', () => {
  const f = parseFilters(new URLSearchParams('page=2&page=9'));
  assert.equal(f.page, 2);
});

// --- browseCache: against the real database -------------------------------

const FIXTURE = 'books';

async function seed(): Promise<void> {
  await withTransaction(async (tx) => {
    // parses first: `lookups_parse_fk` requires the referenced row to exist and
    // is not deferrable. One parse per lookup, and `fixture-medium` carries
    // tokens with no categoryDisagreement key so the COALESCE path is covered.
    const parses: readonly [string, Record<string, unknown>][] = [
      ['fixture-high', { categoryDisagreement: false }],
      ['fixture-medium', {}],
      ['fixture-low', { categoryDisagreement: true }],
      ['fixture-none', { categoryDisagreement: false }],
    ];
    for (const [key, tokens] of parses) {
      await tx.execute(sql`
        INSERT INTO parses (category, normalized_key, tokens, parser_version)
        VALUES (${FIXTURE}, ${key}, ${JSON.stringify(tokens)}::jsonb, 1)`);
    }
    // Four rows spanning every band.
    const rows: readonly [string, string, number | null][] = [
      ['fixture-high', 'resolved', 0.95],
      ['fixture-medium', 'resolved', 0.80],
      ['fixture-low', 'unresolved', 0.10],
      ['fixture-none', 'unresolved', null],
    ];
    for (const [name, state, confidence] of rows) {
      await tx.execute(sql`
        INSERT INTO lookups (category, name, normalized_key, state, confidence)
        VALUES (${FIXTURE}, ${name}, ${name}, ${state}::lookup_state, ${confidence})`);
    }
  });
}

async function unseed(): Promise<void> {
  const db = getDb();
  // lookups first: ON DELETE RESTRICT refuses to remove a parse that a lookup
  // still references, and this runs inside a `finally` where a failure would
  // silently leave fixtures behind.
  await db.execute(sql`DELETE FROM lookups WHERE category = ${FIXTURE}`);
  await db.execute(sql`DELETE FROM parses WHERE category = ${FIXTURE}`);
}

test('every band together accounts for every row, so nothing is hidden', opts, async () => {
  // The invariant that matters, asserted against the whole table rather than a
  // fixture: a band filter that silently drops NULL-confidence rows would make
  // these sums disagree. 24 of the dev rows are unscored.
  const counts = new Map<string, number>();
  for (const band of CONFIDENCE_BANDS) {
    const page = await withTransaction((tx) => browseCache(tx, { ...base, band }));
    counts.set(band, page.total);
  }
  const any = counts.get('any') ?? -1;
  const parts = (counts.get('high') ?? 0) + (counts.get('medium') ?? 0)
    + (counts.get('low') ?? 0) + (counts.get('none') ?? 0);
  assert.ok(any > 0, 'the dev cache should not be empty');
  assert.equal(parts, any, `bands sum to ${parts} but any is ${any}`);
});

test('the none band finds unscored rows, which are the interesting ones', opts, async () => {
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, band: 'none' }));
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.name, 'fixture-none');
    assert.equal(page.rows[0]?.confidence, null);
  } finally {
    await unseed();
  }
});

test('each band selects only its own rows', opts, async () => {
  await unseed();
  try {
    await seed();
    const only = async (band: CacheFilters['band']): Promise<readonly string[]> => {
      const page = await withTransaction((tx) =>
        browseCache(tx, { ...base, category: FIXTURE, band }));
      return page.rows.map((row) => row.name);
    };
    assert.deepEqual(await only('high'), ['fixture-high']);
    assert.deepEqual(await only('medium'), ['fixture-medium']);
    assert.deepEqual(await only('low'), ['fixture-low']);
    assert.deepEqual(await only('none'), ['fixture-none']);
    assert.equal((await only('any')).length, 4);
  } finally {
    await unseed();
  }
});

test('the state filter narrows to one state', opts, async () => {
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, state: 'resolved' }));
    assert.equal(page.total, 2);
    assert.ok(page.rows.every((row) => row.state === 'resolved'));
  } finally {
    await unseed();
  }
});

test('the disagreement filter needs the parses join and finds the flagged row', opts, async () => {
  // categoryDisagreement is not a column: it lives in parses.tokens, joined on
  // (category, normalized_key).
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, disagreementOnly: true }));
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.name, 'fixture-low');
    assert.equal(page.rows[0]?.disagreement, true);
  } finally {
    await unseed();
  }
});

test('a parse without the disagreement key reports false, not null', opts, async () => {
  // `lookups_parse_fk` means every lookup has a parse, so "no parse row" is
  // unreachable -- but a parse whose tokens lack the key is not, and COALESCE
  // is what turns that into false rather than null.
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE }));
    assert.equal(page.total, 4);
    const medium = page.rows.find((row) => row.name === 'fixture-medium');
    assert.equal(medium?.disagreement, false, 'a missing key must read as false');
    const high = page.rows.find((row) => row.name === 'fixture-high');
    assert.equal(high?.disagreement, false);
  } finally {
    await unseed();
  }
});

test('paging is stable and reports a total larger than the page', opts, async () => {
  await unseed();
  try {
    await seed();
    const first = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, perPage: 2, page: 1 }));
    const second = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, perPage: 2, page: 2 }));
    assert.equal(first.total, 4);
    assert.equal(first.pageCount, 2);
    assert.equal(first.rows.length, 2);
    assert.equal(second.rows.length, 2);
    // No row appears on both pages -- the failure a non-total sort produces.
    const ids = new Set([...first.rows, ...second.rows].map((row) => row.id));
    assert.equal(ids.size, 4, 'a row appeared on two pages');
  } finally {
    await unseed();
  }
});

test('a page past the end is empty rather than an error', opts, async () => {
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, perPage: 2, page: 99 }));
    assert.equal(page.rows.length, 0);
    assert.equal(page.total, 4, 'the total still describes the filtered set');
  } finally {
    await unseed();
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/cache/browse.test.ts
```

Expected: FAIL — cannot resolve `../../lib/cache/browse`.

- [ ] **Step 3: Write the module**

`lib/cache/browse.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { CATEGORIES, type Category } from '../parse/types';

export type ConfidenceBand = 'any' | 'high' | 'medium' | 'low' | 'none';
export const CONFIDENCE_BANDS: readonly ConfidenceBand[] = ['any', 'high', 'medium', 'low', 'none'];

export type LookupState = 'resolved' | 'unresolved' | 'pending';
export const LOOKUP_STATES: readonly LookupState[] = ['resolved', 'unresolved', 'pending'];

/** Not user-controlled: a query asking for 100000 rows is a denial of service with extra steps. */
export const PER_PAGE = 25;

export interface CacheFilters {
  readonly category: Category | null;
  readonly state: LookupState | null;
  readonly band: ConfidenceBand;
  readonly disagreementOnly: boolean;
  readonly page: number;
  readonly perPage: number;
}

export interface CacheRow {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly state: string;
  readonly confidence: number | null;
  readonly hitCount: number;
  readonly pinned: boolean;
  readonly disagreement: boolean;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
}

export interface CachePage {
  readonly rows: readonly CacheRow[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly pageCount: number;
}

/**
 * Filters from a URL, which is user input.
 *
 * Total by construction: every unrecognised value falls back, `page` clamps to
 * at least 1, and `perPage` is not read from the query at all. Nothing here can
 * throw, and nothing user-supplied reaches SQL as a value the query did not
 * choose.
 */
export function parseFilters(params: URLSearchParams): CacheFilters {
  const one = (key: string): string | null => params.get(key);

  const rawCategory = one('category');
  const category = CATEGORIES.find((value) => value === rawCategory) ?? null;

  const rawState = one('state');
  const state = LOOKUP_STATES.find((value) => value === rawState) ?? null;

  const rawBand = one('band');
  const band = CONFIDENCE_BANDS.find((value) => value === rawBand) ?? 'any';

  const rawPage = Number.parseInt(one('page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  return {
    category,
    state,
    band,
    disagreementOnly: one('disagreement') === '1',
    page,
    perPage: PER_PAGE,
  };
}

/**
 * The band predicate.
 *
 * `low` names `IS NOT NULL` explicitly even though SQL would treat
 * `confidence < 0.75` as not-true for a NULL anyway. Being explicit means the
 * next person writing `NOT (confidence >= 0.75)` elsewhere does not get a
 * different answer, and it documents that unscored rows are `none`, not `low`.
 */
function bandPredicate(band: ConfidenceBand): SQL | null {
  switch (band) {
    case 'high': return sql`l.confidence >= 0.9`;
    case 'medium': return sql`l.confidence >= 0.75 AND l.confidence < 0.9`;
    case 'low': return sql`l.confidence IS NOT NULL AND l.confidence < 0.75`;
    case 'none': return sql`l.confidence IS NULL`;
    case 'any': return null;
  }
}

/**
 * One page of the cache, with the total for the same filters.
 *
 * `count(*) OVER ()` returns the unfiltered-by-LIMIT total alongside the rows,
 * so this is one round trip rather than two — and the total cannot disagree
 * with the page, which is what a separate count query risks under concurrent
 * writes.
 *
 * The join is LEFT: `categoryDisagreement` lives in `parses.tokens`, and most
 * `lookups` rows have no matching `parses` row, so an inner join would drop
 * them from every unfiltered page. `disagreementOnly` adds a predicate rather
 * than changing the join, for the same reason.
 */
export async function browseCache(tx: Tx, filters: CacheFilters): Promise<CachePage> {
  const conditions: SQL[] = [];
  if (filters.category !== null) conditions.push(sql`l.category = ${filters.category}`);
  if (filters.state !== null) conditions.push(sql`l.state = ${filters.state}::lookup_state`);
  const band = bandPredicate(filters.band);
  if (band !== null) conditions.push(band);
  if (filters.disagreementOnly) {
    conditions.push(sql`(p.tokens->>'categoryDisagreement')::boolean IS TRUE`);
  }

  const where = conditions.length === 0
    ? sql``
    : sql`WHERE ${sql.join(conditions, sql` AND `)}`;

  const offset = (filters.page - 1) * filters.perPage;

  // ORDER BY created_at alone is not a total order: rows sharing a timestamp
  // can swap between pages, so one is seen twice and another never. `id` is
  // the tiebreak.
  const result = await tx.execute(sql`
    SELECT l.id, l.category, l.name, l.state, l.confidence, l.hit_count, l.pinned,
           l.created_at, l.last_attempt_at,
           COALESCE((p.tokens->>'categoryDisagreement')::boolean, false) AS disagreement,
           count(*) OVER () AS total
      FROM lookups l
      LEFT JOIN parses p ON p.category = l.category AND p.normalized_key = l.normalized_key
      ${where}
     ORDER BY l.created_at DESC, l.id
     LIMIT ${filters.perPage} OFFSET ${offset}`);

  // `unknown` here is the deserialization exception: these are database columns
  // narrowed on the way out, never read as application state.
  const rows: CacheRow[] = result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    category: String(row.category),
    name: String(row.name),
    state: String(row.state),
    confidence: row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence),
    hitCount: Number(row.hit_count),
    pinned: row.pinned === true,
    disagreement: row.disagreement === true,
    createdAt: String(row.created_at),
    lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined
      ? null
      : String(row.last_attempt_at),
  }));

  // A page past the end returns no rows and therefore no window total, but the
  // filtered total is still a fact the caller needs — so ask for it rather than
  // reporting zero and making the pager look empty.
  const total = rows.length > 0
    ? Number(result.rows[0]?.total ?? 0)
    : await countOnly(tx, where);

  return {
    rows,
    total,
    page: filters.page,
    perPage: filters.perPage,
    pageCount: Math.max(1, Math.ceil(total / filters.perPage)),
  };
}

async function countOnly(tx: Tx, where: SQL): Promise<number> {
  const result = await tx.execute(sql`
    SELECT count(*)::int AS total
      FROM lookups l
      LEFT JOIN parses p ON p.category = l.category AND p.normalized_key = l.normalized_key
      ${where}`);
  return Number(result.rows[0]?.total ?? 0);
}
```

- [ ] **Step 4: Run the tests**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/cache/browse.test.ts
```

Expected: 13 passing. Diagnostics:

- If `every band together accounts for every row` fails, a band predicate is dropping rows — almost certainly NULL handling. That test exists precisely because the failure is otherwise invisible.
- If `a row with no parse row is not a disagreement and does not vanish` fails, the join became inner.
- If `a row appeared on two pages` fails, the `ORDER BY` lost its tiebreak.

- [ ] **Step 5: Commit**

```bash
npm run check && npm run build
git add lib/cache/browse.ts test/cache/browse.test.ts
git commit -m "Add the cache browse query

The confidence band is a closed set with an explicit none, because 24 of
106 dev lookups have NULL confidence -- 23 unresolved and 1 pending, of
which only 2 were refused parses. So most unscored rows parsed fine and
found no match, and those are the failures an admin is looking for. A
band filter written as >= x / < x hides all 24 without saying so. One
test asserts the bands sum to the unfiltered total, which is the only
way that class of bug is visible.

low says IS NOT NULL explicitly even though SQL would treat the
comparison as not-true anyway: the next person writing NOT (confidence
>= 0.75) elsewhere would otherwise get a different answer.

The join is LEFT even though lookups_parse_fk guarantees a matching
parses row today, so LEFT and INNER are currently equivalent: the
constraint is a fact about the schema, not about this query, and an
INNER join would silently start dropping rows if it were ever relaxed.
COALESCE earns its place regardless, because a parse may carry tokens
with no categoryDisagreement key -- there is a test for exactly that.
ORDER BY carries an id tiebreak because created_at
alone is not a total order, and without it a row can appear on two pages
while another appears on none.

parseFilters is total: a URL is user input, so nonsense falls back, page
clamps, and perPage is not read from the query at all."
```

---
### Task 4: The admin cache browser

**Files:**
- Create: `app/(admin)/admin/cache/page.tsx`, `components/cache-filters.tsx`
- Modify: `app/(admin)/admin/page.tsx` (link to the browser it has been promising)
- Test: `test/ui/cachePage.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (`lib/auth/session.ts`), `withTransaction` (`lib/db/client.ts`), `parseFilters`/`browseCache`/`PER_PAGE`/`CONFIDENCE_BANDS`/`LOOKUP_STATES` (Task 3), `CATEGORIES` (`lib/parse/types.ts`), the `components/ui/*` primitives.
- Produces: `CacheFilters` — a **server** component rendering the filter form, taking the current filters as props.

**The filter form needs no client component.** It is a plain `<form method="get">`: the selects submit to the same URL, the server component reads them back through `searchParams`, and the URL is the whole state. No `'use client'`, no `useState`, no fetch — and it works with JavaScript disabled. Filters that live in the URL are also shareable and bookmarkable, which is what an admin actually wants when they find an interesting row.

**`searchParams` is a Promise, and getting that wrong fails silently.** In Next 16 the page receives `searchParams: Promise<Record<string, string | string[] | undefined>>` and must `await` it — the same as `params`, which this project established in Plan 1. **I probed the type system and both the Promise and the non-Promise annotation typecheck**, so a missing `await` is not a compile error: every filter would read `undefined` and the page would silently show an unfiltered first page forever. Write it as a Promise, await it, and do not trust `tsc` to catch this one.

`URLSearchParams` is the input `parseFilters` wants, so build one from the awaited record — taking the first value where a key repeats, which is what `parseFilters`'s test expects.

**A non-admin is refused, but with a rendered refusal rather than an HTTP 403.** The spec's success criterion 7 says "a non-admin receives `403` from `/admin/cache`". `app/(admin)/admin/layout.tsx` renders a refusal instead, because a real 403 from a page needs `next/navigation`'s `forbidden()`, which requires the experimental `authInterrupts` flag — Plan 4 declined to enable an experimental flag to render one sentence, and a whole-branch review accepted that. The **substance** of the criterion holds: a non-admin cannot see cache data, and the page checks for itself as well as the layout. The **letter** does not: the status is 200. `GET /api/v1/admin/whoami` does return a real 403, so the mechanism exists where a status matters. Recorded as a follow-up decision rather than silently satisfied.

- [ ] **Step 1: Write the failing test**

`test/ui/cachePage.test.ts`. Source-level per this project's convention, **with an emptiness guard on every filter**:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CacheFilters } from '../../components/cache-filters';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

const importLines = (text: string, path: string): readonly string[] =>
  text.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('import') && line.includes(path));

test('the filter form is a server component and needs no client bundle', async () => {
  // A plain <form method="get"> submits to the same URL and the server reads
  // it back. No 'use client', no state, no fetch -- and it works without JS.
  assert.equal(typeof CacheFilters, 'function');
  const text = await source('components/cache-filters.tsx');
  assert.equal(text.includes("'use client'"), false, 'must not be a client component');
  assert.ok(text.includes('method="get"'), 'must submit as a GET form');
  assert.equal(text.includes('useState'), false, 'the URL is the state');
});

test('the page awaits searchParams', async () => {
  // Next 16 passes a Promise, and BOTH annotations typecheck -- so a missing
  // await is not a compile error, it silently makes every filter undefined.
  const text = await source('app/(admin)/admin/cache/page.tsx');
  assert.ok(text.includes('Promise<'), 'searchParams must be typed as a Promise');
  assert.ok(/await\s+searchParams/.test(text), 'searchParams must be awaited');
});

test('the page guards itself as well as the layout', async () => {
  // A layout does not re-run on client-side navigation, so the thing that
  // serves data checks for itself.
  const text = await source('app/(admin)/admin/cache/page.tsx');
  const lines = importLines(text, 'lib/auth/session');
  assert.ok(lines.length > 0, 'expected the session module to be imported');
  assert.ok(text.includes('requireAdmin('), 'the page must call requireAdmin');
});

test('the page uses the tested query module rather than inlining SQL', async () => {
  const text = await source('app/(admin)/admin/cache/page.tsx');
  const lines = importLines(text, 'lib/cache/browse');
  assert.ok(lines.length > 0, 'expected browseCache to be imported');
  assert.ok(text.includes('browseCache('), 'expected browseCache to be called');
  assert.ok(text.includes('parseFilters('), 'expected parseFilters to be called');
  // Inline SQL here would be untested and would duplicate the band logic.
  assert.equal(text.includes('sql`'), false, 'the page must not build its own query');
});

test('the admin index links to the cache browser', async () => {
  // It promised cache inspection for two plans; now the link exists.
  const text = await source('app/(admin)/admin/page.tsx');
  assert.ok(text.includes('/admin/cache'), 'the admin index should link to the browser');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --env-file-if-exists=.env.local --import tsx --test test/ui/cachePage.test.ts
```

Expected: FAIL — cannot resolve `../../components/cache-filters`.

- [ ] **Step 3: Write the filter form**

`components/cache-filters.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { CATEGORIES } from '../lib/parse/types';
import { CONFIDENCE_BANDS, LOOKUP_STATES, type CacheFilters as Filters } from '../lib/cache/browse';

/**
 * The filters, as a plain GET form.
 *
 * Deliberately not a client component: the selects submit to the same URL, the
 * page reads them back through `searchParams`, and the URL is the entire state.
 * That makes a filtered view shareable and bookmarkable -- which is what an
 * admin wants the moment they find an interesting row -- and it works with
 * JavaScript disabled.
 *
 * `page` is not carried over: changing a filter should return to the first
 * page, because page 7 of a different result set is meaningless.
 */
export function CacheFilters({ filters }: { readonly filters: Filters }) {
  const select = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="category">Category</Label>
        <select id="category" name="category" defaultValue={filters.category ?? ''} className={select}>
          <option value="">any</option>
          {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="state">State</Label>
        <select id="state" name="state" defaultValue={filters.state ?? ''} className={select}>
          <option value="">any</option>
          {LOOKUP_STATES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="band">Confidence</Label>
        <select id="band" name="band" defaultValue={filters.band} className={select}>
          {CONFIDENCE_BANDS.map((value) => (
            <option key={value} value={value}>
              {value === 'none' ? 'none (unscored)' : value}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="disagreement"
          value="1"
          defaultChecked={filters.disagreementOnly}
        />
        category disagreement only
      </label>

      <Button type="submit" variant="outline" size="sm">Apply</Button>
    </form>
  );
}
```

- [ ] **Step 4: Write the page**

`app/(admin)/admin/cache/page.tsx`:

```tsx
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../../lib/auth/session';
import { withTransaction } from '../../../../lib/db/client';
import { browseCache, parseFilters, type CacheFilters as Filters } from '../../../../lib/cache/browse';
import { CacheFilters } from '../../../../components/cache-filters';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** The filters as a query string, for the pager's links. */
function toQuery(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.category !== null) params.set('category', filters.category);
  if (filters.state !== null) params.set('state', filters.state);
  if (filters.band !== 'any') params.set('band', filters.band);
  if (filters.disagreementOnly) params.set('disagreement', '1');
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query.length === 0 ? '/admin/cache' : `/admin/cache?${query}`;
}

// `headers()` and `redirect()` both throw control flow, so neither is inside a
// try. The page guards itself as well as the layout, because a layout does not
// re-run on client-side navigation and this is the thing that serves data.
export default async function CachePage({ searchParams }: {
  // A Promise in Next 16, like `params`. Both annotations typecheck, so a
  // missing await is not a compile error -- it would silently make every
  // filter undefined and pin the page to an unfiltered first page.
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await requireAdmin(await headers());
  if (!guard.ok) {
    if (guard.response.status === 401) redirect('/sign-in');
    return (
      <main>
        <h1>Not available</h1>
        <p>This area requires the admin role.</p>
      </main>
    );
  }

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    // First value where a key repeats, matching parseFilters' contract.
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  const filters = parseFilters(params);
  const page = await withTransaction((tx) => browseCache(tx, filters));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Cache browser</h1>
        <p className="text-sm text-muted-foreground">
          {page.total} {page.total === 1 ? 'row' : 'rows'} match. Unscored rows — refused parses,
          lookups with no match, and anything still resolving — are the <em>none</em> band, and are
          usually the interesting ones.
        </p>
      </div>

      <CacheFilters filters={filters} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Hits</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                Nothing matches these filters.
              </TableCell>
            </TableRow>
          ) : page.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs break-all">
                {row.name}
                {row.disagreement ? <Badge variant="outline" className="ml-2">disagreement</Badge> : null}
                {row.pinned ? <Badge variant="outline" className="ml-2">pinned</Badge> : null}
              </TableCell>
              <TableCell>{row.category}</TableCell>
              <TableCell>{row.state}</TableCell>
              <TableCell>{row.confidence === null ? '—' : row.confidence.toFixed(3)}</TableCell>
              <TableCell>{row.hitCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {page.pageCount <= 1 ? null : (
        <div className="flex items-center gap-4 text-sm">
          {page.page > 1
            ? <Link href={toQuery(filters, page.page - 1)} className="underline">Previous</Link>
            : <span className="text-muted-foreground">Previous</span>}
          <span className="text-muted-foreground">Page {page.page} of {page.pageCount}</span>
          {page.page < page.pageCount
            ? <Link href={toQuery(filters, page.page + 1)} className="underline">Next</Link>
            : <span className="text-muted-foreground">Next</span>}
        </div>
      )}
    </div>
  );
}
```

**On `Link href` and `typedRoutes`.** `toQuery` returns a template string, not a literal, so `typedRoutes` cannot check it — and `/admin/cache` exists, so it resolves. If `tsc` objects to the dynamic string, do **not** cast: use the object form `href={{ pathname: '/admin/cache', query: … }}`, which is the supported way to build a typed route dynamically. Say which you used.

- [ ] **Step 5: Link the admin index to the browser**

In `app/(admin)/admin/page.tsx`, replace the "cache inspection is coming" sentence with a real link to `/admin/cache`. It has been promising this for two plans.

- [ ] **Step 6: Run everything**

```bash
npm run check
npm run build
```

Expected: 5 new tests, the suite green with 0 skipped, and `/admin/cache` listed as `ƒ` (Dynamic).

- [ ] **Step 7: Prove success criterion 7 against a live server**

This is the spec's last unproven criterion: "A non-admin receives 403 from `/admin/cache`; an admin can filter it by confidence band and by `categoryDisagreement`."

Start the dev server in the background with output redirected, poll until ready, then with cookies obtained the way `test/helpers/signIn.ts` does — **kept in a variable or scratch file, never in a command argument**:

1. Signed out: `/admin/cache` redirects toward `/sign-in`.
2. Signed in as a **non-admin**: the response contains "This area requires the admin role". **Report the HTTP status**; it will be 200, and the divergence note above explains why.
3. Promote that user (`npm run admin:promote -- <email>`), then:
   - `/admin/cache` renders the table.
   - `/admin/cache?band=none` shows unscored rows. **Report the count you observe rather than matching a number here** — the dev database grows as the suite runs, and this figure was 24 when the plan was written and 29 by the time Task 4 ran. The invariant in the next step is what matters, not the constant.
   - `/admin/cache?disagreement=1` shows exactly the 1 flagged row.
   - `/admin/cache?band=high&category=tv` narrows further.
4. Confirm the band counts add up: the row counts from `band=high`, `medium`, `low` and `none` must sum to the count from no band filter. **If they do not, a band is hiding rows** — that is the defect Task 3's invariant test exists for, and seeing it hold through the UI is worth the extra minute.

Stop the server, confirm no `next dev` process remains, and delete any `AGENTS.md`/`CLAUDE.md` it regenerated. Report every status and count.

- [ ] **Step 8: Commit**

```bash
git add "app/(admin)/admin/cache/page.tsx" components/cache-filters.tsx \
        "app/(admin)/admin/page.tsx" test/ui/cachePage.test.ts
git commit -m "Add the admin cache browser

The filter form is a plain GET form and not a client component: the
selects submit to the same URL, the page reads them back through
searchParams, and the URL is the entire state -- so a filtered view is
shareable and bookmarkable, which is what an admin wants the moment they
find an interesting row, and it works without JavaScript.

searchParams is awaited as a Promise. Both annotations typecheck, so a
missing await is not a compile error: every filter would read undefined
and the page would sit on an unfiltered first page forever. A test
asserts the await rather than trusting tsc.

The page calls requireAdmin itself as well as the layout, because a
layout does not re-run on client-side navigation and this is the thing
that serves data. It calls the tested query module rather than building
SQL, and a test asserts there is no sql template in the page -- inline
SQL here would duplicate the band logic untested.

The copy names the none band as usually the interesting one, because
unscored rows are the failures: refused parses, lookups with no match,
and anything still resolving."
```

---

## Done when

- `npm run check` and `npm run build` both pass, with 0 skipped tests.
- A signed-in user can paste or upload names for one category on `/corpus`, watch chunked progress, and see per-row results plus parsed %, resolved % and mean confidence.
- A cold run reports `pending` separately and says the resolved rate is a floor until a re-run.
- An admin can browse `/admin/cache` filtered by category, state, confidence band and `categoryDisagreement`, with working pagination.
- **The band counts sum to the unfiltered total** — no filter silently hides rows.
- A non-admin cannot see cache data; a signed-out visitor is redirected to `/sign-in`.
- No credential appears in a log line, a response body, a rendered page, a client bundle, or a command line.
- The dev database is left as it was found: every test cleans up in a `finally`.

## Deliberately not in this plan

- **A session rate limiter.** `/api/ui/corpus` caps a chunk at 5 and the TMDB client's in-process token bucket paces provider calls, but a signed-in user can still loop chunks indefinitely. The cap bounds the blast radius of one request, not of a determined person. Recorded as follow-up; doing it properly needs a per-user window table, which is a schema change.
- **A real HTTP 403 from `/admin/*` pages.** Needs the experimental `authInterrupts` flag. Plan 4 declined it and a whole-branch review accepted that; this plan keeps the decision and names the divergence rather than quietly satisfying the criterion.
- **Deriving `handleLookup`'s `z.enum` from `CATEGORIES`.** It is a third hardcoded copy of the category list, so adding a category typechecks and then 400s at the API. Real, pre-existing, and in a load-bearing file — carried in the Plan 5 notes.
- **The `books` and `xxx` slices.** The spec assigns each its own later spec. `books` is used here only as an empty namespace for test fixtures, which is worth remembering when that slice arrives: those tests will need a different isolation strategy.
- **Resolving a `/corpus` run's pending items in-page.** They are enqueued for the cron, which picks them up within the minute. Polling from the browser would need a session-gated poll route, which Plan 5 deferred and nothing yet needs.
- **Fixing the test-suite row leakage** carried from Plans 4 and 5 (`api_keys` in the hundreds for four users). Every test in this plan cleans up in a `finally`; the older files are not this plan's to reopen.
