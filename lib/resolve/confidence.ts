import { foldForMatch, foldTight } from '../parse/normalize';
import type { ParsedVideo } from '../parse/types';
import { envNumber } from '../env';


export const CONFIDENCE_FLOOR = envNumber('CONFIDENCE_FLOOR', 0.75);

export interface Candidate {
  readonly title: string;
  readonly originalTitle: string | null;
  readonly year: number | null;
  readonly originCountries: readonly string[];
  /**
   * Other names the catalogue publishes for this record: TMDB's
   * `alternative_titles`, TheTVDB's `aliases`.
   *
   * A filename carries whichever name its release group used, and for anime
   * that is routinely the romaji rather than the catalogue's canonical
   * English. `ReZero kara Hajimeru Isekai Seikatsu` against
   * `Re:ZERO -Starting Life in Another World-` scores 0.316, so the search
   * found the right series and the score then threw it away. The romaji is
   * in TMDB's own alternative titles, verbatim.
   *
   * Optional so a caller with none says nothing rather than something empty.
   */
  readonly aliases?: readonly string[];
  readonly popularity: number;
  readonly voteCount: number;
  /** Null when not yet known — a search result has not been detail-fetched. */
  readonly seasonExists: boolean | null;
  readonly episodeExists: boolean | null;
}

/** Levenshtein, iterative and allocation-light. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * 1 for a fold-equal match, decaying with edit distance. Folding is what makes
 * `90 Day Fiance` and `90 Day Fiancé` identical here.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = foldForMatch(a);
  const right = foldForMatch(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  // Same string, differently punctuated: `MASH` against `M*A*S*H`, `SWAT`
  // against `S.W.A.T.`, `Spiderman` against `Spider-Man`. Edit distance
  // over the spaced fold reads those as near misses -- 0.571 for the first
  // -- because it counts the separators as characters that differ. They
  // are one title wearing punctuation, so they score as one title.
  if (foldTight(a) === foldTight(b)) return 1;
  const distance = editDistance(left, right);
  const longest = Math.max(left.length, right.length);
  return Math.max(0, 1 - distance / longest);
}

/** The year a caller effectively asserted: the parsed year, or a `(2019)` hint. */
function assertedYear(parsed: ParsedVideo): number | null {
  if (parsed.year !== null) return parsed.year;
  const hint = parsed.hints.disambiguator;
  if (hint === null || !/^\d{4}$/.test(hint)) return null;
  const year = Number.parseInt(hint, 10);
  return year >= 1900 && year <= 2099 ? year : null;
}

/** A `(US)` or `(UK)` directory hint, as a two-letter country code. */
function assertedCountry(parsed: ParsedVideo): string | null {
  const hint = parsed.hints.disambiguator;
  if (hint === null) return null;
  const upper = hint.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return upper === 'UK' ? 'GB' : upper;
}

export function scoreCandidate(parsed: ParsedVideo, candidate: Candidate): number {
  // Title similarity dominates: it is the only signal about identity rather
  // than plausibility. Everything below adjusts it.
  const direct = titleSimilarity(parsed.title, candidate.title);
  const original = candidate.originalTitle === null
    ? 0
    : titleSimilarity(parsed.title, candidate.originalTitle);
  // The best of every name the record goes by, never an average: a record
  // with forty alternative titles is not a worse match for having
  // thirty-nine that do not apply.
  const aliased = (candidate.aliases ?? []).reduce(
    (best, alias) => Math.max(best, titleSimilarity(parsed.title, alias)), 0,
  );
  let score = Math.max(direct, original, aliased) * 0.7;

  const wanted = assertedYear(parsed);
  if (wanted !== null && candidate.year !== null) {
    const gap = Math.abs(wanted - candidate.year);
    // Off-by-one is common: a provider's date and a release group's label
    // disagree across a new year all the time.
    if (gap === 0) score += 0.25;
    else if (gap === 1) score += 0.12;
    else score -= 0.35;
  }

  const country = assertedCountry(parsed);
  if (country !== null && candidate.originCountries.length > 0) {
    score += candidate.originCountries.includes(country) ? 0.08 : -0.08;
  }

  if (candidate.seasonExists === false) score -= 0.4;
  if (candidate.episodeExists === false) score -= 0.4;
  if (candidate.seasonExists === true && candidate.episodeExists === true) score += 0.12;

  // Directory-sourced titles are weaker evidence than the filename's own.
  if (parsed.hints.fromDirectories.length > 0) score -= 0.04;
  if (parsed.kind === 'episode' && parsed.yearSeason) score -= 0.05;

  // Popularity is a tiebreak and nothing more. Capped small enough that it can
  // never lift a wrong title over a right one.
  const popular = Math.log10(Math.max(1, candidate.popularity) + 1);
  const voted = Math.log10(Math.max(1, candidate.voteCount) + 1);
  score += Math.min(0.03, popular * 0.006) + Math.min(0.02, voted * 0.004);

  return Math.min(1, Math.max(0, score));
}

