export const PARSER_VERSION = 1;

export type Marker =
  | {
      readonly kind: 'episode';
      readonly season: number;
      readonly episodes: readonly number[];
      readonly yearSeason: boolean;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'season';
      readonly season: number;
      readonly yearSeason: boolean;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'disc';
      readonly season: number | null;
      readonly disc: number;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'date'; readonly date: string; readonly start: number; readonly end: number }
  | { readonly kind: 'absolute'; readonly episode: number; readonly start: number; readonly end: number };

const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

function isYearSeason(season: number): boolean {
  return season >= YEAR_MIN && season <= YEAR_MAX;
}

function range(from: number, to: number): readonly number[] {
  if (to < from) return [from];
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/**
 * Ordered because the patterns overlap. `S2026.08.25` must be read as a date
 * before the bare-season rule claims `S2026`; `S03D03` must be read as a disc
 * before the bare-season rule claims `S03`; and the range form `S02E01-E02`
 * must be tried before the single-episode form, which would otherwise match
 * its prefix and silently drop the second episode.
 */
const SEASON_DATE = /(?:^|[^A-Za-z0-9])S((?:19|20)\d{2})[._\s-](\d{2})[._\s-](\d{2})(?![0-9])/i;
const EPISODE_RANGE = /(?:^|[^A-Za-z0-9])S(\d{1,4})[._\s]?E(\d{1,3})[._\s]?-[._\s]?E(\d{1,3})(?![0-9])/i;
const EPISODE_REPEAT = /(?:^|[^A-Za-z0-9])S(\d{1,4})[._\s]?E(\d{1,3})(?:[._\s-]?E(\d{1,3}))+(?![0-9])/i;
const EPISODE_SINGLE = /(?:^|[^A-Za-z0-9])S(\d{1,4})[._\s]?E(\d{1,3})(?![0-9])/i;
const SEASON_DISC = /(?:^|[^A-Za-z0-9])S(\d{1,3})D(\d{1,2})(?![0-9])/i;
const BARE_DISC = /(?:^|[^A-Za-z0-9])DISC[._\s]?(\d{1,2})(?![0-9])/i;
// The leading class excludes alphanumerics but NOT `.`: scene names are
// dot-separated, so `Some.Show.2x04` needs a dot to be admissible. Excluding
// digits is what guards against matching inside `1920x1080`, and against
// `x264`/`x265`, where no digit sits immediately before the `x`.
const NUMERIC_SXE = /(?:^|[^A-Za-z0-9])(\d{1,2})x(\d{2})(?![0-9])/i;
const WORDY = /(?:^|[^A-Za-z0-9])Season[._\s]+(\d{1,3})(?:[._\s]+Episode[._\s]+(\d{1,3}))?(?![0-9])/i;
const ISO_DATE = /(?:^|[^0-9])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![0-9])/;
const DOTTED_DATE = /(?:^|[^0-9])((?:19|20)\d{2})[._\s](\d{2})[._\s](\d{2})(?![0-9])/;
const BARE_SEASON = /(?:^|[^A-Za-z0-9])S(\d{1,3})(?![0-9EDed])/i;

/** The offset of the match's meaningful start, skipping the leading delimiter. */
function bounds(match: RegExpExecArray): { readonly start: number; readonly end: number } {
  const raw = match[0];
  const lead = /^[^A-Za-z0-9]/.test(raw) ? 1 : 0;
  return { start: match.index + lead, end: match.index + raw.length };
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function findMarker(stem: string): Marker | null {
  const seasonDate = SEASON_DATE.exec(stem);
  if (seasonDate !== null) {
    const year = num(seasonDate[1]);
    const month = num(seasonDate[2]);
    const day = num(seasonDate[3]);
    if (year !== null && month !== null && day !== null) {
      return { kind: 'date', date: `${year}-${pad(month)}-${pad(day)}`, ...bounds(seasonDate) };
    }
  }

  const rangeMatch = EPISODE_RANGE.exec(stem);
  if (rangeMatch !== null) {
    const season = num(rangeMatch[1]);
    const from = num(rangeMatch[2]);
    const to = num(rangeMatch[3]);
    if (season !== null && from !== null && to !== null) {
      return {
        kind: 'episode', season, episodes: range(from, to),
        yearSeason: isYearSeason(season), ...bounds(rangeMatch),
      };
    }
  }

  const repeat = EPISODE_REPEAT.exec(stem);
  if (repeat !== null) {
    const season = num(repeat[1]);
    if (season !== null) {
      // A repeated group only captures its last iteration, so re-scan the
      // matched text for every E number.
      const episodes = [...repeat[0].matchAll(/E(\d{1,3})/gi)]
        .map((m) => num(m[1]))
        .filter((n): n is number => n !== null);
      if (episodes.length > 1) {
        return {
          kind: 'episode', season, episodes,
          yearSeason: isYearSeason(season), ...bounds(repeat),
        };
      }
    }
  }

  const single = EPISODE_SINGLE.exec(stem);
  if (single !== null) {
    const season = num(single[1]);
    const episode = num(single[2]);
    if (season !== null && episode !== null) {
      return {
        kind: 'episode', season, episodes: [episode],
        yearSeason: isYearSeason(season), ...bounds(single),
      };
    }
  }

  const seasonDisc = SEASON_DISC.exec(stem);
  if (seasonDisc !== null) {
    const season = num(seasonDisc[1]);
    const disc = num(seasonDisc[2]);
    if (season !== null && disc !== null) {
      return { kind: 'disc', season, disc, ...bounds(seasonDisc) };
    }
  }

  const bareDisc = BARE_DISC.exec(stem);
  if (bareDisc !== null) {
    const disc = num(bareDisc[1]);
    if (disc !== null) return { kind: 'disc', season: null, disc, ...bounds(bareDisc) };
  }

  const numeric = NUMERIC_SXE.exec(stem);
  if (numeric !== null) {
    const season = num(numeric[1]);
    const episode = num(numeric[2]);
    if (season !== null && episode !== null) {
      return {
        kind: 'episode', season, episodes: [episode],
        yearSeason: false, ...bounds(numeric),
      };
    }
  }

  const wordy = WORDY.exec(stem);
  if (wordy !== null) {
    const season = num(wordy[1]);
    const episode = num(wordy[2]);
    if (season !== null && episode !== null) {
      return {
        kind: 'episode', season, episodes: [episode],
        yearSeason: false, ...bounds(wordy),
      };
    }
    if (season !== null) {
      return { kind: 'season', season, yearSeason: false, ...bounds(wordy) };
    }
  }

  for (const pattern of [ISO_DATE, DOTTED_DATE]) {
    const match = pattern.exec(stem);
    if (match === null) continue;
    const year = num(match[1]);
    const month = num(match[2]);
    const day = num(match[3]);
    if (year === null || month === null || day === null) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return { kind: 'date', date: `${year}-${pad(month)}-${pad(day)}`, ...bounds(match) };
  }

  const bareSeason = BARE_SEASON.exec(stem);
  if (bareSeason !== null) {
    const season = num(bareSeason[1]);
    if (season !== null) {
      return { kind: 'season', season, yearSeason: false, ...bounds(bareSeason) };
    }
  }

  return null;
}
