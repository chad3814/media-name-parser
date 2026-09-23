import type { Category, ParsedVideo } from '../../parse/types';
import type { Provider, ResolveContext, ResolveOutcome, ResolvedMedia } from '../types';
import { pickBest, titleSimilarity, type Candidate } from '../../resolve/confidence';
import { foldForMatch } from '../../parse/normalize';
import { logFailure } from '../../http/log';
import type { TvdbClient } from './client';
import {
  episodesResponseSchema, extendedEpisodeResponseSchema, searchResponseSchema,
  seriesResponseSchema, type TvdbEpisode, type TvdbSearchResult, type TvdbSeries,
} from './schema';
import { normalizeEpisode, normalizeSeason, normalizeSeries, yearOf } from './normalize';

/**
 * How alike the parsed title and the series TheTVDB returned must be for the
 * row to be believed at all.
 *
 * The same sanity guard the TPDB provider grew: a record reached by an
 * inherited id or a fuzzy search still has to have some bearing on the
 * filename. This is not "is it the right series" -- `scoreCandidate` decides
 * that, and its answer is the confidence -- only "is there any reason to
 * think these two are related".
 *
 * Compared against `ctx.seriesTitle` when a primary provider handed one over,
 * and only otherwise against TheTVDB's own name. TheTVDB answers in a series'
 * primary language, so One Piece is `\u30ef\u30f3\u30d4\u30fc\u30b9`: judging a handed-over
 * match on that name scores 0.000 and throws away a correct episode. The
 * provider that established identity is the one whose title identity is
 * judged against.
 */
const MIN_SERIES_AGREEMENT = 0.30;

/** The aired order, which is what `SxxExx` in a filename means. */
const SEASON_TYPE = 'default';

/**
 * Every name a series goes by, canonical first.
 *
 * TheTVDB answers in a series' primary language, so the canonical name for
 * an anime is Japanese and the romaji a filename carries lives in the
 * aliases. Judging either the guard or the score on the canonical name
 * alone rejects the very records this provider exists to find.
 */
function namesOf(series: TvdbSeries, knownAs: string): readonly string[] {
  return [knownAs, series.name, ...series.aliases.map((alias) => alias.name)];
}

function agrees(parsedTitle: string, names: readonly string[]): boolean {
  if (foldForMatch(parsedTitle).length === 0) return false;
  return names.some((name) => titleSimilarity(parsedTitle, name) >= MIN_SERIES_AGREEMENT);
}

/**
 * A TheTVDB record as the shared scorer sees it.
 *
 * `originCountries` is deliberately empty. TheTVDB reports a three-letter
 * lowercase code (`usa`) while `assertedCountry` produces two-letter
 * uppercase, so passing it through would score an encoding difference as a
 * mismatch and dock 0.08 from a correct answer.
 *
 * `popularity` and `voteCount` are zero, contributing under 0.002 between
 * them: they are a tiebreak this API does not offer, and the score is
 * explicitly designed so they cannot lift a wrong title over a right one.
 */
function candidateOf(
  title: string,
  year: number | null,
  aliases: readonly string[],
  seasonExists: boolean | null,
  episodeExists: boolean | null,
): Candidate {
  return {
    title,
    originalTitle: null,
    year,
    aliases,
    originCountries: [],
    popularity: 0,
    voteCount: 0,
    seasonExists,
    episodeExists,
  };
}

function searchCandidate(hit: TvdbSearchResult): Candidate {
  const stated = hit.year === null || hit.year === undefined
    ? Number.NaN
    : Number.parseInt(hit.year, 10);
  const aired = hit.first_air_time === null || hit.first_air_time === undefined
    ? Number.NaN
    : Number.parseInt(hit.first_air_time.slice(0, 4), 10);
  const year = Number.isNaN(stated) ? aired : stated;
  // A search hit's aliases are bare strings, where a series record's are
  // objects. Already in the response either way.
  return candidateOf(hit.name, Number.isNaN(year) ? null : year, hit.aliases, null, null);
}

/**
 * The series' score once the season and episode are known to exist.
 *
 * This is the whole reason the shared scorer is reused rather than replaced
 * by bands of this provider's own: `scoreCandidate` already pays +0.12 when a
 * season *and* an episode are both confirmed, and that confirmation is
 * precisely what this provider produces. It also means a TheTVDB answer and a
 * TMDB answer are directly comparable, which is what lets the composite
 * substitute one for the other honestly.
 *
 * A flag the filename never asserted is passed as `null`, not `false`: a
 * series parse names no episode, and scoring it as a *missing* episode would
 * dock 0.4 for a question nobody asked. `lib/providers/tmdb/resolve.ts` does
 * the same.
 */
function scoreSeries(
  parsed: ParsedVideo, series: TvdbSeries, knownAs: string,
  seasonExists: boolean | null, episodeExists: boolean | null,
): number {
  const [canonical = knownAs, ...rest] = namesOf(series, knownAs);
  const best = pickBest(parsed, [series], (s) =>
    candidateOf(canonical, yearOf(s), rest, seasonExists, episodeExists));
  return best?.confidence ?? 0;
}

