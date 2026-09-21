import type { JsonValue, ResolvedMedia } from '../types';
import { sortTitleOf } from '../tmdb/normalize';
import type { TvdbEpisode, TvdbSeries } from './schema';

function textOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

/**
 * `year` is a string on this API, and absent often enough that the first air
 * date has to stand in for it.
 */
export function yearOf(series: TvdbSeries): number | null {
  const fromYear = series.year === null || series.year === undefined
    ? Number.NaN
    : Number.parseInt(series.year, 10);
  if (!Number.isNaN(fromYear)) return fromYear;
  const aired = textOrNull(series.firstAired);
  if (aired === null) return null;
  const fromAired = Number.parseInt(aired.slice(0, 4), 10);
  return Number.isNaN(fromAired) ? null : fromAired;
}

export function normalizeSeries(series: TvdbSeries): ResolvedMedia {
  const ref = String(series.id);
  return {
    category: 'tv',
    kind: 'series',
    provider: 'tvdb',
    providerRef: ref,
    // Recorded so a later filename naming `{tvdb-121361}` is answered from
    // cache. The slug is not an id any endpoint here accepts, so it is not
    // offered as one.
    externalIds: [{ source: 'tvdb', id: ref }],
    title: series.name,
    sortTitle: sortTitleOf(series.name),
    originalTitle: null,
    releaseDate: textOrNull(series.firstAired),
    year: yearOf(series),
    overview: textOrNull(series.overview),
    raw: series as unknown as JsonValue,
    details: {
      movie: null,
      series: {
        firstAirDate: textOrNull(series.firstAired),
        lastAirDate: textOrNull(series.lastAired),
        status: textOrNull(series.status?.name),
      },
      season: null,
      episode: null,
      scene: null,
    },
    people: [],
    parent: null,
  };
}

/**
 * TheTVDB's episode flow returns no season record, so the season is
 * synthesised from the episode's own `seasonNumber` -- the same thing
 * `lib/providers/tmdb/normalize.ts` does for a TMDB season.
 *
 * The ref is compound because a season number alone is not unique across a
 * catalogue and `media` is keyed `unique(provider, provider_ref)`. Two
 * different series' first seasons must not collide onto one row.
 */
export function normalizeSeason(series: ResolvedMedia, seasonNumber: number): ResolvedMedia {
  const title = `${series.title} Season ${seasonNumber}`;
  return {
    category: 'tv',
    kind: 'season',
    provider: 'tvdb',
    providerRef: `${series.providerRef}:s${seasonNumber}`,
    // None: a synthesised season has no identifier of its own on this API,
    // and claiming one would make `media_external_ids` point at a record
    // TheTVDB cannot be asked about.
    externalIds: [],
    title,
    sortTitle: sortTitleOf(title),
    originalTitle: null,
    releaseDate: null,
    year: series.year,
    overview: null,
    raw: { seasonNumber } as JsonValue,
    details: {
      movie: null,
      series: null,
      season: { seasonNumber },
      episode: null,
      scene: null,
    },
    people: [],
    parent: series,
  };
}

export function normalizeEpisode(season: ResolvedMedia, episode: TvdbEpisode): ResolvedMedia {
  const ref = String(episode.id);
  // An untitled episode is real -- a recently-aired one often has no name yet
  // -- and an empty title would be written straight into `media.title`.
  const title = textOrNull(episode.name) ?? `Episode ${episode.number ?? 0}`;
  const aired = textOrNull(episode.aired);
  const airedYear = aired === null ? Number.NaN : Number.parseInt(aired.slice(0, 4), 10);
  return {
    category: 'tv',
    kind: 'episode',
    provider: 'tvdb',
    providerRef: ref,
    externalIds: [{ source: 'tvdb', id: ref }],
    title,
    sortTitle: sortTitleOf(title),
    originalTitle: null,
    releaseDate: aired,
    year: Number.isNaN(airedYear) ? season.year : airedYear,
    overview: textOrNull(episode.overview),
    raw: episode as unknown as JsonValue,
    details: {
      movie: null,
      series: null,
      season: null,
      episode: {
        seasonNumber: episode.seasonNumber ?? season.details.season?.seasonNumber ?? 0,
        episodeNumber: episode.number ?? 0,
        airDate: aired,
      },
      scene: null,
    },
    people: [],
    parent: season,
  };
}
