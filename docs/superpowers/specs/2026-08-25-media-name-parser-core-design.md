# media-name-parser: core lookup service + tv/movies slice

Date: 2026-08-25
Status: approved design, not yet implemented

## Purpose

A caching service that answers one question: given a media category and a
filename, what specific piece of media is this?

Callers are media-library tools that hold a filename and need an identity.
The service parses the filename into tokens, resolves those tokens against a
category-appropriate metadata provider, stores the result, and serves it back
cheaply forever after. The cache is the product: the parse and the provider
round trips are the expensive parts, and neither should happen twice for the
same input.

## Scope

This spec covers the core contract and one vertical slice:

- The full database schema for all four categories (`tv`, `movies`, `books`,
  `xxx`), so later categories add rows and detail tables, not restructuring.
- Cache freshness semantics and the lookup API contract.
- The `tv` and `movies` categories end to end: filename parser, TMDB client,
  normalization, confidence scoring.
- Account registration, self-service API tokens, and a small UI.
- One real admin page, with the authorization plumbing that later admin tools
  will reuse.

Out of scope, each its own later spec: the `books` slice (ibdb.dev), the `xxx`
slice (theporndb.net), and cross-category fallback (see Non-goals).

## Non-goals

- **Cross-category fallback.** When a lookup fails in its declared category,
  the service does not retry in another. This is deliberate and temporary: it
  is a real future feature, and the `categoryDisagreement` flag described below
  exists to collect the evidence that would justify building it. Nothing in
  this design forecloses it.
- **Serving media files, artwork, or any binary.** The service returns
  metadata and provider references. Artwork URLs may be stored as part of the
  raw payload but are not proxied, downloaded, or hosted.
- **Resolving individual sporting events.** `tv.sport.raw.txt` is kept in the
  corpus and the parser is expected to tokenise it, but TMDB does not model
  rounds, prelims, or qualifying sessions as episodes, so most of it has no
  match to find. Sports is measured by parse rate only until a provider that
  models events is added.
- **Being a general metadata API.** The only entry point is a filename lookup.
  There is no browse, no search-by-title, no discovery.

## Decisions and their reasons

Recorded because the alternatives were live and the reasoning is not
recoverable from the code.

| Decision | Alternative rejected | Why |
|---|---|---|
| Class-table inheritance: one `media` table plus per-category detail tables | Single table with `details jsonb`; fully separate per-category tables | The jsonb variant puts the primary record beyond both DB constraints and type inference. Fully separate tables force `lookups` and `media_people` into polymorphic pointers with no real foreign key, and turn every cross-category query into a UNION — paying the cost at exactly the seam that matters most. |
| Hybrid sync-with-async-fallback on a miss | Pure sync; pure async with 202 + poll | Pure sync loses work to the function deadline. Pure async makes every consumer implement a two-call protocol for what is usually a cache hit. |
| Durable `lookup_jobs` table + `waitUntil` + cron sweeper | Vercel Workflow (WDK); `waitUntil` with no durable queue | The 12-hour staleness rule is already a retry mechanism, so the sweeper is a safety net for filenames nobody asks about twice — not the main road. That makes WDK's durability machinery more than the problem needs, and makes a plain table the honest size. |
| Caller's category beats parsed tokens | Tokens beat caller | `S02E04`-shaped markers occur in xxx releases and in litrpg book series. Trusting tokens over the caller would route those to the wrong provider entirely. |
| Exact `(category, name)` cache row pointing at a shared normalized parse | Normalized key only; exact string only | Keeping the literal input preserves the answer to "what did I say for this exact string", which is the first thing wanted when a match looks wrong. Sharing the parse means a second spelling of a release costs a parse, not a provider call. |
| Single best match plus confidence | Ranked candidate list; best match with no confidence | A candidate list pushes selection logic into every consumer and leaves the cache with no single answer to store. Dropping confidence makes a certain match indistinguishable from a guess, and makes a review UI impossible. |
| Better Auth with its tables in Neon | Clerk; Neon Auth; Auth.js/next-auth | Keeps `api_keys.user_id` a real foreign key to a real row, joinable in SQL. For a service whose entire value is its own data, external identity would put the owner of every token outside the database. Better Auth over Auth.js on two counts: Auth.js stewardship passed to the Better Auth project, and Vercel acquired Better Auth on 2026-07-07, so Auth.js is now the legacy path; and `better-auth@1.7.1` is stable where `next-auth@5` remains `5.0.0-beta.32`. |

