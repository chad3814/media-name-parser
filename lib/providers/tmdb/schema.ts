import { z } from 'zod';

/**
 * Permissive by design. TMDB adds fields, and a strict schema would turn an
 * upstream addition into an outage. Unknown keys are ignored (zod's default
 * object behaviour) and anything not guaranteed by the docs is nullable.
 */
const person = z.object({
  id: z.number(),
  name: z.string(),
});

export const tmdbCastMember = person.extend({
  character: z.string().nullish(),
  order: z.number().nullish(),
});

export const tmdbCrewMember = person.extend({
  job: z.string().nullish(),
  department: z.string().nullish(),
});

export const tmdbCredits = z.object({
  cast: z.array(tmdbCastMember).default([]),
  crew: z.array(tmdbCrewMember).default([]),
});

export const tmdbMovieSearchResult = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().nullish(),
  release_date: z.string().nullish(),
  popularity: z.number().nullish(),
  vote_count: z.number().nullish(),
});

export const tmdbMovieSearch = z.object({
  page: z.number(),
  total_results: z.number(),
  results: z.array(tmdbMovieSearchResult).default([]),
});

export const tmdbMovieDetails = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().nullish(),
  release_date: z.string().nullish(),
  overview: z.string().nullish(),
  runtime: z.number().nullish(),
  imdb_id: z.string().nullish(),
  tagline: z.string().nullish(),
  belongs_to_collection: z.object({ name: z.string() }).nullish(),
  credits: tmdbCredits.nullish(),
});

export const tmdbTvSearchResult = z.object({
  id: z.number(),
  name: z.string(),
  original_name: z.string().nullish(),
  first_air_date: z.string().nullish(),
  origin_country: z.array(z.string()).default([]),
  popularity: z.number().nullish(),
  vote_count: z.number().nullish(),
});

export const tmdbTvSearch = z.object({
  page: z.number(),
  total_results: z.number(),
  results: z.array(tmdbTvSearchResult).default([]),
});

export const tmdbSeasonSummary = z.object({
  season_number: z.number(),
  episode_count: z.number().nullish(),
});

export const tmdbTvDetails = z.object({
  id: z.number(),
  name: z.string(),
  original_name: z.string().nullish(),
  first_air_date: z.string().nullish(),
  last_air_date: z.string().nullish(),
  status: z.string().nullish(),
  overview: z.string().nullish(),
  origin_country: z.array(z.string()).default([]),
  number_of_seasons: z.number().nullish(),
  seasons: z.array(tmdbSeasonSummary).default([]),
});

export const tmdbEpisode = z.object({
  id: z.number(),
  episode_number: z.number(),
  season_number: z.number(),
  name: z.string(),
  air_date: z.string().nullish(),
  overview: z.string().nullish(),
  crew: z.array(tmdbCrewMember).default([]),
  guest_stars: z.array(tmdbCastMember).default([]),
});

export const tmdbSeasonDetails = z.object({
  id: z.number(),
  season_number: z.number(),
  name: z.string(),
  air_date: z.string().nullish(),
  overview: z.string().nullish(),
  episodes: z.array(tmdbEpisode).default([]),
});

export type TmdbMovieSearch = z.infer<typeof tmdbMovieSearch>;
export type TmdbMovieSearchResult = z.infer<typeof tmdbMovieSearchResult>;
export type TmdbMovieDetails = z.infer<typeof tmdbMovieDetails>;
export type TmdbTvSearch = z.infer<typeof tmdbTvSearch>;
export type TmdbTvSearchResult = z.infer<typeof tmdbTvSearchResult>;
export type TmdbTvDetails = z.infer<typeof tmdbTvDetails>;
export type TmdbSeasonDetails = z.infer<typeof tmdbSeasonDetails>;
export type TmdbEpisode = z.infer<typeof tmdbEpisode>;

/**
 * `/find/{id}` buckets its answer by kind. Only the two this provider serves
 * are read; the response also carries person, season and episode buckets.
 */
export const tmdbFind = z.object({
  movie_results: z.array(tmdbMovieSearchResult).default([]),
  tv_results: z.array(tmdbTvSearchResult).default([]),
});
