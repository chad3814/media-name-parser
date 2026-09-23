# Linking the same thing across providers

**Date:** 2026-09-23
**Status:** approved to implement
**Closes:** #2

## Problem

`media` is unique on `(provider, provider_ref)`, so a series TMDB resolved and
the same series TheTVDB resolved are two rows with nothing joining them. Ten
shows are in that state in production today -- every TheTVDB series TMDB had
also seen. A caller asking what the service knows about House Hunters
Renovation gets two answers and no way to tell they are one show.

The natural place to record the fact cannot hold it: `media_external_ids` is
`PRIMARY KEY (source, ref)`, so `(tvdb, 262643)` points at exactly one row.
TMDB's series publishes a tvdb ref and TheTVDB's publishes its own; whichever
writes first owns the entry and the other is dropped.

## What this builds

Three link tables, of which one is populated, and the link exposed on the
read envelope so a caller can merge for itself.

Deliberately **not** in scope: merging on read, any per-field precedence
between providers, and any change to which record a lookup resolves to. The
service keeps answering exactly what it answers today and additionally says
"this other row is the same thing".

## Why `*_details` tables need no version table

Every one of `movie_details`, `series_details`, `season_details`,
`episode_details`, `book_details` and `scene_details` has `media_id` as its
**primary key** -- 1:1 with `media`, no identity of its own. Linking two
`media` rows links their details by construction, so a `series_details_versions`
would hold exactly the pairs `media_versions` already holds. Six tables that
looked necessary are derivable.

The two entities that do have independent identity are `people` (own `id`,
`unique(provider, provider_ref)`) and sites (`PRIMARY KEY (provider,
provider_ref)` today).

## Schema

### The three link tables

```sql
CREATE TABLE media_versions (
  a uuid NOT NULL REFERENCES media(id)  ON DELETE CASCADE,
  b uuid NOT NULL REFERENCES media(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX media_versions_b_idx ON media_versions (b);
```

`people_versions` and `sites_versions` are the same shape against `people(id)`
and `sites(id)`.

`CHECK (a < b)` with the pair as the primary key is what makes a link storable
exactly once. Without it `(x, y)` and `(y, x)` are different rows saying the
same thing, and every reader has to remember to look both ways *and* dedupe.
With it, a writer sorts before inserting and a reader asks
`WHERE a = $1 OR b = $1`. The index on `b` is what keeps the second half of
that predicate from scanning.

Pairwise is not transitive: three providers on one record would need all three
pairs written, or a recursive read. The only cross-provider overlap that
exists or is planned is tmdb-tvdb on `tv` -- `xxx` is tpdb alone, `books` is
unimplemented -- so this is a limitation to record, not to design around. If a
third provider ever joins a category, revisit; a group id would then be the
better shape.

### `provider_sites` becomes `sites`

Renamed, and given a surrogate `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
with `unique(provider, provider_ref)` and `unique(provider, short_name)`
retained. That is exactly how `people` is shaped, and "on par with `people`"
is the point: a site is an entity a provider has its own identifier for, not
an extension of a media row.

The surrogate is what keeps `sites_versions` two columns wide like the other
two. Without it the link table would carry four columns and read differently
from its siblings for no reason but the key it inherited.

The old name is wrong in a way worth fixing while touching it: `provider_sites`
reads as a sibling of `provider_calls`, which is an observability table about
requests, and it is nothing of the kind.

1,138 rows, all `tpdb`. The migration renames and adds a column; it does not
recreate the table.

### `movie_details` is unchanged

It gains nothing. It is 1:1 with `media`, which already carries `provider` and
`provider_ref`, so adding them here would duplicate a value one join away and
let the two disagree.

## Population

### `media_versions`, from the resolve path

The composite provider already holds both identities at one instant: it reads
TheTVDB's series ref off TMDB's own record (`tmdb/normalize.ts` publishes
`tvdb_id` as an external id) and hands it over. No matching heuristic is
needed anywhere, and nothing is guessed.

There is a wrinkle. When the fallback fires, the composite returns the
TheTVDB chain and **only that is persisted** -- TMDB's answer is discarded,
and its `media` row may or may not exist from an earlier lookup.

So `ResolvedMedia` gains:

```ts
/**
 * Another provider's record for this same thing, when the resolution knew
 * of one. Written as a pair into `media_versions` if that row exists.
 */
