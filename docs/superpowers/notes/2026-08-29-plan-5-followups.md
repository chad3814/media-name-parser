# Plan 5 follow-ups

Written 2026-08-29 at the end of the ui branch. Everything here was found during Plan 5 and
deliberately **not** fixed in it, with the reason. Nothing below blocks a merge: the whole-branch
review returned merge-after-named-fixes, all named fixes landed, and the final scoped re-review
returned ready-to-merge.

## 1. A credential leaked during review, and the instruction that failed to prevent it

A reviewer ran, to inspect database state:

```
psql "$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)"
```

`psql` is not installed here, so the shell echoed the entire failed command — connection string and
password — into its transcript. **The dev `DATABASE_URL` was rotated.** The agent self-reported at
once and switched to the app's own `getDb()` for the rest of its work.

Every dispatch already said "never read, `cat`, `head`, or print `.env.local`" and "never search any
file for a credential's value". A `grep` piped into a command *argument* is both at once, and the
instruction did not name that shape. **The rule that actually prevents this, and which every
subsequent dispatch carried verbatim:**

> Never interpolate a credential into a command line. Any command that fails echoes its whole
> argument list.

The safe form is to go through the app's client, which never surfaces the connection string:

```bash
node --env-file=.env.local --import tsx -e "
import { getDb, closeDb } from './lib/db/client';
import { sql } from 'drizzle-orm';
const r = await getDb().execute(sql\`SELECT 1 AS ok\`);
console.log(r.rows[0]);
await closeDb();
"
```

This was the fourth credential incident on this project and the first caused by a reviewer rather
than an implementer. Worth generalising: the risk is not reading a secret, it is a secret appearing
anywhere a failure can echo.

## 2. Eight tests were corrected for not asserting what their names claimed

All eight were written by me, across two plans. Every one was caught by review, never by the suite.
The shapes recur, so they are worth recognising on sight rather than rediscovering:

1. **A loop whose assertion sits inside it.** `for (const line of matches) assert(...)` passes
   vacuously when `matches` is empty. Two instances. **An emptiness guard is the fix, every time.**
2. **An assertion against a value the test itself built.** `assert.deepEqual(Object.keys(literal), …)`
   cannot fail on any change to the code under test.
3. **A fixture too weak to distinguish a pass from a failure.** A crossover test sent an *unminted*
   bearer token, so it got 401 from the correct gate (no cookie) and from a wrongly wired one
   (unknown key) alike. It stayed green through the exact regression it was named for. The fix was
   to mint a real key and assert it works on the route it belongs to *first*, so a later 401 cannot
   be dismissed as a bogus token.
4. **Recomputing the implementation's own expression** and comparing the two.
5. **A comment describing an assertion nobody wrote** — `cached` destructured and never asserted.
6. **`x?.field !== null`**, which is `true` when the collection is empty *and* when the field is
   absent. Assert the length first.
7. **A test that dictates prose.** Filtering every line containing a module path fails on a comment
   explaining why the import is type-only. Inspect lines beginning with `import`.

The habit that caught all of them is cheap: **mutate the code the test covers and confirm the test
fails.** It is worth doing for any test that checks a shape rather than a behaviour.

## 3. `Category` is hardcoded in three places

`lib/parse/types.ts:3` exports `CATEGORIES`, `components/lookup-form.tsx` now imports it — but
`lib/http/lookupHandler.ts`'s `z.enum` is a **third** copy. Adding a category to `types.ts`
typechecks clean and then 400s at the API, with a dropdown offering the option. Deriving the zod
enum from `CATEGORIES` would close it. Left alone because it means editing a load-bearing handler
after the final review gate had passed.

## 4. The test suite still leaks rows into the shared dev database

`api_keys` is in the hundreds for four users, growing ~10 per full `npm run check`, from Plan 3's
route tests. Carried over from the Plan 4 notes and still the best candidate for a short debt pass.
Every test written in Plans 4 and 5 cleans up in a `finally` — proven under deliberate failure — but
the older files clean up after their assertions, so a red test leaves rows behind.

