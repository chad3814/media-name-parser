import { tokenize, isJunk, classifyToken, splitGroupSuffix, type TokenClass } from './tokens';
import { findBoundary, findTitleRegion } from './boundary';
import { extractQuality, collect, titleFrom } from './extract';
import type { ParseHints, ParseResult } from './types';
import { normalizeSiteName, type SplitInput } from './normalize';
import type { ExternalId } from './ids';

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
 * Token classes that are machine tags and never appear as an ordinary title
 * word -- a resolution, codec, HDR flag, 3D flag or container tag has no
 * other reading. This is deliberately a *smaller* set than `isJunk`: junk
 * also includes `language` and `edition`, and those classes are stocked
 * with ordinary English words that are also real vocabulary (`DUTCH`,
 * `FRENCH`, `GERMAN`, `AD`, `HD`, `CUT`, ...). A performer or title
 * containing one of those, e.g. `Britney Dutch`, is common; a performer
 * named `2160p` is not. Case 2 below trusts a bare trailing token as a
 * group only when the token before it is one of *these* classes, precisely
 * to keep that ambiguity out of the decision.
 */
const UNAMBIGUOUS_TAG_CLASSES: ReadonlySet<TokenClass> = new Set([
  'resolution', 'source', 'videoCodec', 'audioCodec', 'hdr', 'threeD', 'container',
]);

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
 *    when the token immediately before it classifies as one of
 *    `UNAMBIGUOUS_TAG_CLASSES` (`MP4` is a container). This used to accept
 *    *any* junk class, which meant `Britney.Dutch.Delight` read as title
 *    `Britney` + group `Delight`, because `Dutch` is also a `language` tag
 *    -- the `Moon Knight` -> group `Knight` failure `findBoundary`'s own
 *    docstring warns about, one category over. Only one such token is
 *    peeled off; a second-order tag chained after it (`...MP4.WRB.XC`) is
 *    not caught and is a known, accepted gap.
 */
