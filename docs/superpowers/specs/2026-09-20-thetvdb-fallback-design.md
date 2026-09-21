# TheTVDB as a TV fallback

**Date:** 2026-09-20
**Status:** approved to implement

## Problem

TMDB is the only provider for `tv`, and it answers two ways that are not
answers:

1. It finds nothing at all.
2. It finds the series but not the season or episode the filename names.
   `lib/providers/tmdb/resolve.ts:273` then returns the *season* in place of
   the episode, and `scoreCandidate` docks 0.4 for the missing episode
   (`lib/resolve/confidence.ts:96`). The lookup usually lands under the floor
   and is recorded `unresolved`, having quietly answered a shallower question
   than the one asked.

TheTVDB carries episode data TMDB lacks, particularly for long-running and
recently-aired series. It should get a turn in exactly those two cases.

## Scope

In scope: the `tv` category only.

Out of scope, deliberately:

- **Movies.** Both triggers are tv-shaped -- a movie cannot have a missing
  season -- and TMDB is the stronger movie catalogue. A movie fallback would
  add a code path and a test surface to serve a case that rarely improves the
  answer.
- **Absolute ordering.** TheTVDB serves `/series/{id}/episodes/absolute`, which
  would help anime whose filenames carry absolute numbers. Real, but a separate
  path with its own parse concerns. Noted as a follow-up.
- **Re-routing `{tvdb-}` ids.** `providerForIdSource` sends them to TMDB, which
  translates via `/find`. That works and is not what is broken. It stays.
  A `{tvdb-}` id whose TMDB translation fails now falls through to this
  fallback anyway, which is a free improvement rather than a designed one.
- **Corroborating TMDB.** TheTVDB substitutes for TMDB; it never merges with
  it.

## The API

Base `https://api4.thetvdb.com/v4`. Verified live on 2026-09-20; the published
`swagger.yml` omits every per-record endpoint below, so these were confirmed by
request rather than read from the spec.

**Auth.** `POST /login` with `{"apikey": "..."}` returns a JWT in `data.token`,
valid 30 days (measured 30.4). No PIN is needed for this key. Every other call
takes `Authorization: Bearer <jwt>`.

**Endpoints used.** Two, and no more:

| Call | Purpose |
|---|---|
| `GET /series/{id}/episodes/default?season=N&episodeNumber=M` | Returns `{series, episodes}` -- the series record *and* the episode in one response |
| `GET /search?query=<title>&type=series` | Series candidates, each carrying `tvdb_id`, `name`, `year`, `first_air_time`, `overview`, `slug` |

`/search/remoteid/{id}` was evaluated and rejected: TMDB already publishes the
TVDB series id (below), so there is nothing to translate.

**Two schema traps.** `status` is an object (`{id, name, ...}`) on a series
record but a bare string on a search result. And a search result's `id` is
`"series-121361"` while `tvdb_id` is `"121361"` -- the bare id is the one to
use, as a string.

## The keystone

`lib/providers/tmdb/normalize.ts:113` already lifts `tvdb_id` out of TMDB's
series `external_ids` and records it as an `ExternalId`:

```ts
const tvdb = details.external_ids?.tvdb_id;
if (tvdb !== null && tvdb !== undefined) out.push({ source: 'tvdb', id: String(tvdb) });
```

So in the episode-miss case -- the common one -- the series identity is already
settled and handed over. No title search, no fuzzy matching: one call to
`/series/{tvdbId}/episodes/default` with the season and episode numbers the
filename gave. The search path exists only for the case where TMDB found
nothing and there is therefore no id to inherit.

## Architecture

A composite provider, so `lib/resolve/pipeline.ts` never learns that a second
provider exists. The pipeline selects exactly one provider
(`pipeline.ts:265`) and that stays true.

```
buildDeps('tv')
  └── createFallbackProvider(tmdb, tvdb)      implements Provider
        ├── name: 'tmdb'                      the provider it leads with
        ├── supports(c): delegates to tmdb
        └── resolve(parsed, ctx):
              outcome = await tmdb.resolve(...)
              if (!needsFallback(parsed, outcome)) return outcome
              return (await tvdb.resolve(...)) ?? outcome
```

`needsFallback` is a pure function over `(parsed, outcome)` -- no network, no
clock -- and carries the whole rule:

```
outcome === null                            -> true
parsed.kind is 'season' or 'episode'
  and depth(outcome.media.kind) < depth(parsed.kind)   -> true
otherwise                                   -> false
```

with `depth: series 1, season 2, episode 3`. That second clause is the
"TMDB answered a shallower question" case stated directly, and it covers a
missing season as well as a missing episode.

The fallback keeps TMDB's answer when TheTVDB returns nothing, so the
degenerate case is never worse than today.

### Why a composite

The two alternatives were a provider chain inside the pipeline, and a secondary
inside the TMDB resolver. The chain is more general -- a future books fallback
would come free -- but puts a tv-specific rule inside the file that owns
transactions, advisory locks and deadline handling, which is the code least
worth being wrong in. The secondary couples two catalogues and forces a TVDB
stub into TMDB's tests. The composite costs one small unit that is testable
with no network at all.

The one compromise: a composite must report some `Provider.name`, and reports
`'tmdb'`. That is the provider it leads with and whose ids `providerForIdSource`
routes to it, so the pipeline's id-based selection at `pipeline.ts:264` keeps
working unchanged. Each client records its own `provider_calls` rows, so call
attribution stays honest regardless.

## Resolution

Two entry paths, mirroring the shape `lib/providers/tmdb/resolve.ts` already
uses.

