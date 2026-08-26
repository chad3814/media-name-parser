import type {
  JsonValue, PersonRole, ResolvedMedia, ResolvedPerson,
} from '../types';
import type {
  TmdbEpisode, TmdbMovieDetails, TmdbSeasonDetails, TmdbTvDetails,
} from './schema';

const LEADING_ARTICLE = /^(?:the|a|an)\s+/i;

export function sortTitleOf(title: string): string {
  const lowered = title.trim().toLowerCase();
  const stripped = lowered.replace(LEADING_ARTICLE, '');
  // `The The` must not become the empty string.
  return stripped.length > 0 ? stripped : lowered;
}

export function providerRefFor(
  kind: 'movie' | 'tv' | 'season' | 'episode',
  ids: readonly number[],
): string {
  const joined = ids.join(':');
  return kind === 'movie' ? `tmdb:movie:${joined}` : `tmdb:tv:${joined}`;
}

function dateOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function textOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

/**
 * Only the crew jobs this service models. A film's credits run to hundreds of
 * names; storing a Best Boy would cost rows and buy nothing, and `media_people`
 * has no role for one.
 */
const CREW_ROLES: Readonly<Record<string, PersonRole>> = {
  Director: 'director',
  Writer: 'writer',
  Screenplay: 'writer',
  Story: 'writer',
  Producer: 'producer',
  'Executive Producer': 'producer',
  Novel: 'author',
};

/** Top-billed cast only, for the same reason. */
const CAST_LIMIT = 15;

interface RawCast {
  readonly id: number;
  readonly name: string;
  readonly character?: string | null | undefined;
  readonly order?: number | null | undefined;
}

interface RawCrew {
  readonly id: number;
  readonly name: string;
  readonly job?: string | null | undefined;
  readonly department?: string | null | undefined;
}

function peopleFrom(cast: readonly RawCast[], crew: readonly RawCrew[]): readonly ResolvedPerson[] {
  const out: ResolvedPerson[] = [];
  const ordered = [...cast].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  for (const member of ordered.slice(0, CAST_LIMIT)) {
    out.push({
      providerRef: `tmdb:person:${member.id}`,
      name: member.name,
      role: 'performer',
      characterName: textOrNull(member.character),
      billingOrder: member.order ?? null,
      raw: member as unknown as JsonValue,
    });
  }
  for (const member of crew) {
    const job = member.job ?? '';
    const role = CREW_ROLES[job];
    if (role === undefined) continue;
    out.push({
      providerRef: `tmdb:person:${member.id}`,
      name: member.name,
      role,
      characterName: null,
      billingOrder: null,
      raw: member as unknown as JsonValue,
    });
  }
  return out;
}

export function normalizeMovie(details: TmdbMovieDetails): ResolvedMedia {
  const releaseDate = dateOrNull(details.release_date);
  return {
    category: 'movies',
    kind: 'movie',
    provider: 'tmdb',
    providerRef: providerRefFor('movie', [details.id]),
    title: details.title,
    sortTitle: sortTitleOf(details.title),
    originalTitle: textOrNull(details.original_title),
    releaseDate,
    year: yearOf(releaseDate),
    overview: textOrNull(details.overview),
    raw: details as unknown as JsonValue,
    details: {
      movie: {
        runtimeMinutes: details.runtime ?? null,
        imdbId: textOrNull(details.imdb_id),
        tagline: textOrNull(details.tagline),
        collectionName: details.belongs_to_collection?.name ?? null,
      },
      series: null, season: null, episode: null,
    },
    people: peopleFrom(details.credits?.cast ?? [], details.credits?.crew ?? []),
    parent: null,
  };
}

export function normalizeSeries(details: TmdbTvDetails): ResolvedMedia {
  const firstAir = dateOrNull(details.first_air_date);
  return {
    category: 'tv',
    kind: 'series',
    provider: 'tmdb',
    providerRef: providerRefFor('tv', [details.id]),
    title: details.name,
    sortTitle: sortTitleOf(details.name),
    originalTitle: textOrNull(details.original_name),
    releaseDate: firstAir,
    year: yearOf(firstAir),
    overview: textOrNull(details.overview),
    raw: details as unknown as JsonValue,
    details: {
      movie: null,
      series: {
        firstAirDate: firstAir,
        lastAirDate: dateOrNull(details.last_air_date),
        status: textOrNull(details.status),
      },
      season: null, episode: null,
    },
    people: [],
    parent: null,
  };
}

/** `series.providerRef` is `tmdb:tv:<id>`; the numeric id is its last segment. */
function seriesIdOf(series: ResolvedMedia): number {
  const last = series.providerRef.split(':').at(-1) ?? '';
  const id = Number.parseInt(last, 10);
  if (Number.isNaN(id)) throw new Error(`cannot read a series id from ${series.providerRef}`);
  return id;
}

export function normalizeSeason(series: ResolvedMedia, season: TmdbSeasonDetails): ResolvedMedia {
  const airDate = dateOrNull(season.air_date);
  return {
    category: 'tv',
    kind: 'season',
    provider: 'tmdb',
    providerRef: providerRefFor('season', [seriesIdOf(series), season.season_number]),
    title: season.name,
    sortTitle: sortTitleOf(season.name),
    originalTitle: null,
    releaseDate: airDate,
    year: yearOf(airDate),
    overview: textOrNull(season.overview),
    raw: season as unknown as JsonValue,
    details: {
      movie: null, series: null,
      season: { seasonNumber: season.season_number },
      episode: null,
    },
    people: [],
    parent: series,
  };
}

export function normalizeEpisode(season: ResolvedMedia, episode: TmdbEpisode): ResolvedMedia {
  const parentSeries = season.parent;
  if (parentSeries === null) throw new Error('a season passed to normalizeEpisode has no series');
  const airDate = dateOrNull(episode.air_date);
  return {
    category: 'tv',
    kind: 'episode',
    provider: 'tmdb',
    providerRef: providerRefFor('episode', [
      seriesIdOf(parentSeries), episode.season_number, episode.episode_number,
    ]),
    title: episode.name,
    sortTitle: sortTitleOf(episode.name),
    originalTitle: null,
    releaseDate: airDate,
    year: yearOf(airDate),
    overview: textOrNull(episode.overview),
    raw: episode as unknown as JsonValue,
    details: {
      movie: null, series: null, season: null,
      episode: {
        seasonNumber: episode.season_number,
        episodeNumber: episode.episode_number,
        airDate,
      },
    },
    // The season payload already carries per-episode crew and guest stars,
    // which is why episode resolution needs no separate credits call.
    people: peopleFrom(episode.guest_stars, episode.crew),
    parent: season,
  };
}