function extractTrailingGroup(
  tokens: readonly string[],
): { readonly tokens: readonly string[]; readonly group: string | null } {
  const last = tokens[tokens.length - 1];
  if (last === undefined) return { tokens, group: null };

  const suffix = splitGroupSuffix(last);
  if (suffix !== null) return { tokens: [...tokens.slice(0, -1), suffix.head], group: suffix.group };

  const secondLast = tokens[tokens.length - 2];
  const secondLastClass = secondLast === undefined ? null : classifyToken(secondLast);
  if (!isJunk(last) && secondLastClass !== null && UNAMBIGUOUS_TAG_CLASSES.has(secondLastClass)) {
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
 * The site-head length, in tokens, before the first valid date -- measured
 * across the corpus (12,815 names): 1 token: 8867, 2: 282, 3: 48, 4: 27,
 * then a cliff into a flat tail: 5: 103, 6: 75, 7: 93, 8: 72, 9: 75,
 * 10: 45, 11: 33.
 *
 * That shape is bimodal, not a smooth decay. A real site name gets rare
 * fast past two or three tokens; the flat tail past the cliff is not a
 * long site name, it is ordinary title text sitting in front of a *late*
 * date (`<site>.<title>.<date>.<quality>`), which the leftmost-date search
 * in `locateSceneDate` cannot tell apart from the head of a normal
 * `<site>.<date>.<title>` name on its own. The cut sits at the cliff: a
 * head of 4 tokens or fewer is the site (9,279 of the 9,872 dated names);
 * a head of 5 or more is a late date with the title still in the head
 * (593 names), handled by `splitLateSiteHead` below.
 */
const SITE_HEAD_TOKEN_CAP = 4;

/**
 * Loose equality for a token against a known site name: case-insensitive
 * and ignoring anything that isn't a letter or digit. The filename spells a
 * site as one glued token (`18Lust`, `2ChicksSameTime`), but the library
 * path's directory name is a second, independently-written copy of the same
 * name and may punctuate it differently, so an exact or merely-lowercased
 * comparison is not safe to assume.
 *
 * `normalizeSiteName` lives in `./normalize` because the TPDB provider joins
 * the parsed site against the same spelling and must not import the parser's
 * internals to do it.
 */
function tokenMatchesSite(token: string, site: string): boolean {
  return normalizeSiteName(token) === normalizeSiteName(site);
}

/**
 * Drops the leading token from `tokens` when it duplicates `site` -- used by
 * every branch that can end up with a site-repeating leading token, so the
 * comparison lives in exactly one place. Kept whole otherwise: a title that
 * merely starts with the same word the site happens to start with is not
 * evidence of duplication, and this only fires on a match of the *whole*
 * first token against the *whole* site name.
 */
function stripLeadingSiteToken(tokens: readonly string[], site: string): readonly string[] {
  const first = tokens[0];
  return first !== undefined && tokenMatchesSite(first, site) ? tokens.slice(1) : tokens;
}

/**
 * Recovers `<site>.<title>` from a head that was too long to be a site on
 * its own (see `SITE_HEAD_TOKEN_CAP`). The site is the nearest ancestor
 * directory when the path supplies one -- the library form's own
 * `Scenes/<Site>/` -- else the head's first token, matching the
 * `<site>.<title>...` shape the corpus actually uses. The leading token is
 * then dropped from the head to recover the title only when it duplicates
 * the chosen site (`stripLeadingSiteToken`); if it does not (a filename
 * that never repeats its own site name), the whole head is kept rather than
 * guessing which word to discard.
 */
function splitLateSiteHead(
  headTokens: readonly string[],
  ancestorSite: string | null,
): { readonly site: string | null; readonly titleTokens: readonly string[] } {
  const site = ancestorSite ?? headTokens[0] ?? null;
  return { site, titleTokens: site === null ? headTokens : stripLeadingSiteToken(headTokens, site) };
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
export function parseScene(
  split: SplitInput,
  /**
   * An id the filename named outright, already lifted out of the stem by
   * `parseVideo`. Spread rather than passed as a nullable field so an absent
   * id stays absent from the parse -- see `ParsedCommon.externalId`.
   */
  externalId: { readonly externalId?: ExternalId } = {},
): ParseResult {
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

  if (located !== null && located.siteTokens.length > SITE_HEAD_TOKEN_CAP) {
    // The date is late: `<site>.<title>.<date>.<quality>`. The head holds
    // both the site and the title, and the tail after the date holds only
    // quality/group junk -- there is no more title left to find there, so
    // it gets `findBoundary` (for its group detection) rather than
    // `findTitleRegion`, and the head's own trailing junk (rare, but a
    // `REMASTERED` before the date is not impossible) still goes through
    // `findTitleRegion` for the same reason the with-date branch below does.
    const ancestorSite = split.ancestors[0] ?? null;
    const { site, titleTokens: headTitleTokens } = splitLateSiteHead(located.siteTokens, ancestorSite);
    const headRegion = findTitleRegion(headTitleTokens);
    const tailBoundary = findBoundary(located.restTokens);
    const title = titleFrom(withoutSceneJunk(headRegion.titleTokens));
    const junk = [...headRegion.junkTokens, ...tailBoundary.junkTokens];
    return {
      ok: true,
      parsed: {
        ...externalId,
      kind: 'scene',
        title,
        year: Number.parseInt(located.iso.slice(0, 4), 10),
        quality: extractQuality(junk),
        edition: collect(junk, 'edition'),
        language: collect(junk, 'language'),
        group: trailingGroup ?? tailBoundary.group,
        hints,
        categoryDisagreement,
        site,
        releasedOn: located.iso,
      },
    };
  }

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
        ...externalId,
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
  //
  // A library-form name with no date still repeats its own site as the
  // filename's leading token (`Scenes/18Lust/18Lust_Lola.Haze...`), the same
  // shape `splitLateSiteHead` handles for the late-date branch above.
  // Measured at 71.7% of library-form names with no date -- fixed here
  // using the exact same `stripLeadingSiteToken` comparison so the two
  // branches cannot drift apart. This must happen *before* `findBoundary`
  // runs, not after: `findBoundary` treats a single remaining bare word as
  // a possible release group (`Scenes/DorcelClub/DorcelClub - Mariska.mp4`
  // has real content `Mariska` after `DorcelClub`), and stripping the
  // duplicate site token afterward left that word stranded in `group`
  // instead of `title`, in some names turning a wrong-but-nonempty title
  // into an empty one -- the exact regression a later review caught.
  // Stripping first removes the duplicate before that heuristic ever runs,
  // so `findBoundary` sees the same one-token input either way `Mariska`
  // would have arrived as if the filename never repeated the site at all.
  const noDateSite = split.ancestors[0] ?? null;
  const noDateTokens = noDateSite === null ? tokens : stripLeadingSiteToken(tokens, noDateSite);
  const boundary = findBoundary(noDateTokens);
  const title = titleFrom(withoutSceneJunk(boundary.titleTokens));
  return {
    ok: true,
    parsed: {
      ...externalId,
      kind: 'scene',
      title,
      year: boundary.year,
      quality: extractQuality(boundary.junkTokens),
      edition: collect(boundary.junkTokens, 'edition'),
      language: collect(boundary.junkTokens, 'language'),
      group: trailingGroup ?? boundary.group,
      hints,
      categoryDisagreement,
      site: noDateSite,
      releasedOn: null,
    },
  };
}