## 5. A diagnosed flake in Plan 3's rate-limit test

`a rate-limited caller gets 429 with Retry-After` (`test/http/lookup-routes.test.ts`) intermittently
returns 202. Not load — a **minute-boundary race**: `lib/auth/rateLimit.ts` keys each window on
`date_trunc('minute', now)`, and the test sends two requests against a key limited to 1/min. If they
straddle a boundary the second lands in a fresh window at count 1 and is allowed. Load only makes
the straddle likely.

`consume()` already accepts an injectable `now`, but nothing threads one from `handleLookup` through
`authenticate`, so the test cannot pin the window. Two candidate fixes: unit-test `consume` directly
for the refusal and leave the handler test on the happy path; or give `authenticate` a clock
injection point the way `handleLookup` has one for `defer`.

## 6. No React renderer, and two tests are narrower because of it

There is no way to assert that server-fetched data reaches a client component, so
`test/ui/keysManager.test.ts`'s page test checks only that the source mentions `listKeys` and
`KeysManager` — it would pass if the fetched result were discarded. A reviewer judged it consistent
with the project's source-text convention rather than a new defect, and I agree, but it is honestly
narrow. **If Plan 6 introduces any component-rendering infrastructure, this and the untested
`/admin` 503 branch from Plan 4 are the first two things to point at it.**

## 7. Smaller items

- **No `error.tsx` in `app/`.** A throw in any client render takes the page down with a default
  error screen. `when()` was made to degrade rather than throw precisely because of this; a boundary
  would make that defensive coding less load-bearing.
- **No per-user cap on API keys.** A signed-in user can mint without limit. A product decision
  rather than a defect, but worth deciding before real users exist.
- **`/api/ui/lookup` refuses batches** because `sessionGate` charges no rate limit. A future bulk
  page must lift that deliberately *and* attach a limit — the check exists to be replaced, not
  deleted. My original plan deferred this on the reasoning that "the batch belongs to the page that
  sends batches", which was wrong: it is one handler, so the exposure existed the moment the gate
  landed.
- **`components/ui/select.tsx` and `textarea.tsx` are unimported**, and `select.tsx` is the only
  importer of `lucide-react`. Kept rather than churned because Plan 6's `/corpus` and `/admin/cache`
  need both, and neither reaches the bundle while unimported.
- **No mailer.** Magic links go to an in-memory sink under `MAGIC_LINK_SINK=1`, or to a log line
  saying nothing was delivered. The spec's success criterion 6 says "a user can register, mint an API
  token, and use it against `/v1/lookup`" — minting and using are proven end to end
  (201 → 200 → 204 → 401); *registering* still needs a provider chosen.
- **`next typegen` and stale `tsconfig.tsbuildinfo`** can make `tsc` reject a `Link href` to a route
  that genuinely exists, and can invent a phantom `TS2322` after a merge. Seen twice. If a
  typecheck failure names a brand-new route, clear the cache before believing it.

## 8. What Plan 5 got wrong about its own design

Three of the whole-branch review's findings were plan defects, not implementation defects, and they
share a shape worth naming: **each made something stricter without preserving what it did when its
input was bad.**

- The session lookup route accepted 100-item batches unthrottled, while the plan's comment explained
  why that was fine.
- `toLocaleString()` in a server-rendered client component guarantees a hydration mismatch for
  nearly every visitor — and with no renderer, neither a test nor the build can see it.
- The UTC rewrite that fixed it then *threw* where the original returned `"Invalid Date"`, and the
  content-type check I added refused `Application/JSON`.

And one more, which I had warned about in five dispatches across two plans before doing it myself:
**`headers()` throws control flow.** I wrote "there is no `redirect()` in this file, so a `try` here
is safe", then wrapped `headers()` and swallowed Next's dynamic-usage signal. The rule was never
about `redirect()` — it is about any function that signals by throwing. A branch-wide sweep
confirmed there is no third instance.
