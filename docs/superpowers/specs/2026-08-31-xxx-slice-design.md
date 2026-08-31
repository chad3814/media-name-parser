# The xxx slice: parsing and validating scene names

**Date:** 2026-08-31
**Status:** approved for planning
**Parent spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`,
which defers "the `xxx` slice (theporndb.net)" to its own spec. This is that spec.

## Purpose

Teach the parser the xxx naming grammar and validate it against 12,815 real
names, producing a golden file and baseline metrics the way `movies` and `tv`
already have.

**This slice is parse-only.** theporndb.net resolution -- the provider client,
`scene_details` population, and performers as `people` rows -- is a later slice.
Nothing here makes a network call.

## Non-goals

- **The theporndb.net provider.** Deferred entirely.
- **Splitting performers out of the name.** Deferred to the resolver slice, for
  reasons recorded under "Performers" below. This is a decision, not an
  omission.
- **Cross-category fallback.** The caller's category fixes the shape, per the
  parent spec's Non-goals.
- **New tables or migrations.** `scene_details (site_name, duration_seconds,
  released_on)` already exists at `lib/db/schema.ts:162`, created ahead of time
  by the core schema so this slice adds no migration. This slice does not write
  to it -- the resolver slice does.

## The corpus

Source: `xxx.corpus.txt` at the project root, supplied by the project owner --
a listing of a live library plus indexer results. Filenames only; no file
contents are involved.

Preparation, to be done once by a script and committed:

| Step | Count |
|---|---|
| Raw lines | 13,889 |
| After removing exact duplicates | 12,878 (1,011 dropped) |
| After removing Usenet post subjects | 12,815 (63 dropped) |
| → `fixtures/corpus/xxx.library.raw.txt` | 5,835 |
| → `fixtures/corpus/xxx.releases.raw.txt` | 6,980 |

The 63 excluded lines are Usenet post subjects, not filenames:
`(Zink) - AnalMom.26.07.11.Katie.Morgan.XXX.2160p - [03/98] - AnalMom.26.07.11.Katie.Morgan.XXX.2160p.nzb`.
They are excluded for a mechanical reason, not a stylistic one: the part
counter `[03/98]` contains a slash, so `splitInput` would read `[03` as a
directory name and `98]` as part of the path. They come from a single poster
and are 0.5% of the corpus. If the service is ever fed indexer subjects
directly, unwrapping them is a separate concern for the HTTP boundary, not the
parser.

The split into `.library.` and `.releases.` follows the existing convention:
lines containing a path separator are library form, the rest are release form.

### What the corpus shows

Measured over the 12,815 kept lines:

- **9,910 (77.3%)** match `<site> . <date> . <rest>` anchored at the start of
  the basename -- 9,280 with a two-digit year, 630 with a four-digit one.
- **2,905 (22.7%)** do not. Of those, **1,698** are library form, where the
  parent directory supplies the site; **1,207** are bare names with no site
  source at all.
- **Every** library line sits under a single top-level `Scenes/` directory.
  5,817 are exactly `Scenes/<Site>/<file>`; 17 carry one extra level and 1 has
  no site directory at all.
- Where a library line has both, the parent directory matches the
  head-before-date **81%** of the time. The two sources corroborate.
- Extensions: `nzb` 6,930, `mp4` 5,799, `mkv` 19, `mov` 5, `avi` 3, `jpg` 8,
  and 51 with no extension. `mkv` dominance is inverted from movies/tv, where
  `iso` and `mkv` lead.
- `SxxExx` appears **11** times. The tv marker is effectively absent; the
  backwards-walk machinery movies and tv need is not what this grammar turns
  on.
- Dot-dominant separators: 12,958 of 13,889 raw (93%). Bracketed names: 135.
  Grammar #2 from the parent spec (bracketed) barely occurs here.

### The date convention

`YY.MM.DD`, two-digit year. Verified rather than assumed, over 9,368
two-digit triples:

- Reading them as `YY.MM.DD` puts a value over 12 in the month field **154**
  times (1.6%).
- Reading them as `YY.DD.MM` puts a value over 12 in the month field **5,921**
  times (63%).

`YY.MM.DD` therefore holds, and the 1.6% are date-shaped strings that are not
dates. The year field distribution confirms it independently: `26`→5,467,
`25`→1,226, `24`→722, `23`→354, declining smoothly to `15`→53.

Four-digit `YYYY.MM.DD` also occurs (726 raw) and is accepted.

## Approach

A new file, `lib/parse/scene.ts`, holding a `parseScene` that the existing
`parseVideo` dispatches to on `category === 'xxx'`. `parseVideo` already takes
a `Category` and already branches on it, so it is the router; the parent spec
names this seam as "the seam that makes the books and xxx slices new files
rather than restructuring."

Two alternatives were considered and rejected. Mapping scenes onto the
existing `episode` variant (site as title, date as `airDate`) needs no new
types, but `media_kind` already has `scene` and `scene_details` already has
`site_name`/`released_on`, so the resolver slice would have to undo the
mapping. A wholly separate entry point outside the `ParsedVideo` union types
more honestly -- a scene is not a video with episodes -- but `toEnvelope`, the
golden test, and the corpus report all consume `ParsedVideo`, so it forks
three call sites for no gain in a parse-only slice.

### Division of labour

`parseVideo` keeps the extension gate it already has: `splitInput`, then the
`isMedia` refusal for sidecars, unknown extensions, and dotfiles. Only after
that does it dispatch. `parseScene` therefore receives a `SplitInput` and never
re-implements refusal logic.

```
parseVideo(category, input)
  ├─ splitInput(input)                      shared, already trims
  ├─ refuse unless split.isMedia            shared, quotes the extension
  └─ category === 'xxx' ? parseScene(split) : <existing movies/tv path>
