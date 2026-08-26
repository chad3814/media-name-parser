import { foldForMatch } from '../parse/normalize';
import type { ParsedVideo } from '../parse/types';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) ? fallback : value;
}

export const CONFIDENCE_FLOOR = envNumber('CONFIDENCE_FLOOR', 0.75);

export interface Candidate {
  readonly title: string;
  readonly originalTitle: string | null;
  readonly year: number | null;
  readonly originCountries: readonly string[];
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
  let score = Math.max(direct, original) * 0.7;

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

export function pickBest<T>(
  parsed: ParsedVideo,
  items: readonly T[],
  toCandidate: (item: T) => Candidate,
): { readonly item: T; readonly confidence: number } | null {
  let best: { item: T; confidence: number } | null = null;
  for (const item of items) {
    const confidence = scoreCandidate(parsed, toCandidate(item));
    if (best === null || confidence > best.confidence) best = { item, confidence };
  }
  return best;
}
