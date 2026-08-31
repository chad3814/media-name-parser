import { splitInput, SIDECAR_EXTENSIONS } from './normalize';
import { tokenize } from './tokens';
import { findMarker, type Marker } from './markers';
import { findBoundary, findTitleRegion } from './boundary';
import { extractQuality, collect, titleFrom } from './extract';
import { parseScene } from './scene';
import type { Category, ParseHints, ParseResult, Quality } from './types';

const EMPTY_QUALITY: Quality = {
  resolution: null, source: null, videoCodec: null, audioCodec: null,
  hdr: [], threeD: [],
};

const SEASON_DIR = /^(?:season[._\s]*(\d{1,3})|s(\d{1,3}))$/i;
const SPECIALS_DIR = /^specials?$/i;
// Trailing separators are allowed because a library basename reads
// `Ghosts (US) - S05E12 - ...`, so the head handed here ends `Ghosts (US) - `.
const DISAMBIGUATOR = /\(([^)]+)\)[\s._\-–—]*$/;

interface DirectoryHints {
  readonly title: string | null;
  readonly year: number | null;
  readonly disambiguator: string | null;
  readonly season: number | null;
  readonly used: readonly string[];
}

function readDirectories(ancestors: readonly string[]): DirectoryHints {
  let season: number | null = null;
  const used: string[] = [];
  for (const ancestor of ancestors) {
    if (SPECIALS_DIR.test(ancestor)) {
      season ??= 0;
      used.push(ancestor);
      continue;
    }
    const seasonMatch = SEASON_DIR.exec(ancestor);
    if (seasonMatch !== null) {
      const digits = seasonMatch[1] ?? seasonMatch[2];
      if (digits !== undefined) season ??= Number.parseInt(digits, 10);
      used.push(ancestor);
      continue;
    }
    // The first ancestor that is neither a season nor a specials directory is
    // the title-bearing one. Anything above it is a library root.
    const disambiguatorMatch = DISAMBIGUATOR.exec(ancestor);
    const disambiguator = disambiguatorMatch?.[1] ?? null;
    const withoutParens = ancestor.replace(DISAMBIGUATOR, '').trim();
    const boundary = findBoundary(tokenize(withoutParens));
    const title = titleFrom(boundary.titleTokens);
    const yearFromParens =
      disambiguator !== null && /^\d{4}$/.test(disambiguator)
        ? Number.parseInt(disambiguator, 10)
        : null;
    used.push(ancestor);
    return {
      title: title.length > 0 ? title : null,
      year: boundary.year ?? yearFromParens,
      disambiguator,
      season,
      used,
    };
  }
  return { title: null, year: null, disambiguator: null, season, used };
}

function markerSuggestsSeries(marker: Marker | null): boolean {
  return marker !== null && marker.kind !== 'absolute';
}

