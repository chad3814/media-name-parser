import type { Category, ParsedVideo } from '../../parse/types';
import type { Provider, ResolveContext, ResolveOutcome } from '../types';
import { pickBest, scoreCandidate, titleSimilarity, type Candidate } from '../../resolve/confidence';
import type { TmdbClient } from './client';
import {
  tmdbFind, tmdbMovieDetails, tmdbMovieSearch, tmdbSeasonDetails, tmdbTvDetails, tmdbTvSearch,
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

/**
 * The same parse, reading its trailing year as part of the title.
 *
 * `Blade Runner 2049` splits into the title `Blade Runner` and the year 2049,
 * which is a reasonable reading of the characters and the wrong reading of the
 * film. The filename cannot settle it -- `Some Movie 2012` has the identical
 * shape -- but the provider's catalogue can, and only it can: no bound on
 * plausible release years distinguishes the two, and a bound read off the
 * clock would make the parser non-deterministic.
 *
 * So the question is asked rather than guessed. A year-filtered search that
 * matches nothing at all is the evidence: 2049 returns zero films, while the
 * rejoined title returns `Blade Runner 2049` first. Clearing the year matters
 * as much as joining it -- `scoreCandidate` docks 0.35 for a year gap over
 * one, which is enough to keep the 1982 original ahead of the 2017 sequel.
 *
 * Only a year the name itself carried is folded back. A `(2019)` directory
 * hint is a human's filing decision, not a token that might be a title word.
 */
function yearReadAsTitle<T extends ParsedVideo>(parsed: T): T | null {
  // Generic so it preserves whatever narrowing the caller already has: the tv
  // path has excluded `scene` before this runs, and returning the whole union
  // would hand that back.
  if (parsed.year === null) return null;
  return { ...parsed, title: `${parsed.title} ${parsed.year}`, year: null };
}

/** `/find`'s parameter name for each id source the filename can carry. */
const EXTERNAL_SOURCE: Readonly<Record<string, string>> = {
  imdb: 'imdb_id',
  tvdb: 'tvdb_id',
};

/**
 * The TMDB id a filename named, directly or by translation.
 *
 * `{tmdb-603}` is already a TMDB id. `{imdb-tt0133093}` and `{tvdb-368611}`
 * are not, but `/find` translates both -- verified: tvdb 368611 comes back as
 * TMDB 92749, Moon Knight. A `{tpdb-...}` id belongs to a provider this one
 * does not serve and is ignored here rather than guessed at.
 *
 * Null means no usable id, which is not a failure: the caller falls through to
 * searching by title.
 */
async function tmdbIdFor(
  client: TmdbClient, parsed: ParsedVideo, wanted: 'movie' | 'tv', ctx: ResolveContext,
): Promise<number | null> {
  const named = parsed.externalId;
  if (named === undefined) return null;
  if (named.source === 'tmdb') {
    const value = Number.parseInt(named.id, 10);
    return Number.isNaN(value) ? null : value;
  }
  const source = EXTERNAL_SOURCE[named.source];
  if (source === undefined) return null;
  const found = await client.get(
    `/find/${encodeURIComponent(named.id)}`, { external_source: source }, tmdbFind, ctx,
  );
  if (found === null) return null;
  const hit = wanted === 'movie' ? found.movie_results[0] : found.tv_results[0];
  return hit?.id ?? null;
}

async function resolveMovie(
  client: TmdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<ResolveOutcome | null> {
  // An id is an assertion, not a match: no search, no scoring, and a
  // confidence of 1. A miss here -- a deleted or mistyped id -- falls through
  // to the title search rather than failing the lookup, because a stale id
  // beside a good title is the common shape in a hand-edited library.
  const namedId = await tmdbIdFor(client, parsed, 'movie', ctx);
  if (namedId !== null) {
    const named = await client.get(
      `/movie/${namedId}`, { append_to_response: 'credits' }, tmdbMovieDetails, ctx,
    );
    if (named !== null) return { media: normalizeMovie(named), confidence: 1 };
  }

  const search = await client.get('/search/movie', {
    query: parsed.title,
    primary_release_year: searchYear(parsed),
  }, tmdbMovieSearch, ctx);
  if (search === null) return null;

  let effective = parsed;
  let results = search.results;
  const rejoined = results.length === 0 ? yearReadAsTitle(parsed) : null;
  if (rejoined !== null) {
    const retry = await client.get(
      '/search/movie', { query: rejoined.title }, tmdbMovieSearch, ctx,
    );
    if (retry !== null && retry.results.length > 0) {
      effective = rejoined;
      results = retry.results;
    }
  }

  const best = pickBest(effective, results, movieCandidate);
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
  // A `{tmdb-}` or `{tvdb-}` id on a tv name addresses the SERIES, not an
  // episode: that is the Plex convention, and the season and episode still
  // come from the name. So an id replaces the series hunt and nothing else --
  // the season fetch, the episode match and the existence re-score below all
  // run exactly as they do for a searched series.
  const namedId = await tmdbIdFor(client, parsed, 'tv', ctx);
  const namedDetails = namedId === null
    ? null
    : await client.get(`/tv/${namedId}`, { append_to_response: 'external_ids' }, tmdbTvDetails, ctx);

  const search = namedDetails !== null ? null : await client.get('/search/tv', {
    query: parsed.title,
    first_air_date_year: searchYear(parsed),
  }, tmdbTvSearch, ctx);

  // Searched series. Skipped entirely when an id already named one.
  let searched: { readonly id: number; readonly confidence: number; readonly candidate: Candidate } | null = null;
  if (namedDetails === null) {
    if (search === null) return null;
    let effective = parsed;
    let results = search.results;
    const rejoined = results.length === 0 ? yearReadAsTitle(parsed) : null;
    if (rejoined !== null) {
      const retry = await client.get('/search/tv', { query: rejoined.title }, tmdbTvSearch, ctx);
      if (retry !== null && retry.results.length > 0) {
        effective = rejoined;
        results = retry.results;
      }
    }
    const best = pickBest(effective, results, tvCandidate);
    if (best === null) return null;
    searched = { id: best.item.id, confidence: best.confidence, candidate: tvCandidate(best.item) };
  }

  const details = namedDetails ?? (searched === null
    ? null
    : await client.get(`/tv/${searched.id}`, { append_to_response: 'external_ids' }, tmdbTvDetails, ctx));
  if (details === null) return null;
  const seriesId = searched?.id ?? namedId;
  if (seriesId === null) return null;
  const series = normalizeSeries(details);
  // An id needs no re-scoring: it is already certain. `chosen` exists only to
  // feed the existence re-score, which is a search-path concern.
  const chosen = searched?.candidate ?? null;
  if (parsed.kind === 'series' || parsed.kind === 'movie') {
    return { media: series, confidence: searched?.confidence ?? 1 };
  }

  // A year-season (`S2013`) does not name a TMDB season, so fall back to the
  // air date, then to season 1.
  const declared = parsed.yearSeason ? null : parsed.seasonNumber;
  const airDate = parsed.kind === 'episode' ? parsed.airDate : null;
  const seasonNumber = declared ?? seasonFromAirDate(details, airDate) ?? 1;

  const season = await client.get(
    `/tv/${seriesId}/season/${seasonNumber}`, {}, tmdbSeasonDetails, ctx,
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
  // An id-named series is not re-scored. The re-score exists to recover a
  // searched match whose title alone could not clear the floor, using season
  // and episode existence as extra evidence; there is nothing to recover when
  // the series was named outright. Scoring it anyway would compare the
  // filename's title against the canonical one and could sink the very case an
  // id is for -- a show the library has under a different name.
  //
  // The confidence describes whatever is returned below, which is the most
  // specific record that could be confirmed: the episode if it exists, else
  // the season, else the series. `media.kind` says which.
  const confidence = chosen === null
    ? 1
    : scoreCandidate(parsed, {
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

/**
 * An id whose namespace the parse cannot tell us.
 *
 * TMDB numbers movies and series separately and both spaces are densely
 * populated: 5725 is the film `Supervixens` AND the series `Project Catwalk`,
 * 603 is `The Matrix` AND `Veronica's Closet`. Inside the declared category
 * the namespace is known, so `{tmdb-603}` on a movies lookup is unambiguous
 * and is believed outright even when the filename's title is wrong.
 *
 * Arriving here, it is not known -- the caller filed the name under a category
 * this provider does not serve, so `kind` says `scene` and says nothing about
 * movie versus series. Guessing would be a coin flip reported at confidence 1,
 * which is the worst answer this system can give.
 *
 * So the title is required to corroborate. `/movie/5725` returns
 * `Supervixens` and the filename says `Supervixens`: that is evidence. If
 * neither namespace agrees with the title, the id is abandoned and the caller
 * falls through to the category's own provider.
 *
 * `imdb` and `tvdb` ids never reach this path -- `/find` returns them in a
 * typed bucket, so their namespace is self-describing.
 */
const CORROBORATION = 0.8;

async function resolveAcrossNamespaces(
  client: TmdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<ResolveOutcome | null> {
  const named = parsed.externalId;
  if (named === undefined) return null;

  if (named.source === 'imdb' || named.source === 'tvdb') {
    const source = EXTERNAL_SOURCE[named.source];
    if (source === undefined) return null;
    const found = await client.get(
      `/find/${encodeURIComponent(named.id)}`, { external_source: source }, tmdbFind, ctx,
    );
    if (found === null) return null;
    const movie = found.movie_results[0];
    if (movie !== undefined) return detailsForMovie(client, movie.id, ctx);
    const series = found.tv_results[0];
    return series === undefined ? null : detailsForSeries(client, series.id, ctx);
  }

  if (named.source !== 'tmdb') return null;
  const id = Number.parseInt(named.id, 10);
  if (Number.isNaN(id)) return null;

  const asMovie = await client.get(
    `/movie/${id}`, { append_to_response: 'credits' }, tmdbMovieDetails, ctx,
  );
  if (asMovie !== null && titleSimilarity(parsed.title, asMovie.title) >= CORROBORATION) {
    return { media: normalizeMovie(asMovie), confidence: 1 };
  }
  const asSeries = await client.get(`/tv/${id}`, { append_to_response: 'external_ids' }, tmdbTvDetails, ctx);
  if (asSeries !== null && titleSimilarity(parsed.title, asSeries.name) >= CORROBORATION) {
    return { media: normalizeSeries(asSeries), confidence: 1 };
  }
  return null;
}

async function detailsForMovie(
  client: TmdbClient, id: number, ctx: ResolveContext,
): Promise<ResolveOutcome | null> {
  const details = await client.get(
    `/movie/${id}`, { append_to_response: 'credits' }, tmdbMovieDetails, ctx,
  );
  return details === null ? null : { media: normalizeMovie(details), confidence: 1 };
}

async function detailsForSeries(
  client: TmdbClient, id: number, ctx: ResolveContext,
): Promise<ResolveOutcome | null> {
  const details = await client.get(`/tv/${id}`, { append_to_response: 'external_ids' }, tmdbTvDetails, ctx);
  return details === null ? null : { media: normalizeSeries(details), confidence: 1 };
}

export function createTmdbProvider(client: TmdbClient): Provider {
  return {
    name: 'tmdb',
    supports(category: Category): boolean {
      return category === 'movies' || category === 'tv';
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      ctx.signal.throwIfAborted();
      // A scene parse means the caller filed this under a category this
      // provider does not serve, and the pipeline routed it here anyway
      // because the filename named a TMDB record. There is no title search to
      // fall back on in that case -- only the id.
      if (parsed.kind === 'scene') return resolveAcrossNamespaces(client, parsed, ctx);

      // Otherwise the declared category fixes the namespace. `kind` says what
      // shape the name had; it never redirects the search.
      return parsed.kind === 'movie'
        ? resolveMovie(client, parsed, ctx)
        : resolveTv(client, parsed, ctx);
    },
  };
}