## Architecture

Next.js App Router on Vercel, Neon Postgres, Drizzle ORM over
`@neondatabase/serverless`, Better Auth for identity.

```
app/
  api/v1/lookup/route.ts          POST — the lookup endpoint
  api/v1/lookup/[id]/route.ts     GET  — poll a pending lookup
  api/v1/media/[id]/route.ts      GET  — full record with parents and people
  api/v1/health/route.ts          GET
  api/cron/sweep/route.ts         GET  — Vercel Cron target
  api/auth/[...all]/route.ts           Better Auth handler
  api/keys/route.ts                    token create/revoke (session auth)
  (app)/page.tsx                       lookup form
  (app)/corpus/page.tsx                corpus runner
  (app)/keys/page.tsx                  token management
  (admin)/admin/cache/page.tsx         cache browser
lib/
  db/         schema.ts, client.ts, migrations/
  parse/      normalize.ts, tokens.ts, video.ts, types.ts
  providers/  types.ts, tmdb/{client,resolve,normalize}.ts
  resolve/    pipeline.ts, confidence.ts
  cache/      lookup.ts
  auth/       session.ts, apiKey.ts, roles.ts
  jobs/       claim.ts, sweep.ts, backoff.ts
```

Each unit has one job and a stated dependency direction:

- `lib/parse/*` is pure. Filename in, discriminated union out. No database, no
  network, no clock.
- `lib/providers/*` talks to exactly one external service and returns a
  provider-agnostic `ResolvedMedia`. **A provider never touches the database.**
  This is the seam that makes the books and xxx slices new files rather than
  new plumbing.
- `lib/resolve/pipeline.ts` is the only module that composes parse, provider,
  and persistence. It is called from the request path and from the sweeper,
  differing only in the deadline it is given.
- `lib/cache/lookup.ts` owns the freshness rules and nothing else, so they are
  testable without a provider or a parser.

## Request flow: POST /v1/lookup

1. `Authorization: Bearer` token, SHA-256 hashed, looked up in `api_keys`.
   Resolves the user and the per-key rate limit.
2. Zod-validate the body. `name` may be a bare filename or a path.
3. `normalizedKey = normalize(category, name)`.
4. Read `lookups` by `(category, name)`:
   - **Resolved with `confidence >= 0.75`** — return it, bump `hit_count` and
     `last_hit_at`. No external work.
   - **Incomplete, `last_attempt_at` within 12 hours** — return current data
     with `partial: true`. No external work.
   - **Otherwise** — resolve.
5. Resolve under a deadline (default 8s, `LOOKUP_DEADLINE_MS`), with one
   `AbortController` threaded through every provider fetch:
   1. Parse to a `ParsedName`. Upsert `parses`.
   2. **Sibling adoption.** If another `lookups` row shares this
      `(category, normalized_key)` and is already resolved, adopt its
      `media_id` and stop. No provider call.
   3. Take `pg_advisory_xact_lock(hashtext(category || ':' || normalizedKey))`,
      so two concurrent misses for one release make one set of provider calls.
   4. Search, score candidates, pick the best.
   5. Upsert media, parents, people, and raw payloads idempotently on
      `(provider, provider_ref)`. Link the `lookups` row, set `confidence`,
      `resolved_at`, `state`.
6. **Deadline trips mid-resolution** — respond `202` with whatever exists and
   `partial: true`, upsert a `lookup_jobs` row, and `waitUntil()` the
   remainder so it usually completes anyway.
7. Cron, once a minute, sweeps `lookup_jobs`.

A `pinned` lookup is never re-resolved regardless of staleness.

### Batch form

`POST /v1/lookup` also accepts `{ items: [{ category, name }, ...] }`, capped
at 100 entries. Cache hits resolve inline; misses are enqueued. The corpus
runner would otherwise be an N-request storm.