**By inherited series id.** `parsed.externalId` is not how the id arrives --
it comes from TMDB's own outcome -- so the composite passes it in. The TVDB
provider gains an optional `seriesRef` on its resolve call. One request to
`/series/{ref}/episodes/default?season=&episodeNumber=` yields the series and
the episode together.

**By search.** `GET /search?query=<parsed.title>&type=series`, candidates
scored with the existing `pickBest`, then the same episodes call against the
winner's `tvdb_id`.

### Confidence

No new bands. TheTVDB scores through `scoreCandidate`/`pickBest` in
`lib/resolve/confidence.ts`, the same scorer TMDB uses, by building a
`Candidate` from the TVDB series record:

| Candidate field | From |
|---|---|
| `title` | `name` |
| `originalTitle` | `null` |
| `year` | `year`, else the year of `first_air_time` |
| `originCountries` | `[]` -- TheTVDB gives 3-letter lowercase (`usa`) and `assertedCountry` produces 2-letter uppercase; passing it through would score a mismatch that is only an encoding difference |
| `popularity`, `voteCount` | `0` -- contributes under 0.002, which is the intent |
| `seasonExists`, `episodeExists` | `true` once the episode has been fetched |

This matters for correctness, not just tidiness: the `+0.12` for a confirmed
season *and* episode is exactly the evidence this feature produces, and it is
already in the scorer. Reusing it also means a TVDB answer and a TMDB answer
are directly comparable, which is what lets the composite substitute one for
the other honestly.

A sanity guard mirrors the one added to TPDB this week: if the parsed title
and the TVDB series name share nothing, the row is refused rather than scored.

### The returned chain

A complete TVDB chain -- series, then season, then episode -- so every row in
one chain carries one provider. The alternative, grafting a TVDB episode onto
TMDB's series, would mix providers within a single chain for no gain;
`media` is keyed `unique(provider, provider_ref)`, so one show existing as both
a TMDB row and a TVDB row is representable and honest, each being that
catalogue's own record.

TheTVDB has no separate season record in this flow, so the season row is
synthesised from the episode's `seasonNumber`, exactly as
`lib/providers/tmdb/normalize.ts` does for TMDB seasons.

## Files

New, under `lib/providers/tvdb/`, following the tmdb and tpdb layout:

- `client.ts` -- login, token cache, bearer calls, `provider_calls` recording,
  a courtesy rate bucket, and the error classes. `TvdbAuthFailed` extends
  `ProviderAuthFailed` so the sweeper can tell a bad credential from a slow
  network, as `TpdbAuthFailed` does.
- `schema.ts` -- zod for the two responses, `.nullish()` by default per the
  house rule in `lib/providers/tpdb/schema.ts`.
- `normalize.ts` -- TVDB records to `ResolvedMedia`.
- `resolve.ts` -- the provider, with its two entry paths.

Changed:

- `lib/providers/types.ts` -- `ProviderName` gains `'tvdb'`.
- `lib/db/schema.ts` + a generated migration -- the `provider` enum gains
  `'tvdb'`.
- `lib/providers/fallback.ts` (new) -- `createFallbackProvider`, `needsFallback`.
- `lib/http/envelope.ts` and `lib/jobs/sweep.ts` -- both build providers with
  the same `category === 'xxx' ? tpdb : tmdb` ternary, duplicated. A third
  provider does not fit that shape, so the construction moves to one shared
  factory both call. This is the "improve the code you are working in" case:
  the duplication is already a latent bug and this change is what exposes it.
- `.env.example` -- `TVDB_API_KEY`, documented as optional like `TPDB_API_KEY`.

## Token handling

The JWT is cached in process with its expiry, refreshed on expiry and on any
401. On serverless that means one `/login` per cold start, which is one extra
call on an instance that is about to make several -- acceptable, and cheaper
than a database round trip for a credential. Persisting it is a possible later
optimisation, not a requirement.

The token is never logged. `provider_calls` records the path only, never the
URL or headers, as the existing clients do.

## Failure and degradation

A missing `TVDB_API_KEY` is **not** an outage. The composite is built with the
secondary optional: if the credential is absent the composite degrades to TMDB
alone and logs once via `logFailure`, exactly as `envelope.ts:112` already does
for optional providers. Every tv lookup keeps working as it does today.

A TheTVDB error, timeout or 401 mid-resolve is caught inside the composite and
the TMDB outcome is returned instead. The fallback may only improve an answer,
never replace a working one with an error. `ctx.signal` is honoured so the
lookup deadline still applies across both providers.

## Testing

- `needsFallback` -- a table of parsed kind against returned kind. No network.
- `createFallbackProvider` -- stub providers: TMDB answers and TheTVDB is never
  called; TMDB returns null and TheTVDB answers; TheTVDB returns null and
  TMDB's answer survives; TheTVDB throws and TMDB's answer survives; the
  credential is absent and the composite is TMDB alone.
- `lib/providers/tvdb/*` -- stub client, as `test/providers/tpdb-resolve.test.ts`
  does: both entry paths, the season/episode chain, the sanity guard, the
  schema traps (`status` as object vs string, `id` vs `tvdb_id`).
- `client.ts` -- login once and reuse; re-login on 401; the token never appears
  in a recorded call.
- Live verification against the real API for the worked examples, as every fix
  this week has had.

## Success criteria

1. A tv filename naming a season or episode TMDB lacks resolves against
   TheTVDB, above the floor, with the episode as the returned media.
2. A tv filename TMDB cannot find at all resolves against TheTVDB when
   TheTVDB has it.
3. Every tv lookup that resolves today still resolves, to the same record, at
   the same confidence.
4. With `TVDB_API_KEY` unset, behaviour is byte-for-byte today's.
5. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all clean.