/**
 * What an exact title match is worth, beyond the similarity it already scores.
 *
 * Title similarity contributes at most 0.7, and the +0.25 for a matching year
 * is unavailable to a name that carries no year. So `The Dark Knight
 * Rises.mp4` -- a clean library filename matching one film perfectly -- capped
 * around 0.73 and fell under the 0.75 floor. It found the right film and
 * reported `unresolved`.
 *
 * An exact match is categorically better evidence than a near one, and nothing
 * in the score said so: a 0.95-similar title and an identical one differed by
 * 0.035. This closes that gap without lifting near misses, which still need a
 * year to clear the floor.
 */
const EXACT_TITLE_BONUS = 0.1;

/**
 * Fold-equal against any name the provider gives for the record.
 *
 * Aliases count. One is a name the catalogue itself publishes, so matching
 * it exactly is an exact match -- and it is the whole point here, since the
 * romaji title an anime filename carries is an alias rather than the
 * canonical one. `pickBest` still withholds the bonus when two candidates
 * match, which aliases make commoner; that rule is unchanged and is what
 * keeps two same-named shows from being settled by a coin flip.
 */
function matchesExactly(parsed: ParsedVideo, candidate: Candidate): boolean {
  const wanted = foldTight(parsed.title);
  if (wanted.length === 0) return false;
  // Compared tight, so a title that differs only in how it is punctuated
  // counts as the exact match it is.
  const names = [
    candidate.title,
    ...(candidate.originalTitle === null ? [] : [candidate.originalTitle]),
    ...(candidate.aliases ?? []),
  ];
  return names.some((name) => wanted === foldTight(name));
}

/**
 * The score for a candidate that has already been chosen, with the
 * exact-title bonus applied.
 *
 * `pickBest` owns that bonus, and it runs on *search* results -- which
 * carry no alternative titles, because TMDB only returns them on a detail
 * fetch. So an exact match through an alias earned the similarity and
 * never the bonus: `MASH.S11` against a series TMDB also publishes as
 * `MASH` scored 0.7228, under the floor, for want of the 0.1 the bonus
 * exists to give. That is the same number, and the same cause, as the
 * `The Dark Knight Rises` case `EXACT_TITLE_BONUS` was written for.
 *
 * One difference from `pickBest` worth stating: that function withholds
 * the bonus when *two* candidates match exactly, because an exact match
 * cannot settle a tie it is party to. Here there is one candidate and the
 * choice is already made, so the guard has nothing to weigh -- the bonus
 * moves the confidence reported, never the record returned.
 */
export function scoreResolved(parsed: ParsedVideo, candidate: Candidate): number {
  const score = scoreCandidate(parsed, candidate);
  return matchesExactly(parsed, candidate) ? Math.min(1, score + EXACT_TITLE_BONUS) : score;
}

export function pickBest<T>(
  parsed: ParsedVideo,
  items: readonly T[],
  toCandidate: (item: T) => Candidate,
): { readonly item: T; readonly confidence: number } | null {
  const scored = items.map((item) => {
    const candidate = toCandidate(item);
    return { item, exact: matchesExactly(parsed, candidate), confidence: scoreCandidate(parsed, candidate) };
  });

  // The bonus is awarded only when one candidate matches exactly. Two films
  // sharing a title -- `Ghosts` (2019, GB) and `Ghosts` (2021, US) both exist
  // -- are not disambiguated by an exact match; they are the case an exact
  // match cannot settle. Lifting both would turn a safe refusal into a
  // confident coin flip decided by popularity.
  const exact = scored.filter((s) => s.exact);
  if (exact.length === 1) {
    const only = exact[0];
    if (only !== undefined) only.confidence = Math.min(1, only.confidence + EXACT_TITLE_BONUS);
  }

  let best: { item: T; confidence: number } | null = null;
  for (const { item, confidence } of scored) {
    if (best === null || confidence > best.confidence) best = { item, confidence };
  }
  return best;
}