The batch response is always `200` with `{ "results": [ … ] }`, one entry per
input in input order, each entry being the same envelope as a single lookup
plus its own `status` field. The transport succeeded even when individual
items are still resolving, so a per-item status is the honest shape; a top
level `202` would force callers to re-inspect every entry anyway.

### Concurrency and idempotency

Correctness does not depend on the advisory lock. Every write is an upsert on a
natural key, so two racing resolvers converge on the same rows; the lock is a
cost optimization that prevents the duplicate provider calls. If the lock is
ever contended past the deadline, the request takes the partial path.

## Data model

### Identity and access

Better Auth owns four core tables, named and shaped by the library rather than
by us: `user`, `session`, `account`, `verification` — all singular, all with
`text` primary keys, because Better Auth generates its own string ids. Two
differences from the Auth.js shape they replace are worth naming, because both
would otherwise be silent bugs: `user.emailVerified` is a **boolean**, not a
nullable timestamp, and `session` carries its own `id` plus a unique `token`
rather than using the token as its primary key.

The `admin` plugin extends those tables with `user.role`, `user.banned`,
`user.banReason`, `user.banExpires`, and `session.impersonatedBy`. `role` is a
**text** column, not a Postgres enum, because the plugin treats it as a string
and supports comma-separated multiple roles; constraining it in the database
would fight the library for no gain. The plugin also supplies
`createAccessControl` and `hasPermission`, which is what `requireAdmin()` is
built from.

Sign-in is the GitHub social provider plus the `magicLink` plugin.

Because the library owns those four tables' shape, the schema is verified
against `getAuthTables()` at test time rather than trusted — see Testing.

Our own two tables, which Better Auth does not provide — 1.7.1 ships no
API-key plugin, so this is not a case of ignoring one:

```
api_keys              id, user_id FK user(id) [text], label,
                      token_hash (sha256, indexed), prefix (8 chars, display only),
                      rate_limit_per_min, last_used_at, revoked_at, created_at
rate_limit_windows    api_key_id FK, window_start timestamptz, count int
                      PK (api_key_id, window_start)
```

`user_id` is `text` rather than `uuid` to match Better Auth's id type. Nothing
is gained by overriding its id generation, and a mismatched foreign-key type
would be a real cost.

Token format is `mnp_<prefix>_<secret>`. Only the hash is stored; the secret is
shown once at creation and never again. Rate limiting is an upsert per request
against `rate_limit_windows`, using fixed one-minute windows
(`window_start` truncated to the minute), chosen over Redis because it adds no
dependency and the counters stay inspectable in SQL. Fixed windows rather than
a sliding log because the failure mode — a caller getting up to double its
limit across a window boundary — is cheaper than a per-request log table. Redis is the upgrade if request
volume ever makes the write visible.

### Media

```
media          id uuid PK
               category enum('tv','movies','books','xxx')
               kind     enum('movie','series','season','episode','book','scene')
               parent_id uuid NULL FK media(id) ON DELETE CASCADE
               title, sort_title, original_title NULL
               release_date date NULL, year int NULL, overview text NULL
               provider enum('tmdb','ibdb','tpdb')
               provider_ref text NOT NULL
               raw jsonb NOT NULL, raw_fetched_at timestamptz NOT NULL
               created_at, updated_at
               UNIQUE (provider, provider_ref)
               INDEX (category, kind), INDEX (parent_id), INDEX (sort_title)
```

`provider_ref` is the natural key that makes every upsert idempotent and
dedupes across filename spellings: `tmdb:movie:603`, `tmdb:tv:1396`,
`tmdb:tv:1396:2`, `tmdb:tv:1396:2:4`. The episode form also enforces episode
uniqueness without a separate composite constraint.

`sort_title` is derived from `title` by stripping a leading article. `year` is
denormalized from `release_date` for cheap filtering in the admin browser.

Detail tables, each keyed 1:1 on `media_id`:

```
movie_details    runtime_minutes, imdb_id, tagline, collection_name
series_details   first_air_date, last_air_date, status
season_details   season_number
episode_details  season_number, episode_number, air_date
book_details     isbn13, isbn10, publisher, published_on, page_count, language
scene_details    site_name, duration_seconds, released_on
```

`book_details` and `scene_details` are created with this schema and populated
by their later slices. They exist now so those slices add no migrations to
shared tables.

