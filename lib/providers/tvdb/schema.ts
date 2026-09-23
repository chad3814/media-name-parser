import { z } from 'zod';

/**
 * Only the fields this slice reads. TheTVDB's records carry far more and grow
 * over time; validating the rest would make this schema start rejecting valid
 * responses the day the API adds a field. Every field is `.nullish()` unless
 * verified present on every sampled row, matching the rule in
 * `lib/providers/tpdb/schema.ts`.
 *
 * The published `swagger.yml` omits every per-record endpoint used here, so
 * these shapes were taken from live responses on 2026-09-20 rather than read
 * from the specification.
 */

/**
 * A series' status is an *object* on a series record and a bare *string* in a
 * search result -- the same field, two encodings, one per endpoint. Modelled
 * separately rather than as a union so each call site states which it expects
 * and a shape drifting on one endpoint cannot quietly satisfy the other.
 */
const statusObjectSchema = z.object({ name: z.string().nullish() });

export const seriesSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullish(),
  overview: z.string().nullish(),
  firstAired: z.string().nullish(),
  lastAired: z.string().nullish(),
  /** A string on this API, not a number. */
  year: z.string().nullish(),
  status: statusObjectSchema.nullish(),
  /**
   * Other names the series goes by, including the romaji an anime filename
   * carries. Already in the response; reading it costs nothing.
   */
  aliases: z.array(z.object({ name: z.string() })).default([]),
});

/**
 * A credit on the extended endpoints. `peopleId` is the person and `id` is
 * this particular credit, which is why the person is what gets recorded:
 * `people` is keyed `unique(provider, provider_ref)`, and keying on the
 * credit would make a fresh person row for every part an actor ever played.
 *
 * `name` is the character and is null for crew. `peopleType` seen live
 * across four series on 2026-09-23: Actor, Guest Star, Writer, Director.
 */
export const characterSchema = z.object({
  peopleId: z.number(),
  personName: z.string(),
  name: z.string().nullish(),
  peopleType: z.string().nullish(),
  sort: z.number().nullish(),
});

export const episodeSchema = z.object({
  id: z.number(),
  seriesId: z.number().nullish(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  aired: z.string().nullish(),
  runtime: z.number().nullish(),
  /** The episode's number within its season. */
  number: z.number().nullish(),
  seasonNumber: z.number().nullish(),
  absoluteNumber: z.number().nullish(),
  /**
   * Only the *extended* endpoint carries these; the episodes listing does
   * not. Defaulted so the same schema reads both, and so a record with no
   * credits -- an unscripted show has none -- is absent rather than an error.
   */
  characters: z.array(characterSchema).nullish().transform((v) => v ?? []),
});

/**
 * `/series/{id}/episodes/{season-type}` answers with the series record *and*
 * the matching episodes, which is what lets the whole chain be built from a
 * single call.
 */
export const episodesResponseSchema = z.object({
  data: z.object({
    series: seriesSchema,
    episodes: z.array(episodeSchema).default([]),
  }),
});

export const seriesResponseSchema = z.object({ data: seriesSchema });

/** `/episodes/{id}/extended`, which is where the credits live. */
export const extendedEpisodeResponseSchema = z.object({ data: episodeSchema });

/**
 * A search hit. `id` is `"series-121361"` while `tvdb_id` is the bare
 * `"121361"`, and the bare form is the one every other endpoint accepts --
 * so `id` is deliberately not read at all.
 */
export const searchResultSchema = z.object({
  tvdb_id: z.string(),
  name: z.string(),
  slug: z.string().nullish(),
  overview: z.string().nullish(),
  first_air_time: z.string().nullish(),
  year: z.string().nullish(),
  /** A bare string here, unlike the object on a series record. */
  status: z.string().nullish(),
  /** Bare strings here too, unlike the objects on a series record. */
  aliases: z.array(z.string()).default([]),
});

export const searchResponseSchema = z.object({
  data: z.array(searchResultSchema).default([]),
});

export type TvdbSeries = z.infer<typeof seriesSchema>;
export type TvdbEpisode = z.infer<typeof episodeSchema>;
export type TvdbCharacter = z.infer<typeof characterSchema>;
export type TvdbSearchResult = z.infer<typeof searchResultSchema>;
