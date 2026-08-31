# Plan 6 follow-ups

Written 2026-08-31 at the end of the `bulk-pages` branch, which completes the spec's original
scope: all four pages the UI section names now exist. Everything here was found during Plan 6 and
deliberately **not** fixed in it, with the reason. Nothing below blocks a merge — the whole-branch
review returned merge-after-named-fixes, all named fixes landed, and the final scoped re-review
returned ready-to-merge.

## 1. `/api/ui/*` has no rate limit, and the plan's stated mitigation was false

The plan claimed the TMDB client's in-process token bucket bounded provider pressure, which was the
reason a chunked corpus run seemed acceptable without a session limiter. **It does not.**
`buildTmdbDeps()` builds a **fresh** 30/s bucket per invocation, so no request can see the others.
Measured by a whole-branch review: **8 concurrent chunks (40 names) accepted in 2.40s, nothing
throttled** — roughly 17 names/s, ~60,000/hour from one signed-in session, against a sweeper
(`SWEEP_LIMIT=6`, once a minute) that drains 360 jobs/hour. So a cold bulk run enqueues faster than
it drains, and the corpus page's own "run again in a minute or two" becomes false under load.

Marginal exposure is about **5×**, not unbounded, because `/api/ui/lookup` was already unthrottled
at one lookup per request. What limits real damage: the 12-hour cooling window, the advisory lock,
handled 429s, and the 30-day `provider_calls` prune.

**Scope the fix as a session rate limit on `/api/ui/*` as a family, keyed on `user.id` inside
`sessionGate`** — not as a patch to the corpus route. It needs a per-user window table
(`rate_limit_windows.api_key_id` is `NOT NULL uuid`, so it cannot be reused), which is a schema
change, which is why it was not squeezed into the last task of the last plan.

**One trap to know before you write it.** Both `/api/ui` routes gate **twice** — once explicitly
before reading the body, once inside `handleLookup` — so a limit charged inside `sessionGate` would
bill every authenticated request to those routes double, halving each user's budget. `apiKeyGate`
already shows the hazard by calling `consume()`. Both route comments carry a note where you will be
working. Charge once at the route, or make `handleLookup`'s gate a pass-through for them.

## 2. Two hand-added foreign keys are invisible to the schema-as-code

`lookups_parse_fk` (`FOREIGN KEY (category, normalized_key) REFERENCES parses ON DELETE RESTRICT`)
and `media_parent_id_fk` exist in `drizzle/0000_lethal_whizzer.sql` but in **neither**
`lib/db/schema.ts` **nor** `drizzle/meta/0000_snapshot.json`. They sit after the generated
statements, hand-added in Plan 1. So `drizzle-kit generate` reasons from a schema that does not know
they exist.

This cost real time in Plan 6: the plan asserted "most `lookups` rows have no `parses` row", which
the FK makes impossible — every lookup is guaranteed a parse, 0 orphans in 112 — and the fixtures
inserted in the wrong order and deleted in the wrong order, the latter inside a `finally` where
`RESTRICT` would have failed silently. **Model both FKs in `schema.ts`**, and check whether any
other hand-added constraint is similarly invisible.

## 3. `provider_calls.lookup_id` is NULL for every row

**5,773 of 5,773.** Only a cold lookup calls the provider, and a cold lookup has no `lookups` row
yet when the call is recorded. So provider spend cannot be attributed to a lookup — on the same
branch that adds a bulk endpoint capable of tens of thousands of calls an hour. Fix by recording the
call after the row exists, or by carrying the normalized key instead of the id.

## 4. The test suite still accumulates `api_keys` rows

**796 rows for 4 users**, with 0 orphans, growing every full `npm run check`. Carried from the Plan 5
notes, where it was 631. The cause is unchanged: Plan 3's route tests mint keys and clean up after
their assertions rather than in a `finally`, so a red test leaves rows behind. Every test written in
Plans 4, 5 and 6 cleans up in a `finally` — verified under deliberate failure — but the older files
were never reopened. **This is the best-value debt pass in the project**: it is mechanical, it is
contained, and it makes every future row-count measurement trustworthy.

## 5. `components.json` will undo half of a dependency removal