### People

```
people         id uuid PK, provider, provider_ref, name, sort_name,
               aliases text[], birthdate date NULL,
               raw jsonb, raw_fetched_at
               UNIQUE (provider, provider_ref), INDEX (sort_name)
media_people   media_id FK, person_id FK,
               role enum('performer','director','producer','writer',
                         'author','illustrator','narrator'),
               character_name NULL, billing_order NULL
               PK (media_id, person_id, role, COALESCE(character_name, ''))
               INDEX (person_id)
```

Roles are rows, not columns, so xxx performers and book illustrators need no
schema change.

### Cache

```
parses         PK (category, normalized_key)
               tokens jsonb NOT NULL, parser_version int NOT NULL,
               created_at, updated_at
lookups        id uuid PK, category, name text NOT NULL,
               normalized_key text NOT NULL,
               media_id uuid NULL FK media(id),
               confidence real NULL,
               pinned boolean NOT NULL DEFAULT false,
               state enum('resolved','unresolved','pending'),
               last_attempt_at, resolved_at, hit_count, last_hit_at, created_at
               UNIQUE (category, name)
               FK (category, normalized_key) → parses
               INDEX (category, normalized_key), INDEX (state, last_attempt_at)
lookup_jobs    id uuid PK, lookup_id FK UNIQUE,
               state enum('pending','running','abandoned'),
               attempts int, last_error text NULL,
               next_attempt_at timestamptz NOT NULL,
               locked_at, locked_by, created_at, updated_at
               INDEX (state, next_attempt_at)
provider_calls id, provider, endpoint, status, duration_ms,
               lookup_id NULL, created_at
               INDEX (created_at)
```

`parses` is keyed on `(category, normalized_key)` rather than the key alone
because the same string parses differently under different categories.

`parser_version` is a compile-time constant. Raising it makes every stored
parse eligible for a **re-parse**, which is local and free. The re-parse is
lazy, not a migration: it happens on the next lookup request for that row,
before the freshness rules are applied, whenever the stored `parser_version` is
below the current one. If the new tokens differ from the stored ones, the
lookup is treated as incomplete and re-resolves; if they match, only
`parser_version` is updated and the cached answer is served as normal. This is what turns a
growing corpus into leverage over already-cached rows.

A job row exists only while work is outstanding. On success it is **deleted** —
the `lookups` row is the record of the outcome, and keeping a parallel copy
invites the two disagreeing. A retryable failure stays `pending` with
`attempts` incremented, `last_error` set, and `next_attempt_at` pushed out.
Only a terminal failure — a non-retryable provider error, or `attempts`
exceeding `JOB_MAX_ATTEMPTS` — becomes `abandoned`, which is the one state that
persists for a human to look at. `running` exists solely to hold a sweeper's
lease.

`provider_calls` is retained 30 days and pruned by the same cron that sweeps
jobs. `rate_limit_windows` rows older than two windows are pruned there too.

## Parsing

`normalize(category, name)` splits on path separators, takes the basename as
primary and keeps ancestors as hint sources, strips a known media extension,
lowercases, strips bracketing characters (`[]`, `()`, `{}`), collapses
separator runs to single spaces, and trims. Pure and
deterministic; its output is `normalized_key`.

`lib/parse/tokens.ts` holds the shared vocabulary — resolution, source,
codec/audio/container/HDR/fps ancillaries, language terms, edition terms,
trailing release group, website prefixes — adapted from pickarr's
`packages/plugin-scenes/src/parse.ts` (MIT, same author).

The structural technique carried over from that file is the **backwards walk**:
find the title boundary by walking from the end of the name over the run of
closed-vocabulary tokens, rather than by locating a marker. Pickarr's comments
document three failed attempts at marker-based rules before this one. The
failure mode is not xxx-specific — `Alien: Covenant`, a series called `Web`,
and `The 4400` each break a forward or best-occurrence rule.

Recognised extensions are `mkv mp4 avi wmv mov m4v mpg mpeg flv ts webm iso
m2ts nzb`. `iso` and `m2ts` are the two most common extensions in the live
movie corpus, and `nzb` covers every entry in the indexer corpora; a parser
missing them would refuse the majority of real input. `nfo srt sub idx
plexmatch` and any dotfile are recognised **in order to refuse** — a clean
refusal is the correct answer for a subtitle or a Plex sidecar.

