import type { Category, ParsedVideo } from '../../parse/types';
import type { Provider, ResolveContext, ResolveOutcome } from '../types';
import { pickBest, scoreCandidate, type Candidate } from '../../resolve/confidence';
import type { TmdbClient } from './client';
import {
  tmdbMovieDetails, tmdbMovieSearch, tmdbSeasonDetails, tmdbTvDetails, tmdbTvSearch,
  type TmdbMovieSearchResult, type TmdbTvDetails, type TmdbTvSearchResult,
} from './schema';
import { normalizeEpisode, normalizeMovie, normalizeSeason, normalizeSeries } from './normalize';

function yearFrom(date: string | null | undefined): number | null {
  if (date === null || date === undefined || date.length < 4) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function movieCandidate(result: TmdbMovieSearchResult): Candidate {
  return {
    title: result.title,
    originalTitle: result.original_title ?? null,
    year: yearFrom(result.release_date),
    originCountries: [],
    popularity: result.popularity ?? 0,
    voteCount: result.vote_count ?? 0,
    seasonExists: null,
    episodeExists: null,
  };
}

function tvCandidate(result: TmdbTvSearchResult): Candidate {
  return {
    title: result.name,
    originalTitle: result.original_name ?? null,
    year: yearFrom(result.first_air_date),
    originCountries: result.origin_country,
    popularity: result.popularity ?? 0,
    voteCount: result.vote_count ?? 0,
    seasonExists: null,
    episodeExists: null,
  };
}

/** The year to send as a search filter, from the parse or a `(2019)` hint. */
function searchYear(parsed: ParsedVideo): number | undefined {
  if (parsed.year !== null) return parsed.year;
  const hint = parsed.hints.disambiguator;
  if (hint !== null && /^\d{4}$/.test(hint)) return Number.parseInt(hint, 10);
  return undefined;
}

async function resolveMovie(
  client: TmdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<ResolveOutcome | null> {
  const search = await client.get('/search/movie', {
    query: parsed.title,
    primary_release_year: searchYear(parsed),
  }, tmdbMovieSearch, ctx);
  if (search === null) return null;
  const best = pickBest(parsed, search.results, movieCandidate);
  if (best === null) return null;
  const details = await client.get(
    `/movie/${best.item.id}`, { append_to_response: 'credits' }, tmdbMovieDetails, ctx,
  );
  return details === null ? null : { media: normalizeMovie(details), confidence: best.confidence };
}

/**
 * The season whose window contains an air date.
 *
 * Known limitation: this returns the *last* numbered season rather than the one
 * whose window actually contains the date, because `tv/{id}` gives season
 * numbers and episode counts but not season air-date ranges. For a
 * currently-airing daily the newest season is usually right and sometimes is
 * not. Fixing it properly means fetching candidate seasons and matching
 * `air_date` inside them -- more provider calls for a case worth about 50 lines
 * of the corpus. Revisit when the resolve-rate numbers say it matters.
 */
function seasonFromAirDate(details: TmdbTvDetails, airDate: string | null): number | null {
  if (airDate === null) return null;
  const numbered = details.seasons.map((s) => s.season_number).filter((n) => n > 0);
  return numbered.length > 0 ? (numbered.at(-1) ?? null) : null;
}

async function resolveTv(
  client: TmdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<ResolveOutcome | null> {
  // TMDB has no xxx scene catalog; `supports()` already excludes the xxx
  // category, so `resolve()` below should never route a scene here. Handled
  // anyway, as a typed no-op, because the union now includes it. A TPDB
  // provider for scenes is a later task.
  if (parsed.kind === 'scene') return null;
  const search = await client.get('/search/tv', {
    query: parsed.title,
    first_air_date_year: searchYear(parsed),
  }, tmdbTvSearch, ctx);
  if (search === null) return null;
  const best = pickBest(parsed, search.results, tvCandidate);
  if (best === null) return null;

  const details = await client.get(`/tv/${best.item.id}`, {}, tmdbTvDetails, ctx);
  if (details === null) return null;
  const series = normalizeSeries(details);
  const chosen = tvCandidate(best.item);
  if (parsed.kind === 'series' || parsed.kind === 'movie') {
    return { media: series, confidence: best.confidence };
  }

  // A year-season (`S2013`) does not name a TMDB season, so fall back to the
  // air date, then to season 1.
  const declared = parsed.yearSeason ? null : parsed.seasonNumber;
  const airDate = parsed.kind === 'episode' ? parsed.airDate : null;
  const seasonNumber = declared ?? seasonFromAirDate(details, airDate) ?? 1;

  const season = await client.get(
    `/tv/${best.item.id}/season/${seasonNumber}`, {}, tmdbSeasonDetails, ctx,
  );
  // Re-score now that existence is known rather than null.
  //
  // This is not a refinement, it is the difference between resolving and not.
  // A library path carries no year, so the search-time score gets no year
  // boost and lands around 0.72 -- below the floor -- for a title that matched
  // exactly. Whether the season and episode actually exist on this series is
  // the strongest evidence available, and it is only knowable after this fetch.
  const seasonExists = season !== null;
  const wantedEpisode = parsed.kind === 'episode' ? parsed.episodeNumbers[0] : undefined;
  const episode = season === null ? undefined : season.episodes.find((e) => (
    wantedEpisode !== undefined
      ? e.episode_number === wantedEpisode
      : airDate !== null && e.air_date === airDate
  ));
  const confidence = scoreCandidate(parsed, {
    ...chosen,
    seasonExists,
    episodeExists: parsed.kind === 'episode' ? episode !== undefined : null,
  });

  if (season === null) return { media: series, confidence };
  const normalizedSeason = normalizeSeason(series, season);
  if (parsed.kind !== 'episode') return { media: normalizedSeason, confidence };
  if (episode === undefined) return { media: normalizedSeason, confidence };
  return { media: normalizeEpisode(normalizedSeason, episode), confidence };
}

export function createTmdbProvider(client: TmdbClient): Provider {
  return {
    name: 'tmdb',
    supports(category: Category): boolean {
      return category === 'movies' || category === 'tv';
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      ctx.signal.throwIfAborted();
      // The declared category fixes the namespace. `kind` says what shape the
      // name had; it never redirects the search.
      return parsed.kind === 'movie'
        ? resolveMovie(client, parsed, ctx)
        : resolveTv(client, parsed, ctx);
    },
  };
}
