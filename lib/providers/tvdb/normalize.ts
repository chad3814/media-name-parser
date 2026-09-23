import type { JsonValue, PersonRole, ResolvedMedia, ResolvedPerson } from '../types';
import { sortTitleOf } from '../tmdb/normalize';
import type { TvdbCharacter, TvdbEpisode, TvdbSeries } from './schema';

/**
 * TheTVDB's `peopleType` onto the shared roles, mirroring `CREW_ROLES` in
 * the tmdb normaliser. Sampled live across four series: Actor, Guest Star,
 * Writer and Director are what actually appear. Producer is listed against
 * the day it does -- the vocabulary is open -- and anything unrecognised is
 * skipped rather than guessed at, as the tmdb path skips an unmapped job.
 */
const PEOPLE_TYPES: Readonly<Record<string, PersonRole>> = {
  Actor: 'performer',
  'Guest Star': 'performer',
  Writer: 'writer',
  Director: 'director',
  Producer: 'producer',
  'Executive Producer': 'producer',
};

/** Top-billed only, the same cap the tmdb path applies for the same reason. */
const CAST_LIMIT = 15;

/**
 * Credits in the order a consumer wants them: performers by billing, then
 * crew.
 *
 * Only episodes get these. `normalizeSeries` and `normalizeSeason` leave
 * `people` empty because the tmdb normaliser does the same -- there, only a
 * movie and an episode are credited -- and matching that is both the point
 * and what keeps this to a single extra call.
 */
function peopleFrom(characters: readonly TvdbCharacter[]): readonly ResolvedPerson[] {
  const performers: ResolvedPerson[] = [];
  const crew: ResolvedPerson[] = [];
  for (const character of characters) {
    const role = PEOPLE_TYPES[character.peopleType ?? ''];
    if (role === undefined) continue;
    const isPerformer = role === 'performer';
    (isPerformer ? performers : crew).push({
      // The person, never `character.id`: see `characterSchema`. Namespaced
      // like the tmdb refs so two catalogues cannot collide on a bare id.
      providerRef: `tvdb:person:${character.peopleId}`,
      name: character.personName,
      role,
      characterName: isPerformer ? textOrNull(character.name) : null,
      billingOrder: isPerformer ? character.sort ?? null : null,
      raw: character as unknown as JsonValue,
    });
  }
  performers.sort((a, b) => (a.billingOrder ?? 999) - (b.billingOrder ?? 999));
  return [...performers.slice(0, CAST_LIMIT), ...crew];
}

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
    people: peopleFrom(episode.characters),
    parent: season,
  };
}