### Three naming grammars

The corpus contains three unrelated conventions, and the parser must read all
three:

1. **Scene/indexer** — dot-separated, quality as bare tokens, group after a
   trailing hyphen: `The.Sting.1973.1080p.NF.WEB-DL.AAC2.0.H.264.DUAL-RiPER`.
2. **Bracketed** — title, then bracketed year, then a bracketed junk block:
   `John.Wick-Chapter.3-Parabellum.[2019].[1080p.BluRay.x265...-DarQ.HONE]`.
3. **Sonarr/Plex library** — space-separated, ` - ` field separators, quality
   as `Source-Resolution`: `Moon Knight - S01E03 - The Friendly Type
   Bluray-2160p Remux.mkv`.

`lib/parse/video.ts` handles `tv` and `movies` in one parser, because deciding
which shape a name has is part of the job:

1. Strip website prefix and extension; detach trailing release group.
2. Walk backwards over the junk run to find the title boundary, collecting
   quality tokens.
3. Search the head for episode markers, in priority order: `S02E04`,
   `S02.E04`, `S02E04E05` and `S02E01-E02` (both multi-episode forms),
   `2x04`, `Season 2 Episode 4`; then date-based `2024-03-15` or `2026.08.24`
   for dailies; then bare `S02`; then absolute numbering (`- 104 -`), which
   parses but carries a confidence penalty.

   The marker is the **anchor**, never a field index. A library name like
   `Star Trek - Prodigy - S02E01-E02 - Into the Breach Bluray-1080p Remux.mkv`
   has a series title containing the same ` - ` that separates Plex's fields,
   so splitting on the separator cannot work: the title is whatever precedes
   the marker and the episode title is whatever follows it.

   Season `00` is valid and means a special (`/Specials/... - S00E22 - ...`).
   Season numbers are not bounded — the corpus has `Season 43`.
4. Marker found — `episode` or `season`; title is the text before it, and
   trailing text becomes a candidate episode title.
5. No marker — `movie`; find a year in 1900–2099 and cut the title there.
6. **Directory hints.** When the basename alone yields no title
   (`s02e04.mkv`, `04 - Episode Name.mkv`), walk ancestors: `Season 02`
   supplies the season, the grandparent usually supplies the series and
   sometimes the year. Likewise `Movie Name (2010)/movie.mkv`.

Output is a discriminated union:

```ts
type ParsedVideo =
  | { kind: 'movie';   title: string; year: number | null; … }
  | { kind: 'series';  title: string; year: number | null; … }
  | { kind: 'season';  title: string; seasonNumber: number; … }
  | { kind: 'episode'; title: string; seasonNumber: number | null;
                       episodeNumbers: number[]; airDate: string | null;
                       episodeTitle: string | null; … }
```

each carrying `quality`, `edition[]`, `group`, `hints.fromDirectories[]`,
`categoryDisagreement: boolean`, and `refusal: string | null`.

### Cases the corpus forced

Each of these appears in `fixtures/corpus/` and each would be parsed wrongly by
an obvious rule:

- **Year-as-season.** `Koln.50667.S2013E015` uses the broadcast year as the
  season and a running counter as the episode; `Tipping.Point.AU.S2026E110` and
  `Millionaire.Hot.Seat.AU.S2026.08.25` are variations. A four-digit season is
  therefore parsed as a **year-season**, flagged as such, and resolved by air
  date or absolute number rather than by asking a provider for season 2013.
- **Disc, not episode.** `Jimmy.Neutron...FULLSCREEN.S03D03` and `DISC1` name
  a DVD disc. A disc is a slice of a season, and no provider models discs, so
  these parse as `kind: 'season'` with a `discNumber` hint. Resolving a disc to
  an episode would be a confident wrong answer.
- **Two trailing group-shaped segments.** In
  `...HEVC.DTS-HD.MA.5.1-FraMeSToR.DUAL-LACTATO` the group is `FraMeSToR`;
  `DUAL-LACTATO` is a dual-audio re-release tag. Taking the text after the last
  hyphen gets it wrong.