readonly sameAs?: { readonly provider: ProviderName; readonly providerRef: string };
```

The composite sets it on the **series** node of the chain it is returning --
the TheTVDB series -- naming the TMDB series it took the handover from. Not
on the episode: the handover establishes that two *series* are the same, and
says nothing about whether TMDB has the episode at all, which is usually why
the fallback ran. Season and episode links are therefore out of scope; the
series link is what a caller needs to find the other catalogue's record.

`persistResolved` looks the counterpart up by `(provider, provider_ref)` and
writes the pair when it is found, doing nothing when it is not -- the next
lookup that resolves the other provider, or the backfill, closes it. A link
that cannot be written is not an error; it is simply not known yet.

### `media_versions`, backfill

A one-off script, `scripts/backfill-media-versions.ts`, run the way the other
scripts are (`node --env-file=.env.local --import tsx`). It pairs the rows
already stored: same `kind`, same `lower(sort_title)`, two distinct
providers. It prints the pairs and a count,
and writes only when passed a flag. Ten pairs today.

Title equality is a heuristic and is acceptable **here** in a way it is not in
the resolve path: this runs once, over a set small enough to read in full,
with a human looking at the list before it writes.

### `people_versions` and `sites_versions`

Created empty. Nothing populates them in this work.

`sites_versions` cannot have a row today: sites are written by TPDB alone, so
a cross-provider pair does not exist. It is created for symmetry with the
other two and because a second site-writing provider is mentally planned.

`people_versions` has no link source on the resolve path. Every provider
embeds its people fully in a response the lookup already makes, and every id
in those payloads is provider-local. Linking them needs a call per person on
an endpoint nothing currently fetches, which belongs off the request path.
Issue #3 scopes that; this spec creates the table it will fill.

## The read envelope

`MediaView` gains one field, mirroring `parents`, which is already a
`MediaNode[]`:

```ts
/** The same thing as recorded by another provider. Empty when none is known. */
readonly versions: readonly MediaNode[];
```

Additive: an existing consumer that ignores it is unaffected, and an empty
array rather than an absent key means a consumer never has to distinguish
"none" from "not supported".

Only the node the envelope is *about* carries versions. Parents do not, which
keeps the read to one extra query and avoids a response whose size multiplies
with the chain. A caller wanting a parent's versions can ask for the parent.

`lib/openapi/spec.ts` and `test/openapi/spec.test.ts` follow.

## Failure and degradation

- A link that cannot be written because the counterpart row is absent is
  skipped silently. It is the ordinary case on a first lookup.
- The versions query is a left join returning zero rows; no media read can
  fail for want of a link.
- `ON DELETE CASCADE` on both columns: a deleted media row takes its links
  with it rather than leaving a dangling pair.

## Testing

- `CHECK (a < b)` rejects a mirrored insert; the primary key rejects a
  duplicate.
- `persistResolved` writes a pair when `sameAs` names a row that exists,
  writes nothing when it does not, and is idempotent across repeated
  resolutions of the same name.
- The composite sets `sameAs` on a handover and leaves it absent when TMDB
  answered alone.
- `readMedia` returns both directions of a pair -- a link stored as `(a, b)`
  is visible from `b` as well as `a`.
- The rename: `sites` reads and writes through `lib/providers/tpdb/sites.ts`
  as before, and the existing tpdb tests pass unchanged against the new name.
- Live: resolve a tv name that falls back, confirm the pair appears, confirm
  the envelope carries it.

## Success criteria

1. A tv name resolved through the TheTVDB fallback records a pair when TMDB's
   row for the same series exists.
2. `GET /v1/media/{id}` returns the sibling in `versions`, from either side.
3. The backfill links the 10 pairs already stored, after printing them.
4. `sites` holds the same 1,138 rows under the new name, with an `id`.
5. `people_versions` and `sites_versions` exist and are empty.
6. No lookup resolves to a different record than it did before.
7. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` clean.