Plan 6 removed `components/ui/select.tsx` (0 importers two plans after installation) and with it
`lucide-react`, which nothing else reached. But `components.json` still declares
`"iconLibrary": "lucide"`, so the next `shadcn add` of an icon-using primitive re-adds the
dependency. Left alone deliberately — editing a generated config to defend a dependency removal is a
worse trade than writing it down.

Worth recording the mistake behind it: **Plan 5 kept both `select.tsx` and `textarea.tsx` on the
grounds that "Plan 6 needs both."** Plan 6 used `textarea.tsx` and hand-rolled three `<select>`
elements instead. Half the prediction was right. A dependency kept for a predicted future use should
be checked against that future when it arrives.

## 6. Smaller items

- **A fourth copy of the lookup-state list.** `lib/cache/browse.ts` exports `LOOKUP_STATES`
  alongside the schema enum, `handleLookup`'s `z.enum`, and the database type. `parseFilters`
  validates against `LOOKUP_STATES` before the `::lookup_state` cast, so drift shows up as a valid
  state being rejected. Same shape as the category-list debt in the Plan 5 notes.
- **Three stale comments**: `test/cache/browse.test.ts` says "24 unscored" (29 at time of writing,
  and it moves); `lib/http/lookupHandler.ts:252` defers a poll route to "a later plan" that will not
  exist; `test/helpers/signIn.ts:53` cites a script shipped two plans ago.
- **`npm run test -- <file>` does not filter.** The script ends in a glob and an appended path is
  *added* to it, so that command silently runs the whole suite — measured, it ran all 329 tests
  while the direct form ran 6. Every RED step in six plans said the wrong thing. The working form is
  `node --env-file-if-exists=.env.local --import tsx --test <file>`. Worth a `test:one` script.
- **A transient Neon WebSocket failure** was seen once on a plain `SELECT 1`, succeeding on retry.
  Worth knowing before treating a single connection failure as a defect.

## What Plan 6 got wrong about itself, and the two lessons that generalise

Four of the whole-branch review's findings were plan defects rather than implementation defects.
Two of them repeat patterns from earlier plans, and those repetitions are the useful part.

**A ruling recorded in one plan's ledger does not travel to the next plan's code.** Plan 4 shipped a
two-branch admin guard, a review caught it, and the three-way split (401 / 403 / anything-else) was
added deliberately so that a database outage would not tell an admin their permissions were wrong. I
then wrote a *new* page in the same directory with the two-branch shape restored. Nothing in
`npm run check` or `npm run build` could see it, and the implementer had no way to know the sibling
pattern was load-bearing rather than incidental. **Patterns that matter must be visible in the code
they govern**, which is why the fix carries a comment saying not to collapse it again.

**When a refactor makes something testable, the gaps justified by its previous untestability expire.**
I recorded twice — Plan 4 and Plan 6 — that a 503 branch could not be tested because reaching it
needs Next's RSC pipeline. That was true only while the decision lived inside an async Server
Component. The refactor I ordered to make the cache guard testable made it false, and I did not
notice that my own fix had retired my own excuse. A reviewer reached the arm in four lines with
`t.mock.method`. **An honest gap has a reason attached, and a reason can expire** — so gaps need
re-reading whenever the code around them changes shape.

The other two, for the record: the session lookup route accepted an unthrottled 100-item batch while
the plan's comment explained why that was fine (see item 1), and both `/api/ui` routes parsed an
anonymous caller's body before authenticating it — so an anonymous 15 MB payload was read, and an
anonymous caller's status depended on its body shape while the 400 disclosed the chunk cap.

## The habit that caught all of it

**Eleven tests across this project were corrected for not asserting what their names claimed, every
one of them written by me, and every one caught by review rather than by the suite.** The recurring
shapes are catalogued in the Plan 5 notes; Plan 6 added one more — a guard inside an
un-renderable component, where the test that mattered could not exist at all until the decision
moved out.

The habit that caught them is cheap and mechanical: **mutate the code a test covers and confirm the
test fails.** It is worth applying to any test that checks a shape rather than a behaviour, and
especially to any test guarding a boundary — because a boundary test that cannot fail is worse than
no test, since it reports safety that is not there.