- **Hyphens inside titles.** `John.Wick-Chapter.3-Parabellum` and
  `Star Trek - Prodigy` are the same trap from the other side, and together
  with the case above they are why group detection anchors to the junk run
  rather than to any hyphen.
- **Contradictory quality tokens.** `Cold.Storage.2026.UHD.BluRay.1080p...`
  declares a UHD source at 1080p. The explicit resolution token wins.
- **Directory-only titles.** 54 lines of `movies.library.raw.txt` have a
  basename like `00136.m2ts`, a raw Blu-ray stream. The parent directory
  (`Interstellar (2014)`) is the sole source of both title and year.
- **Directory disambiguators.** Series folders carry provider
  disambiguators — `Ghosts (2019)` and `Ghosts (US)` coexist in one library,
  as do `Jeopardy! (UK)` and `Celebrity Jeopardy!`. A parenthesised year or
  region in an ancestor is a search hint, not part of the title.
- **Split hint sources.** `TV Shows/Wheel of Fortune/Season 43/Wheel of
  Fortune - 2026-03-23 - Hawaiian Vacation 1 WEBDL-1080p.mkv` takes its season
  from the directory and its air date from the basename. A single lookup may
  need both.
- **Unicode.** `90 Day Fiancé` and `What If…!` require NFC normalisation and
  diacritic folding **for matching only**; the stored title keeps its
  characters.
- **Dots inside titles.** `Marvel's Agents of S.H.I.E.L.D` is harmless
  space-separated and hostile in the scene form. Acronym runs of
  single-letter dot-separated tokens are rejoined rather than treated as
  separators.

Two deliberate departures from pickarr:

- **Refusal is returned, not module-global.** Pickarr reads a module-level
  `let` via `lastRefusalReason()`. That is safe in a single-threaded worker and
  unsafe under concurrent request handling, so it moves onto the return value.
- **The declared category fixes the search namespace.** The parser still
  extracts whatever shape it sees, but a `movies` lookup searches TMDB's movie
  namespace even when the tokens look episodic. A mismatch sets
  `categoryDisagreement`, which is queryable in the admin browser and is the
  evidence base for the cross-category fallback named in Non-goals.

## Resolution

```ts
interface Provider {
  readonly name: 'tmdb' | 'ibdb' | 'tpdb';
  supports(category: Category): boolean;
  resolve(parsed: ParsedName, signal: AbortSignal): Promise<ResolvedMedia | null>;
}
```

`ResolvedMedia` is a provider-agnostic tree of media rows, detail records,
people, and raw payloads. The pipeline persists it.

TMDB paths:

- **movie** — `search/movie?query&year`, score candidates,
  `movie/{id}?append_to_response=credits`. Yields one media row,
  `movie_details`, and director, writers, and top-N cast.
- **episode** — `search/tv?query`, score, `tv/{id}` for the series,
  `tv/{id}/season/{n}` for the season **and every episode in it** in one call,
  then episode credits for the target. Fetching the whole season means the
  rest of a show's files resolve with no further search calls.
- **date-based episode** — match `air_date` within the fetched season.

**Multi-episode files.** A name like `s02e04e05` parses to
`episodeNumbers: [4, 5]`, but a lookup resolves to a single media row: the
first episode in the list. The full list is preserved in the parse tokens and
returned on the response, so a caller that cares can see the file spans two
episodes. Modelling a file as pointing at several media rows would mean a join
table on `lookups`, and a stated limitation is the better trade until something
needs it.

Every fetch receives the `AbortSignal` and is logged to `provider_calls`.
TMDB's published limit is generous enough that an in-process token bucket plus
the advisory lock suffices; no distributed limiter.

### Confidence

`lib/resolve/confidence.ts` is a pure function returning a score in `[0, 1]`.

- Normalized title similarity against `title` and `original_title` — the
  dominant term.
- Year: exact match a strong boost, ±1 a mild one (release-year skew between
  a provider's date and a release group's label is common), mismatch a strong
  penalty.
- For episodes: whether `(season, episode)` actually exists on the candidate
  series. Near-decisive.
- Popularity as a **tiebreak only**. As a primary term it resolves every
  ambiguous title to whatever is most famous.
