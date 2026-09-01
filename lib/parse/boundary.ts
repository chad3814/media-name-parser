import { isJunk, splitGroupSuffix } from './tokens';

export interface Boundary {
  readonly titleTokens: readonly string[];
  readonly junkTokens: readonly string[];
  readonly group: string | null;
  readonly year: number | null;
}

const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

function asYear(token: string): number | null {
  if (!/^\d{4}$/.test(token)) return null;
  const value = Number.parseInt(token, 10);
  return value >= YEAR_MIN && value <= YEAR_MAX ? value : null;
}

interface Candidate {
  readonly index: number;
  readonly group: string;
}

export interface TitleRegion {
  readonly titleTokens: readonly string[];
  readonly junkTokens: readonly string[];
  readonly year: number | null;
}

/**
 * The title out of a region that is *already known* to be title-only — the
 * head of a name whose marker has been stripped.
 *
 * `findBoundary` must not be used here. It assumes it is looking at a whole
 * release name and so treats a bare trailing word as a possible release
 * group, which is correct for `...Atmos.7.1.English-DarQ.HONE` and badly
 * wrong for `Moon Knight`, where it would take `Knight` as the group and
 * leave the title as `Moon`. All this needs to do is shed a trailing year and
 * any trailing vocabulary (`...Boy.Genius.FULLSCREEN.` before `S03D03`).
 */
export function findTitleRegion(tokens: readonly string[]): TitleRegion {
  let end = tokens.length;
  let year: number | null = null;
  while (end > 0) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    const candidateYear = asYear(token);
    if (candidateYear !== null) {
      year = candidateYear;
      end -= 1;
      continue;
    }
    if (isJunk(token)) {
      end -= 1;
      continue;
    }
    break;
  }
  return { titleTokens: tokens.slice(0, end), junkTokens: tokens.slice(end), year };
}

export function findBoundary(tokens: readonly string[]): Boundary {
  const candidates: Candidate[] = [];
  let cut = tokens.length;

  // One bare trailing non-vocabulary token may be a group name on its own --
  // but only where a group can actually appear, which is after the run of
  // closed-vocabulary tokens that every release name carries.
  //
  // Without that condition the rule fires on any multi-word title, because a
  // title's last word is also a bare non-vocabulary token: `The Dark Knight
  // Rises` parsed as `The Dark Knight` plus a group `Rises`, `Moon Knight` as
  // `Moon` plus `Knight`, `Blade Runner 2049` as `Blade Runner` plus `2049`,
  // losing the year with it. Each then resolved to the wrong film -- and
  // usually to a real one, its own predecessor, which is the worst way to be
  // wrong. `boundary.ts` warns about exactly this shape for `findTitleRegion`;
  // the same trap was open here.
  //
  // The corpus did not catch it. Its unqualified entries are almost all
  // `00136.m2ts` -- single tokens, with no last word to steal.
  // The test is whether this is a release name at all, not whether the group
  // sits directly after the vocabulary. Adjacency is too strict: real groups
  // trail other bare words -- `...2160p iris2 by cdrw69`, `...H-SBS
  // RealGoneKid BennuRG` -- and requiring it fed 1,148 corpus groups into
  // their titles. One closed-vocabulary token anywhere ahead of the last is
  // enough to say a release name is what we are reading; a bare title has
  // none by definition.
  const last = tokens[tokens.length - 1];
  const isVocabulary = (t: string): boolean =>
    isJunk(t) || splitGroupSuffix(t) !== null || asYear(t) !== null;
  // A compound last token can carry the evidence itself:
  // `2003-REPACK-COMPLETE-UHD-BLURAY-COASTER` and `solo-2160p-19` are release
  // tails wearing one token. A bare `2049` is not -- it has no separator, and
  // `Blade Runner 2049` must not be read as a release just because its title
  // ends in a number.
  const compoundCarriesVocabulary = (t: string): boolean => {
    const parts = t.split(/[-_]/).filter((part) => part.length > 0);
    return parts.length > 1 && parts.some(isVocabulary);
  };
  const looksLikeRelease = tokens.slice(0, -1).some(isVocabulary)
    || (last !== undefined && compoundCarriesVocabulary(last));
  if (last !== undefined && !isJunk(last) && splitGroupSuffix(last) === null
      && tokens.length > 1 && looksLikeRelease) {
    candidates.push({ index: tokens.length - 1, group: last });
    cut = tokens.length - 1;
  }

  // Walk backwards over the closed-vocabulary run. A year encountered inside
  // the run is the title boundary signal, so it is recorded here rather than
  // by a second pass — by the time the walk stops, the year is already behind
  // `titleEnd` and a later scan would look in the wrong place.
  let year: number | null = null;
  let i = cut - 1;
  for (; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token === undefined) break;
    const suffix = splitGroupSuffix(token);
    if (suffix !== null) {
      candidates.push({ index: i, group: suffix.group });
      continue;
    }
    if (isJunk(token)) continue;
    const candidateYear = asYear(token);
    if (candidateYear !== null) {
      // Leftmost year in the junk run wins, so keep overwriting.
      year = candidateYear;
      continue;
    }
    break;
  }
  const titleEnd = i + 1;

  // Leftmost candidate wins; bare non-vocabulary tokens after it are appended,
  // and a junk-hyphenated token stops the append because it starts a new tag.
  let group: string | null = null;
  const leftmost = candidates.reduce<Candidate | null>(
    (best, c) => (best === null || c.index < best.index ? c : best),
    null,
  );
  if (leftmost !== null) {
    const parts = [leftmost.group];
    for (let k = leftmost.index + 1; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (token === undefined) break;
      if (isJunk(token) || splitGroupSuffix(token) !== null) break;
      parts.push(token);
    }
    group = parts.join('.');
  }

  return {
    titleTokens: tokens.slice(0, titleEnd),
    junkTokens: tokens.slice(titleEnd),
    group,
    year,
  };
}
