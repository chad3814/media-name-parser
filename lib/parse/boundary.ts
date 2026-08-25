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

export function findBoundary(tokens: readonly string[]): Boundary {
  const candidates: Candidate[] = [];
  let cut = tokens.length;

  // One bare trailing non-vocabulary token may be a group name on its own.
  const last = tokens[tokens.length - 1];
  if (last !== undefined && !isJunk(last) && splitGroupSuffix(last) === null && tokens.length > 1) {
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