- Penalties when the title came from a directory hint, when absolute numbering
  was used, or when the parse emitted a refusal.

The floor is 0.75 (`CONFIDENCE_FLOOR`). Below it, the best candidate is still
stored with its score and the lookup is marked `unresolved` — inspectable, and
retried by the 12-hour rule. With no match at all, `media_id` stays null, the
parse is still stored, and the response returns tokens only; the tokens alone
are a useful answer.

## API

Versioned under `/v1`. Errors are `application/problem+json`.

`POST /v1/lookup` — body `{ category, name }` or `{ items: [...] }`.

```json
{
  "lookupId": "…",
  "state": "resolved",
  "partial": false,
  "cached": true,
  "confidence": 0.93,
  "parsed": {
    "kind": "episode", "title": "Show Name",
    "seasonNumber": 2, "episodeNumbers": [4], "group": "GRP",
    "categoryDisagreement": false
  },
  "media": {
    "id": "…", "kind": "episode", "title": "…", "releaseDate": "2024-03-15",
    "provider": "tmdb", "providerRef": "tmdb:tv:1396:2:4",
    "details": { "seasonNumber": 2, "episodeNumber": 4 },
    "parents": [ { "kind": "series", "title": "Show Name" },
                 { "kind": "season", "title": "Season 2" } ],
    "people": [ { "name": "…", "role": "director" } ]
  }
}
```

`202` with `Retry-After` when partial and still resolving.
`GET /v1/lookup/{id}` returns the same envelope.
`GET /v1/media/{id}` returns a full record with parents and people.
`GET /v1/health` reports database reachability and migration version.

Status codes: `400` malformed input, `401` missing or bad token, `403`
insufficient role, `404` unknown id, `429` rate limited (with
`Retry-After`), `503` database unreachable.

## UI

Tailwind with a small number of shadcn/ui primitives. Four pages:

- `/` — lookup form: category select and name input; result shows parsed
  tokens, the match, confidence, people, and a cached-versus-fetched badge.
- `/corpus` — paste or upload newline-delimited names for one category, run
  them as a batch, show per-row results plus aggregate parsed %, resolved %,
  and mean confidence.
- `/keys` — create and revoke API tokens; the secret is shown once.
- `/admin/cache` — paginated cache browser filterable by category, state,
  confidence band, and `categoryDisagreement`.

`/admin` is guarded by `requireAdmin()` in **both** the segment layout and
each route handler. A layout check alone controls navigation, not
authorization.

## Failure handling

- Provider `429` or `5xx` — the request does not fail. Mark the lookup
  `unresolved`, upsert a job, back off exponentially with jitter.
- Provider **auth** failure — not retryable. The job goes to `abandoned` with
  `last_error` set, so the sweeper does not grind against a bad key.
- Deadline reached — partial `202`. Never a `504`.
- Malformed input — `400` problem+json naming the offending field.
- Database unreachable — `503`, no in-request retry.
- Job exceeding max attempts — `abandoned`, visible in the admin browser.

Every caught error either writes `lookup_jobs.last_error` or is logged with
the lookup id. Nothing is swallowed: a cache that silently serves a wrong
answer is worse than one that errors.

## Testing

- **Raw corpora.** One API input per line — a bare release name or a
  library-relative path, exactly as a caller would send it. Uncurated by
  design: sidecar files, discs, sports, and misspelled titles are the entries
  worth having. Duplicates are kept deliberately, because two spellings of one
  release are what exercise normalisation and sibling adoption. Committed as:

  | File | Lines | Shape |
  |---|---|---|
  | `fixtures/corpus/movies.releases.raw.txt` | 1200 | indexer release names, `.nzb` |
  | `fixtures/corpus/movies.library.raw.txt` | 408 | live library paths, `.iso`/`.mkv`/`.m2ts` |
  | `fixtures/corpus/tv.releases.raw.txt` | 800 | indexer release names, `.nzb` |
  | `fixtures/corpus/tv.library.raw.txt` | 3343 | live Plex/Sonarr paths |
  | `fixtures/corpus/tv.sport.raw.txt` | 200 | indexer sports release names |

  A coverage test asserts that **two independent rates** over each file do not
  regress: a **parse rate** (did the parser produce well-formed tokens or an
  intentional refusal) and a **resolve rate** (did those tokens reach a
  provider match). They are reported separately because for much of
  `tv.sport.raw.txt` — `UFC.Fight.Night.285...Prelims`,
  `IMSA...Round09...Qualifying` — a correct parse with no provider match is the
  **right** outcome, and folding that into a single number would mask genuine
  parser regressions. See Non-goals.
