# xxx slice — follow-ups

Written 2026-08-31, after the slice shipped green at 463 tests. Everything
here is known and accepted, not forgotten. Ordered by what I would fix first.

## 1. `inRollback` hides the error that actually happened

`test/providers/tpdb-sites.test.ts`, `test/resolve/persist.test.ts`,
`test/auth/apiKey.test.ts` and others assert `assert.rejects(..., /__rollback__/)`,
so any *other* failure inside the transaction surfaces as "the input did not
match the regular expression" with the real error buried in the message.

This cost real time twice in one session: once on a Neon connection drop, and
once when a `unique_violation` from a genuine production bug was reported as a
regex mismatch. The helper should re-throw anything that is not the rollback
sentinel. It is duplicated across several test files, so fixing it means
extracting it first.

## 2. 96 names still carry a duplicated site in the title

Library-form names with no date, where the filename spells the site across
several tokens (`AI.Gen` for site `AIGen`) while `stripLeadingSiteToken`
matches only one whole token. 96 of 1,613 in that population, ~0.75% of the
corpus.

`site` itself is correct, so `site_id` lookup is unaffected; the cost is a
noisier `q` string for names that use the text fallback anyway. The fix is to
try progressively longer leading token runs against the normalised site.
Regenerating `xxx.golden.jsonl` afterwards is required.

## 3. Two concurrent resolves of one new site can still collide

`rememberSite` deletes any row holding the same short name under a different
id, then upserts. The delete locks nothing when no row exists, so two
resolutions of *different* scenes on the same previously-unseen site can still
race to `unique_violation`.

This is no longer fatal — the cache write is caught and logged, and the
resolution survives — so the only cost is a log line and a cold cache for one
more lookup. A real fix is an advisory lock on the short name, the pattern
`lib/resolve/pipeline.ts` already uses for `category:normalized_key`.

## 4. The suite takes ~75 seconds, and the golden file is why

`test/golden.test.ts` re-parses all 12,815 xxx names on every run, against 458
for movies and tv combined. That is genuine regression protection — it caught
nothing during the slice only because the parser was fixed before the file was
frozen — but it is now the dominant cost of running tests at all.

If it becomes a drag: sample the corpus for the default run and keep the
exhaustive pass behind a flag or CI-only. Do not simply shrink it; the value is
in the long tail.

## 5. `resolveRate` is unmeasured for xxx

`fixtures/corpus/baseline.json` has `parseRate`, `titleLeaks` and `refused` for
both xxx files but no `resolveRate`, because measuring it means thousands of
live TPDB calls. Worth doing deliberately, on a sample, with the rate limiter
respected — see item 6 for why that matters.

## 6. TPDB saw roughly 7,300 requests in two minutes on 2026-08-31

A throwaway live-test script (never committed) wrapped `fetch` recursively and
bypassed the client's token bucket. Caught and fixed within minutes, and the
shipped code paths all go through the limiter. Recorded because the account may
have been flagged, and because it is the argument for never hand-rolling a
fetch wrapper around a client that already has one.

## 7. ~~Pre-existing: `test/cache/browse.test.ts` DB-concurrency flake~~ — FIXED

It was not a flake. The band-sum test took its five counts in five separate
transactions while node runs test files in parallel and other files mutate
`lookups` throughout, so a row arriving mid-sequence made the sums disagree for
reasons unrelated to banding. Every agent in this slice, and I, dismissed it as
a database problem; the failure message ("bands sum to 9 but any is 8") said
plainly that it was arithmetic.

Fixed in `278ae49` by taking all five counts in one repeatable-read
transaction. Recorded rather than deleted, because "intermittent, therefore
environmental" was the wrong inference several times in a row and is worth
remembering.

## Deliberately not done

- **Splitting performers out of the filename.** The spec records the full
  reasoning and the measurements: a corpus-mined dictionary caps at 58% recall,
  cannot represent mononyms, and TPDB returns canonical performers anyway.
- **ibdb.dev / the books slice.** `providerFor('books')` returns null, and
  `lib/providers/routing.ts` is where that changes.