export function parseVideo(category: Category, input: string): ParseResult {
  const split = splitInput(input);
  if (!split.isMedia) {
    // The extension is quoted because it is untrusted text that may contain a
    // character with no width. A zero-width space is category Cf rather than
    // whitespace, so trimming does not remove it, and interpolated bare it
    // produced `unknown extension .mkv` -- a refusal that reads as a bug in
    // MEDIA_EXTENSIONS instead of a bad byte in the input.
    const which = split.extension === null
      ? 'no extension'
      : SIDECAR_EXTENSIONS.has(split.extension)
        ? `sidecar ".${split.extension}"`
        : `unknown extension ".${split.extension}"`;
    return { ok: false, refusal: `not a media file (${which})` };
  }

  // The gate above stays shared so `parseScene` never re-implements refusal
  // logic; everything below it is movies/tv-specific structure that a scene
  // name does not have (no marker grammar, no year-shaped release group).
  if (category === 'xxx') return parseScene(split);

  const marker = findMarker(split.stem);
  const head = marker === null ? split.stem : split.stem.slice(0, marker.start);
  const tail = marker === null ? '' : split.stem.slice(marker.end);

  const headDisambiguator = DISAMBIGUATOR.exec(head.trim())?.[1] ?? null;
  const headClean = head.replace(DISAMBIGUATOR, ' ');
  const headTokens = tokenize(headClean);

  // With no marker, the whole stem is a release name and `findBoundary` is the
  // right tool. With a marker, the head is title-only and the tail carries the
  // junk run and the group, so each half gets the function that fits it.
  const noMarker = marker === null;
  const wholeName = noMarker ? findBoundary(headTokens) : null;
  const headRegion = noMarker ? null : findTitleRegion(headTokens);
  const tailTokens = noMarker ? [] : tokenize(tail);
  const tailBoundary = findBoundary(tailTokens);

  const headTitleTokens = wholeName?.titleTokens ?? headRegion?.titleTokens ?? [];
  const headJunkTokens = wholeName?.junkTokens ?? headRegion?.junkTokens ?? [];
  const headYear = wholeName?.year ?? headRegion?.year ?? null;

  const dirs = readDirectories(split.ancestors);

  // The basename's own title, or the directory's when the basename has none.
  // A stem with no letters is not a title: `Movies/Interstellar (2014)/00136.m2ts`
  // is a raw Blu-ray stream whose only identity lives in its parent directory.
  const rawBasenameTitle = titleFrom(headTitleTokens);
  // A numeric title is legitimate -- `360.2012.1080p...` is the film 360 --
  // so only a stem that is *entirely* digits counts as titleless. That is the
  // `Movies/Interstellar (2014)/00136.m2ts` case, a raw Blu-ray stream whose
  // only identity lives in its parent directory.
  const stemIsAllDigits = /^\d+$/.test(split.stem);
  const basenameTitle = stemIsAllDigits ? '' : rawBasenameTitle;
  const usedDirectories = basenameTitle.length > 0 ? [] : dirs.used;
  const title = basenameTitle.length > 0 ? basenameTitle : dirs.title ?? '';
  if (title.length === 0) {
    return { ok: false, refusal: 'no title found in the filename or its directories' };
  }

  // Only genuine junk, and each token once. Including the whole tail would
  // both double-count it and let an episode title called "The Special" register
  // as an edition.
  const junk = [...headJunkTokens, ...tailBoundary.junkTokens];
  const quality = junk.length > 0 ? extractQuality(junk) : EMPTY_QUALITY;
  const group = tailBoundary.group ?? wholeName?.group ?? null;
  const year = headYear ?? (basenameTitle.length > 0 ? null : dirs.year);

  const hints: ParseHints = {
    fromDirectories: usedDirectories,
    disambiguator: headDisambiguator ?? dirs.disambiguator,
    discNumber: marker !== null && marker.kind === 'disc' ? marker.disc : null,
  };

  const common = {
    title,
    year,
    quality,
    edition: collect(junk, 'edition'),
    language: collect(junk, 'language'),
    group,
    hints,
    categoryDisagreement:
      category === 'movies'
        ? markerSuggestsSeries(marker)
        : category === 'tv' && marker === null && year !== null,
  } as const;

  // The declared category fixes the shape. A `movies` lookup is always a
  // movie, even when the tokens look episodic, because the provider namespace
  // is chosen by the caller (see the spec's Non-goals on cross-category
  // fallback).
  if (category === 'movies') {
    return { ok: true, parsed: { ...common, kind: 'movie' } };
  }

  if (marker === null) {
    return { ok: true, parsed: { ...common, kind: 'series' } };
  }

  const episodeTitle = titleFrom(tailBoundary.titleTokens);

  switch (marker.kind) {
    case 'episode':
      return {
        ok: true,
        parsed: {
          ...common, kind: 'episode',
          seasonNumber: marker.season,
          episodeNumbers: marker.episodes,
          yearSeason: marker.yearSeason,
          airDate: null,
          episodeTitle: episodeTitle.length > 0 ? episodeTitle : null,
        },
      };
    case 'date':
      return {
        ok: true,
        parsed: {
          ...common, kind: 'episode',
          seasonNumber: dirs.season,
          episodeNumbers: [],
          yearSeason: false,
          airDate: marker.date,
          episodeTitle: episodeTitle.length > 0 ? episodeTitle : null,
        },
      };
    case 'season':
      return {
        ok: true,
        parsed: { ...common, kind: 'season', seasonNumber: marker.season, yearSeason: marker.yearSeason },
      };
    case 'disc': {
      // A disc is a slice of a season. No provider models discs, so resolving
      // one to an episode would be a confident wrong answer.
      const discSeason = marker.season ?? dirs.season;
      if (discSeason === null) {
        // `...Super.Mario.Bros.3.FULLSCREEN.DISC3` names a disc but no season.
        // Defaulting to season 1 would invent a fact; the show is all we know.
        return { ok: true, parsed: { ...common, kind: 'series' } };
      }
      return {
        ok: true,
        parsed: { ...common, kind: 'season', seasonNumber: discSeason, yearSeason: false },
      };
    }
    case 'absolute':
      return {
        ok: true,
        parsed: {
          ...common, kind: 'episode',
          seasonNumber: dirs.season,
          episodeNumbers: [marker.episode],
          yearSeason: false,
          airDate: null,
          episodeTitle: episodeTitle.length > 0 ? episodeTitle : null,
        },
      };
    default:
      return { ok: false, refusal: 'unrecognised marker' };
  }
}