- **Golden corpus.** `fixtures/corpus/<category>.golden.jsonl`, one
  `{ name, expected }` per line, where `expected` is a full `ParsedVideo` —
  or `null` alongside `expectedRefusal` when refusing is correct. Derived from
  the raw corpus by running the parser and reviewing its output, then
  committed as the regression baseline and driven by a single table test.
  Parser regressions surface as readable diffs.

  Expectations cover **the parse only, never provider fields**. Providers
  edit episode titles and adjust release dates; a golden file asserting them
  would fail on the provider's schedule rather than on ours. Match accuracy is
  measured separately, against the recorded fixtures and any optional `ref`
  values supplied with a raw corpus entry.
- **Recorded provider fixtures.** `fixtures/tmdb/` keyed by request URL and
  served by a `fetch` stub, so the suite is offline and deterministic.
- **Unit, pure and table-driven.** `normalize`, `video`, `confidence`,
  `backoff`, and the `cache/lookup` freshness rules.
- **Schema conformance.** A test compares the hand-written Drizzle definitions
  for `user`, `session`, `account`, and `verification` against
  `getAuthTables({ plugins: [admin()] })` from `better-auth/db`. Better Auth
  owns that shape, so a version bump that adds or renames a field fails a test
  rather than failing at runtime.
- **Integration.** Route handlers against a Neon branch created at the start
  of a CI run and dropped at the end. The advisory lock and
  `FOR UPDATE SKIP LOCKED` are the code a fake database will not exercise,
  and they are the code most worth covering.

No end-to-end browser suite in this slice.

Per project policy, no work is complete until lint, type-check, tests, and
build all pass.

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string (pooled) |
| `DATABASE_URL_UNPOOLED` | direct connection, for migrations |
| `TMDB_API_KEY` | TMDB v3 key |
| `BETTER_AUTH_SECRET` | Better Auth signing secret |
| `BETTER_AUTH_URL` | canonical app origin |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub social provider |
| `CRON_SECRET` | shared secret for the sweep endpoint |
| `LOOKUP_DEADLINE_MS` | inline resolution deadline, default 8000 |
| `STALE_AFTER_HOURS` | re-lookup threshold, default 12 |
| `CONFIDENCE_FLOOR` | resolved threshold, default 0.75 |
| `JOB_MAX_ATTEMPTS` | sweeper attempts before `abandoned`, default 6 |

`ibdb.dev` and `theporndb.net` keys are added by their own slices.

## Success criteria

1. A cache hit for a resolved lookup makes zero provider calls and one
   database round trip.
2. An incomplete lookup attempted within the last 12 hours makes zero
   provider calls.
3. A cold `movies` lookup resolves to a TMDB movie with people attached, and
   a second filename for the same release differing only in separators or
   bracketing (`Movie.Name.2010.1080p.mkv` versus
   `Movie Name (2010) [1080p].mkv`) resolves with no additional provider
   call.
4. A cold `tv` lookup resolves to an episode with its season and series as
   parents; further episodes of the same season need no further search call.
5. A lookup exceeding the deadline returns `202` with parsed tokens, and the
   job completes via `waitUntil` or the cron sweeper.
6. A user can register, mint an API token, and use it against `/v1/lookup`.
7. A non-admin receives `403` from `/admin/cache`; an admin can filter it by
   confidence band and by `categoryDisagreement`.
8. `Movies/Interstellar (2014)/00136.m2ts` resolves correctly, with title and
   year taken entirely from the parent directory.
9. `TV Shows/Ghosts (US)/Season 1/...` and `TV Shows/Ghosts (2019)/Season 1/...`
   resolve to two different TMDB series.
10. Parse rate and resolve rate are reported separately for every raw corpus
    file, and both are recorded as the baseline the coverage test defends.
11. Lint, type-check, the full test suite, and the production build all pass.