```

## The parsed shape

One new variant on the `ParsedVideo` union in `lib/parse/types.ts`:

```ts
| (ParsedCommon & {
    readonly kind: 'scene';
    /** The producing site. From the name's head, else the parent directory. */
    readonly site: string | null;
    /** ISO `YYYY-MM-DD`. Null when the name carries no date. */
    readonly releasedOn: string | null;
  })
```

`ParsedCommon` already carries `title`, `year`, `quality`, `edition`,
`language`, `group`, `hints`, and `categoryDisagreement`, so a scene adds
exactly two fields. `hints.fromDirectories` already exists and is where the
parent directory is recorded.

### The date rule

Deterministic, with no clock. `YY` maps to `20YY` unconditionally; `month` must
be 1-12 and `day` must be 1-31, and a triple failing either is not a date and
is left in the title. Sanity-checking a year against today's date would make
the parser non-deterministic, and `normalized_key` is derived from the parse --
a parser whose output depends on when it ran would produce two cache keys for
one name.

Three further rules, each chosen for determinism over cleverness:

- All three components are required. `2026.07.Cleo.Mercury...` has a year and a
  month but no day, and is not treated as a date.
- The date must be anchored at the start of the basename, after the site. A
  date appearing mid-name (33 occurrences) is left in the title.
- `releasedOn` is formatted `YYYY-MM-DD`, matching `scene_details.released_on`.

### Site resolution

Precedence, highest first:

1. The run before the date in the basename.
2. The nearest ancestor directory, when the basename has no site (library
   form). Nearest rather than "the directory under `Scenes/`", so the rule
   carries no knowledge of one library's layout; the cost is that for the 17
   lines nested a level deeper, the nearest ancestor is a subdirectory rather
   than the site.
3. `null`.

The filename wins because a release name is per-release while a directory is a
filing choice. Every ancestor is recorded in `hints.fromDirectories`
regardless of which source won, so a resolver sees both, a disagreement is
inspectable rather than lost, and the deeper-nested cases still carry the true
site one level up. This matters for 1,698 lines where the directory is the only
site source.

### Title extraction

For an anchored name, the run after the date is *already known to be
title-only*, which is precisely the contract of the existing
`findTitleRegion`. Its docstring warns against using `findBoundary` there,
because `findBoundary` assumes a whole release name and would take a trailing
word as a release group. `findTitleRegion` is used as-is.

For an unanchored name, the stem *is* a whole release name, so `findBoundary`
is correct -- the same call the movies path makes.

The trailing release group is handled by the existing `splitGroupSuffix`.

### Vocabulary additions

Three tokens the shared vocabulary does not know, verified by calling
`isJunk`/`classifyToken`: `xxx`, `mp4`, `pmv`. (`siterip` is already
classified as a source.)

**`xxx` and `pmv` are scene-local, not shared.** `xXx` (2002) and `xXx: Return
of Xander Cage` are real movie releases, so adding `xxx` to the global junk
vocabulary would make a legitimate movie title unparseable. It is absent from
the movies corpus, but that is luck rather than safety. These two live in
`lib/parse/scene.ts` and are stripped by the scene path only.

**`mp4` is shared,** added to the container vocabulary in
`lib/parse/tokens.ts`. It appears as a mid-name token in xxx releases
(`...2160p.MP4-WRB`) and is conceptually a container, not an xxx concept.
Mid-name `.mp4.` occurs 0 times in the movies and tv corpora, so the change
cannot disturb them -- and the existing golden test proves that automatically,
since any change to a movies or tv parse fails it.

### categoryDisagreement

Set when the name carries a season/episode marker, which suggests the caller
may have meant `tv`. This mirrors the existing rule's intent: movies sets it
when a marker is present, tv when a marker is absent but a year is present.
For xxx the marker is the anomaly -- it occurs 11 times in 12,815 names.

### Refusals

No new refusal logic. The shared extension gate refuses the 8 `.jpg` sidecars
and the 51 extensionless lines, ~59 of 12,815. A name with no site and no date
is still a *parse*, not a refusal: the parser's job is a best-effort structural
answer and the resolver decides what confidence it earns.

## Performers

The parse does not split performers out of the name. The post-date run becomes
`title` whole.

This was tested against the corpus rather than assumed, because the project
owner's experience is that performer names are the most identifiable strings in
these titles -- which the data confirms. Measured over the 9,280 two-digit-year
anchored names, the modal post-date run is exactly two tokens (2,164), a bare
`First Last` with no title, and mining recurring leading pairs yields an
unmistakable performer list: `kenzie reeves`
(139 occurrences), `selina imai` (97), `cory chase` (96).

An iterative algorithm -- consume a leading known pair, skip a joiner, repeat --
handles the hard cases correctly, including both of these:

```
Cory.Chase.Millie.Morgan.Pornstar.Crush   → [Cory Chase, Millie Morgan] + "Pornstar Crush"
Freya.Parker.StepMother.And.Son.Instruction → [Freya Parker] + "StepMother And Son Instruction"
```

The second is why `And` cannot be used as a structural separator: there it
joins two title words, while in `Ruby.Redbottom.And.Octavia.Red` it joins two
performers. The two differ only by what flanks the joiner, so the signal is
recurrence, not structure.

It was deferred anyway, for three reasons:

1. **Recall caps at 58%.** A corpus-derived dictionary can only contain
   performers who lead a scene name under two or more distinct sites in this
   library -- 826 names. Real performer lists run to six figures. The 42% of
   misses are indistinguishable from hits: `Madison Mason Burning Up`,
   `Lichelle Marie And Madison Fox`, and `Valentina Luscious` all silently
   become title text.
2. **Mononyms break the shape.** Some performers use a single name -- `Maya`,
   `Ana` -- which a two-token pair rule cannot represent at all, and which a
   one-token rule would swallow title words to capture.
3. **It adds nothing where it would be used.** For the anchored 77%, TPDB
   matches on site plus date and returns the canonical performers regardless,
   so a parse-time guess is discarded. It would help the unanchored 23%, but
   that is precisely where a corpus-mined dictionary is least trustworthy.

The cost of doing it now would also be recurring: 12,815 golden entries freeze
against dictionary state, so every dictionary update means a `PARSER_VERSION`
bump and a full golden regeneration. That machinery exists and is correct --
`decide()` re-parses when `parserVersion < PARSER_VERSION` -- but it is churn
bought for a 58% answer that the next slice replaces with a 100% one.

**Inherited by the resolver slice:** performer identification, using TPDB's
authoritative list, and mononym handling. Nothing is lost by waiting -- the
whole run is preserved verbatim in `title`.

## Validation

The point of this slice. Three artifacts, following the existing pattern
exactly:

1. **`fixtures/corpus/xxx.golden.jsonl`** -- one JSON object per line,
   `{name, category, expected}` where `expected` is the serialized parse, or
   `expected: null` for a name that must refuse. Generated by a script, then
   committed and reviewed by sampling.
2. **`test/golden.test.ts`** -- add the file to `FILES`. Every name is
   re-parsed and deep-compared, so any future change to the shared vocabulary
   or the scene grammar that alters a parse fails the suite with the specific
   name and both shapes.
3. **`fixtures/corpus/baseline.json`** -- add `xxx.library.raw.txt` and
   `xxx.releases.raw.txt` entries under `parseRate`, `titleLeaks`, and
   `refused`. `resolveRate` is left out: it needs a provider, which this slice
   does not have.

Targets, mirroring movies and tv:

- **`parseRate` 1.0** for both files. Every name yields either a parse or a
  clean refusal; a throw or a failure is a bug. This is the gate.
- **`titleLeaks`** recorded, not gated. It counts parses whose title still
  holds a junk token, and it is the quality signal to drive down over time.
  The `xxx` and `mp4` vocabulary additions exist to reduce it -- without them
  a majority of titles in the corpus would leak, since the `XXX` token appears
  in 7,669 of the 12,815 names (59%).
- **`refused`** approximately 59, the sidecars and extensionless lines.

## Testing

Unit tests in `test/parse/scene.test.ts`, each naming the corpus fact it
encodes:

- The anchored form decomposes: site, `releasedOn`, title, group, quality --
  using the owner's own example,
  `SpankMonster.22.07.07.Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb`,
  which must yield site `SpankMonster`, `releasedOn` `2022-07-07`, group `WRB`,
  resolution `2160p`, and a title free of `XXX` and `MP4`.
- `YY` expands to `20YY`; a four-digit year is taken as-is.
- A month over 12 or a day over 31 is not a date and stays in the title.
- A two-component `YYYY.MM` is not a date.
- A mid-name date is not the anchor.
- Site falls back to the parent directory, and the directory appears in
  `hints.fromDirectories` even when the filename supplied the site.
- `xxx` is junk for a scene and *not* junk for a movie -- the test that pins
  the category-scoped decision, asserting `xXx.2002.1080p.BluRay.x264-GRP`
  parses as the movie `xXx`.
- A name with neither site nor date parses rather than refusing.
- A `.jpg` in the xxx category refuses as a sidecar.

Plus the golden file over all 12,815 names, and the corpus report to record the
baseline.

## Files

| File | Change |
|---|---|
| `lib/parse/scene.ts` | Create. `parseScene`, the scene-local vocabulary, the date rule. |
| `lib/parse/types.ts` | Add the `scene` variant to `ParsedVideo`. |
| `lib/parse/video.ts` | Dispatch to `parseScene` after the extension gate. |
| `lib/parse/tokens.ts` | Add `mp4` to the container vocabulary. |
| `test/parse/scene.test.ts` | Create. The unit tests above. |
| `test/golden.test.ts` | Add `xxx.golden.jsonl` to `FILES`. |
| `fixtures/corpus/xxx.library.raw.txt` | Create, 5,835 lines. |
| `fixtures/corpus/xxx.releases.raw.txt` | Create, 6,980 lines. |
| `fixtures/corpus/xxx.golden.jsonl` | Create, 12,815 entries. |
| `fixtures/corpus/baseline.json` | Add xxx entries. |
| `scripts/` | A one-shot corpus preparation script: dedupe, drop subjects, split. |

No migration. No new dependency. No network.