async function findSeriesRef(
  client: TvdbClient, parsed: ParsedVideo, ctx: ResolveContext,
): Promise<string | null> {
  const list = await client.get(
    '/search', { query: parsed.title, type: 'series' }, searchResponseSchema, ctx,
  );
  if (list === null || list.data.length === 0) return null;
  const best = pickBest(parsed, list.data, searchCandidate);
  if (best === null) return null;
  return agrees(parsed.title, [best.item.name, ...best.item.aliases])
    ? best.item.tvdb_id
    : null;
}

/**
 * The episode again, from the endpoint that carries its credits.
 *
 * The listing this provider resolves against returns base records with no
 * `characters`, so the cast and crew cost one more call. Paid only here,
 * after the episode has been found and the guards have passed, so a name
 * that resolves to nothing never pays it; measured at about 120ms against
 * an eight-second deadline.
 *
 * A failure is swallowed and the uncredited episode returned. Credits are
 * an enrichment, and losing them is not a reason to lose the resolution --
 * the same judgement the TPDB provider makes about its site-cache write.
 */
async function withCredits(
  client: TvdbClient, episode: TvdbEpisode, ctx: ResolveContext,
): Promise<TvdbEpisode> {
  try {
    const body = await client.get(
      `/episodes/${encodeURIComponent(String(episode.id))}/extended`, {},
      extendedEpisodeResponseSchema, ctx,
    );
    // Only the credits are taken. The extended record is the same episode,
    // but swapping it wholesale would quietly replace fields the guards and
    // the season number were already decided from; this call was made to
    // learn one thing and that is all it contributes.
    if (body === null || body.data.characters.length === 0) return episode;
    return { ...episode, characters: body.data.characters };
  } catch (error) {
    logFailure(`tvdb credits for episode ${episode.id}`, error);
    return episode;
  }
}

export function createTvdbProvider(client: TvdbClient): Provider {
  return {
    name: 'tvdb',
    supports(category: Category): boolean {
      return category === 'tv';
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      ctx.signal.throwIfAborted();
      if (parsed.kind !== 'series' && parsed.kind !== 'season' && parsed.kind !== 'episode') {
        return null;
      }

      // The id a primary provider already established, else our own search.
      // TMDB publishes the TVDB series id for every series it knows
      // (`tmdb/normalize.ts`), so the common path costs one call and guesses
      // at nothing at all.
      const ref = ctx.seriesRef ?? await findSeriesRef(client, parsed, ctx);
      if (ref === null) return null;

      if (parsed.kind === 'episode') {
        const wantedSeason = parsed.seasonNumber;
        // The first of several, as the TMDB path does for a multi-episode
        // file: one row is returned and it is the one the name leads with.
        const wantedEpisode = parsed.episodeNumbers[0];
        if (wantedSeason === null || wantedEpisode === undefined) return null;

        const body = await client.get(
          `/series/${encodeURIComponent(ref)}/episodes/${SEASON_TYPE}`,
          { season: wantedSeason, episodeNumber: wantedEpisode },
          episodesResponseSchema, ctx,
        );
        if (body === null) return null;
        const found = body.data.episodes[0];
        // No episode is a null answer, never the season instead. Supplying
        // the episode is this provider's entire purpose, and returning its
        // parent would be the very shortfall it exists to repair.
        if (found === undefined) return null;
        // The title identity is judged against, which is not always this
        // catalogue's own: see `knownAs`.
        const knownAs = ctx.seriesTitle ?? body.data.series.name;
        if (!agrees(parsed.title, namesOf(body.data.series, knownAs))) return null;
        // Language-independent integrity check, and the only one available
        // on a handed-over id: confirm the row really belongs to the series
        // that was asked about rather than trusting the URL round-tripped.
        const belongs = found.seriesId ?? body.data.series.id;
        if (String(belongs) !== ref) return null;

        const series = normalizeSeries(body.data.series);
        const season = normalizeSeason(series, found.seasonNumber ?? wantedSeason);
        return {
          media: normalizeEpisode(season, await withCredits(client, found, ctx)),
          confidence: scoreSeries(parsed, body.data.series, knownAs, true, true),
        };
      }

      const body = await client.get(
        `/series/${encodeURIComponent(ref)}`, {}, seriesResponseSchema, ctx,
      );
      if (body === null) return null;
      const knownAs = ctx.seriesTitle ?? body.data.name;
      if (!agrees(parsed.title, namesOf(body.data, knownAs))) return null;

      const series = normalizeSeries(body.data);
      const media: ResolvedMedia = parsed.kind === 'season'
        ? normalizeSeason(series, parsed.seasonNumber)
        : series;
      return {
        media,
        // `/series/{id}` does not enumerate seasons, so a season this call
        // returned is asserted rather than confirmed -- hence `null`, not
        // `true`. Neither parse names an episode, so that stays `null` too.
        confidence: scoreSeries(parsed, body.data, knownAs, null, null),
      };
    },
  };
}
