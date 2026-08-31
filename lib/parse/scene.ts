import { tokenize, isJunk, splitGroupSuffix } from './tokens';
import { findBoundary, findTitleRegion } from './boundary';
import { extractQuality, collect, titleFrom } from './extract';
import type { ParseHints, ParseResult } from './types';
import type { SplitInput } from './normalize';

const DATE = /^(\d{4}|\d{2})[.\-_](\d{2})[.\-_](\d{2})(?![\d])[.\-_ ]?/;

/**
 * The leading date of a scene name, or null.
 *
 * Pure by contract: `YY` always becomes `20YY` and no value is checked
 * against today. Sanity-checking a year against the current date would make
 * the parse non-deterministic, and `normalized_key` is derived from it.
 */
export function parseSceneDate(text: string): { readonly iso: string; readonly rest: string } | null {
  const m = DATE.exec(text);
  if (m === null) return null;
  const [, rawYear = '', rawMonth = '', rawDay = ''] = m;
  const month = Number(rawMonth);
  const day = Number(rawDay);
  // 1.6% of date-shaped triples in the corpus are not dates.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = rawYear.length === 4 ? Number(rawYear) : 2000 + Number(rawYear);
  const iso = `${String(year).padStart(4, '0')}-${rawMonth}-${rawDay}`;
  return { iso, rest: text.slice(m[0].length) };
}

/**
 * Scene-local junk. Deliberately NOT in the shared vocabulary in
 * `lib/parse/tokens.ts`: `xXx` (2002) and `xXx: Return of Xander Cage` are
 * real movie titles, so putting the literal `XXX` tag in the global
 * vocabulary would make them unparseable. `pmv` (porn music video) is the
 * same kind of scene-only marker, never a title word elsewhere.
 */
const SCENE_JUNK: ReadonlySet<string> = new Set(['xxx', 'pmv']);

// A literal `SxxExx` marker inside an xxx-category name -- rare (11 names in
// the corpus) but real, and it means the release was miscategorised.
// Deliberately not the shared `findMarker` engine: that engine also treats a
// bare `YYYY.MM.DD` as a *date* marker, which is exactly the shape of a
// scene's own release date, so reusing it would flag every ordinary
// four-digit-year scene name as a disagreement instead of just the rare
// season/episode ones.
const SEASON_EPISODE_MARKER = /(?:^|[^A-Za-z0-9])S\d{1,3}E\d{1,3}(?![0-9])/i;

/**
 * The release group at the stem's tail, in either of the two shapes the
 * corpus actually uses. Runs before date detection because the group always
 * sits at the tail, regardless of where the date is.
 *
 * 1. Fused to the last token by a hyphen, as in `...2160p.MP4-WRB`.
 *    Stripping it turns `MP4-WRB` into a plain `MP4` token that the later
 *    junk walk can recognise and drop -- otherwise the fused token
 *    classifies as neither junk nor a bare title word and jams the walk.
 * 2. A separate trailing token after the junk run, as in `...2160p.MP4.WRB`
 *    -- measured as the dominant title-leak shape in the corpus. `WRB` here
 *    is not vocabulary, so it is only trusted as a group, not a title word,
 *    when the token immediately before it *is* vocabulary (`MP4`); an
 *    ordinary title's last two words, e.g. `Alternative Angles`, are neither.
 *    Only one such token is peeled off. A second-order tag chained after it
 *    (`...MP4.WRB.XC`) is not caught and is a known, accepted gap.
 */
function extractTrailingGroup(
  tokens: readonly string[],
): { readonly tokens: readonly string[]; readonly group: string | null } {
  const last = tokens[tokens.length - 1];
  if (last === undefined) return { tokens, group: null };

  const suffix = splitGroupSuffix(last);
  if (suffix !== null) return { tokens: [...tokens.slice(0, -1), suffix.head], group: suffix.group };

  const secondLast = tokens[tokens.length - 2];
  if (!isJunk(last) && secondLast !== undefined && isJunk(secondLast)) {
    return { tokens: tokens.slice(0, -1), group: last };
  }

  return { tokens, group: null };
}

