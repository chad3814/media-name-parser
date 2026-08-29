# Plan 4 follow-ups

Written 2026-08-28, at the end of the auth-foundation branch. Everything here was
found during Plan 4 and deliberately **not** fixed in it, with the reason. Nothing
below blocks a merge; the whole-branch review's verdict was ready-to-merge and the
final scoped re-review agreed.

## 1. The test suite leaks rows into the shared dev database

`api_keys` stands at **304 rows for 4 users**, growing about 10 per full
`npm run check`. The source is Plan 3's route tests (`test/http/read-routes.test.ts`,
`test/http/lookup-routes.test.ts`), which mint keys and never delete them. Three stray
users — `u-route`, `u-look`, `u-tight` — come from the same place.

This is the most concrete item here and the best candidate for a short debt pass.

**A correction worth recording, because it misled me twice.** During Plan 4 I attributed
the growing `verification` table to the same source, on the strength of zero-delta
row-count measurements around Tasks 2, 3, 5 and 6. The whole-branch review checked the
rows themselves: all 101 carried `sinkprobe@`/`nosink@` addresses, and
`test/auth/server.test.ts` — new in Plan 4 — was the sole source. My measurements were
sound; the generalisation was not. They showed four tasks added nothing, which says
nothing about the fifth. Plan 4 fixed that test's cleanup and deleted the 100 rows;
`verification` now sits at 1 and does not grow.

The lesson generalises past this table: a zero delta measured around *some* changes is
not evidence about changes you did not measure.

## 2. Tests that clean up after their assertions rather than in `finally`

`test/auth/session.test.ts` (the tests predating Plan 4's ban tests),
`test/auth/adminRoute.test.ts` and `test/auth/signInFlow.test.ts` call cleanup after
asserting, so a **failing** test leaves identity rows behind. Demonstrated, not
theoretical: a reviewer's deliberate mutation run left 2 banned users and 2 live
sessions in place.

Plan 4 fixed this in every test it wrote and left the older ones alone, because the last
commit before a merge decision is a poor moment to reopen three finished files. The
consequence is precisely the trap in item 1 — stray rows skewing attribution — so it is
worth doing.

## 3. Nothing in the service can ban a user

`getCurrentUser` and `verifyApiKey` both refuse a currently-banned user, with matching
expiry semantics: a ban applies while `banned` is true and `ban_expires` is null or in
the future. But Plan 4 refuses the whole `/api/auth/admin/*` prefix, which includes the
admin plugin's `ban-user`, so **a ban can only arrive as a direct column write**.

That is a coherent state, not a bug — enforcement without a UI is the right order — but
whoever adds a ban path should add it deliberately rather than by unblocking the plugin's
endpoint, which would also reintroduce `set-role` (see item 4).

## 4. The admin plugin's endpoints are refused, and that decision has a cost

Registering `admin()` is what gives us the `role` column and the shape
`test/db/schema.test.ts` pins against `getAuthTables()`. It also publishes 15
user-administration endpoints on the catch-all, including `impersonate-user` (verified to
mint a session for any user) and `set-role` (verified to rewrite `support,admin` to
`admin`, the exact strip-a-role bug `lib/auth/roles.ts` exists to prevent). 1.7.1 offers
no option to disable them, so `app/api/auth/[...all]/route.ts` refuses the prefix with a
404.

Anything later that wants one of those endpoints must unblock that specific path and
route the write through `lib/auth/roles.ts`, not remove the guard. Note that
`new URL()`'s path normalisation ahead of the prefix test is load-bearing: a re-review
confirmed traversal, encoded traversal, `./admin/…`, query-string and fragment variants
are all requests Better Auth would otherwise have served.

## 5. The admin layout's 503 branch is untested

`app/(admin)/admin/layout.tsx` renders three branches — redirect on 401, a role message
on 403, and a neutral "temporarily unavailable" on anything else. The third is
**unexercised**. Reaching it means rendering an async Server Component, which needs
Next's RSC pipeline: `react-dom/server` throws on async components, `headers()` throws
outside a request scope, and module mocking needs
`--experimental-test-module-mocks`, unused in this suite.

Plan 4 tests the *precondition* instead — `requireAdmin` really does return 503 rather
than throwing, proven in a child process with `BETTER_AUTH_SECRET` removed. The rendered
markup is the gap. If Plan 5 introduces any component-rendering infrastructure, this is
the first thing to point at it.

## 6. Smaller items

- **Two `getSession` round trips per `/admin` render** — the layout and the page each
  ask independently, because a Next layout does not re-run on client-side navigation and
  the page must therefore check for itself. Correct but not free; a per-request cache
  would fix it.
- **`signOut` and `useSession` are exported with no sign-out UI.** Plan 5 owns it.
- **The schema conformance test is presence-only** — it checks that the fields
  `getAuthTables()` expects exist, not their types. Pre-existing. The whole-branch review
  confirmed the configured plugin set produces an identical field list to the one the test
  pins, so the shape is right today; a type check would keep it right.
- **No mailer.** Magic links go to the in-memory sink under `MAGIC_LINK_SINK=1`, or to a
  log line saying nothing was delivered. Choosing a provider is a decision, not an
  implementation detail.
- **`_tmp_*.ts` scratch files break the build**, because `tsconfig.json` includes
  `**/*.ts`. Use `.mjs`.

## What Plan 4 got wrong about its own tests

Three tests written into the plan asserted nothing, and all three were mine:

1. `githubConfigured` recomputed the implementation's own expression and compared the two,
   so `&&` becoming `||` would still have passed.
2. The auth-client tests asserted `typeof … === 'function'`, which is true of *any*
   property path on a Better Auth client — `createAuthClient({}).nonsense.madeUpPath` is
   a function. A re-review then established that **no** runtime test can distinguish a
   registered `magicLinkClient()` from a missing one, because the plugin is types-only;
   the guard is `npm run typecheck`, verified load-bearing by mutation.
3. `'no session token reaches stdout'` asserted an array was empty that every earlier
   test's `finally` had already emptied.

Each was caught by review, not by the suite. The habit that caught them — mutate the code
and confirm the test fails — is cheap and worth applying to any test that looks like it
is checking a shape rather than a behaviour.