interface SceneDateSplit {
  readonly siteTokens: readonly string[];
  readonly iso: string;
  readonly restTokens: readonly string[];
}

/**
 * The first date-shaped run in `tokens`, tried left to right so the leftmost
 * candidate wins. Every candidate is re-validated through `parseSceneDate`
 * itself -- never a copy of its regex -- so the month/day guard always
 * applies, and a match at position 0 is a legal answer (a site-less name)
 * rather than a crash.
 *
 * The remainder is re-tokenized from `parseSceneDate`'s own string `rest`
 * rather than sliced by token count, because the date is not always three
 * clean tokens: the corpus has `2.Chicks.Same.Time.2021-05-31.Jackie...`,
 * where the whole date rides in one hyphenated token. Slicing by index would
 * silently drop or duplicate tokens in that shape.
 */
function locateSceneDate(tokens: readonly string[]): SceneDateSplit | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const candidate = tokens.slice(i).join('.');
    const found = parseSceneDate(candidate);
    if (found !== null) {
      return { siteTokens: tokens.slice(0, i), iso: found.iso, restTokens: tokenize(found.rest) };
    }
  }
  return null;
}

function withoutSceneJunk(tokens: readonly string[]): readonly string[] {
  return tokens.filter((token) => !SCENE_JUNK.has(token.toLowerCase()));
}

/**
 * A scene filename or library path to a structured parse.
 *
 * Performers are deliberately NOT split out of the title -- the whole
 * post-date run becomes `title`. A corpus-mined performer dictionary caps at
 * 58% recall and cannot represent mononyms, and the provider returns
 * canonical performers anyway, so splitting here would be work the caller
 * throws away.
 */
export function parseScene(split: SplitInput): ParseResult {
  const rawTokens = tokenize(split.stem);
  const { tokens, group: trailingGroup } = extractTrailingGroup(rawTokens);
  const located = locateSceneDate(tokens);
  const categoryDisagreement = SEASON_EPISODE_MARKER.test(split.stem);
  // Every ancestor is recorded unconditionally -- unlike the movies/tv path,
  // where a directory hint is dropped once the basename supplies its own
  // title -- because a disagreement between the filename's site and the
  // directory's site (19% of library names, per the corpus census) must stay
  // inspectable even when the filename wins.
  const hints: ParseHints = { fromDirectories: split.ancestors, disambiguator: null, discNumber: null };

  if (located !== null) {
    // The tail after the date is title-only in shape -- title, then a
    // trailing junk run -- with no marker-style structure to peel apart, so
    // `findTitleRegion` is the right tool. `findBoundary` must not be used
    // here: its docstring says it treats a bare trailing word as a possible
    // release group, which would misread a title like `Alternative Angles`.
    const region = findTitleRegion(located.restTokens);
    const title = titleFrom(withoutSceneJunk(region.titleTokens));
    const site = located.siteTokens.length > 0 ? titleFrom(located.siteTokens) : null;
    return {
      ok: true,
      parsed: {
        kind: 'scene',
        title,
        year: Number.parseInt(located.iso.slice(0, 4), 10),
        quality: extractQuality(region.junkTokens),
        edition: collect(region.junkTokens, 'edition'),
        language: collect(region.junkTokens, 'language'),
        group: trailingGroup,
        hints,
        categoryDisagreement,
        site,
        releasedOn: located.iso,
      },
    };
  }

  // No date: the stem is a whole release name with no marker to anchor on,
  // so `findBoundary` -- the same call the movies path makes -- is the right
  // tool, including its own group detection as a fallback for the rare case
  // the trailing-token check above did not catch.
  const boundary = findBoundary(tokens);
  const title = titleFrom(withoutSceneJunk(boundary.titleTokens));
  return {
    ok: true,
    parsed: {
      kind: 'scene',
      title,
      year: boundary.year,
      quality: extractQuality(boundary.junkTokens),
      edition: collect(boundary.junkTokens, 'edition'),
      language: collect(boundary.junkTokens, 'language'),
      group: trailingGroup ?? boundary.group,
      hints,
      categoryDisagreement,
      site: split.ancestors[0] ?? null,
      releasedOn: null,
    },
  };
}
