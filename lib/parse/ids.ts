import { tokenize } from './tokens';
import { findBoundary } from './boundary';
import { titleFrom } from './extract';
/** Providers a filename can name an id for. `tvdb` resolves through TMDB. */
export type IdSource = 'tmdb' | 'imdb' | 'tvdb' | 'tpdb';

export interface ExternalId {
  readonly source: IdSource;
  /** Verbatim as written, minus the braces: `tt0133093`, `603`, `2012507`. */
  readonly id: string;
}

const TOKEN = /\{(tmdb|imdb|tvdb|tpdb)-([^}\s]+)\}/i;

/**
 * The Plex and Jellyfin convention for naming a record outright:
 * `The Matrix (1999) {tmdb-603}.mkv`.
 *
 * An id is not a match, it is an assertion, and it makes the whole matching
 * problem go away for the file that carries one. It has to be lifted out
 * before the rest of the parse runs, because otherwise it reads as ordinary
 * text: `{tmdb-603}` currently becomes the release *group* on a movies lookup
 * and part of the title on an xxx one.
 *
 * Only the stem is stripped. `normalizeKey` works from the raw input and keeps
 * the token, which is what it should do -- `Movie {tmdb-1}` and
 * `Movie {tmdb-2}` are different records, and a shared cache key would let one
 * be served as the answer for the other.
 *
 * The first token wins. A name carrying two is contradictory, and picking the
 * leftmost is at least predictable.
 */
export function extractExternalId(
  stem: string,
): { readonly id: ExternalId; readonly rest: string } | null {
  const match = TOKEN.exec(stem);
  if (match === null) return null;
  const source = match[1]?.toLowerCase();
  const id = match[2];
  if (source === undefined || id === undefined) return null;
  const rest = `${stem.slice(0, match.index)} ${stem.slice(match.index + match[0].length)}`;
  return {
    id: { source: source as IdSource, id },
    rest: rest.replace(/\s+/g, ' ').trim(),
  };
}

/**
 * A release group written at the *front* of the name, in brackets, parens or
 * braces: `[Onalrie] ReZero kara Hajimeru Isekai Seikatsu - S04E18`.
 *
 * The anime convention, and the tokenizer cannot see it. `[ ] ( ) { }` are
 * separators there -- deliberately, because `...Parabellum.[2019].[1080p...]`
 * otherwise keeps the year glued inside its brackets -- so by the time the
 * boundary walk runs `Onalrie` is an ordinary word and lands in the title.
 * The show is then searched for as `Onalrie ReZero kara Hajimeru Isekai
 * Seikatsu` and found nowhere, and the group is lost as well as misplaced.
 *
 * Lifted from the stem before tokenizing, for the same reason
 * `extractExternalId` is, and *after* it: `{tmdb-603}` is brace-delimited
 * too, and taking it as a group would throw away an assertion about which
 * record the file holds.
 *
 * Only a run at position 0, and only one. A later `[1080p WEBRip AV1]` is
 * quality, which the junk walk already reads correctly.
 */
const LEADING_GROUP = /^[\s._-]*[[({]([^\])}]+)[\])}][\s._-]*/;

const HAS_LETTER = /\p{L}/u;

export function extractLeadingGroup(
  stem: string,
): { readonly group: string; readonly rest: string } | null {
  const match = LEADING_GROUP.exec(stem);
  if (match === null) return null;
  const group = match[1]?.trim() ?? '';
  if (group.length === 0) return null;

  const rest = stem.slice(match[0].length);
  // `[REC]` is a real film, and so are `[REC]2` and `[REC]3`. Stripping the
  // brackets off one of those leaves `2007.1080p.BluRay.x264-GRP` -- which
  // is to say, no title at all. So a leading run is only a group when a
  // title survives without it, and the honest way to ask that is to run the
  // same boundary walk the parse itself will: it already knows that a year
  // is not a title, that `1080p` and `BluRay` are tags, and that a trailing
  // `-GRP` is a group. A hand-rolled "does a word have a letter in it" test
  // answered yes to all three.
  //
  // The letter check on the result is what separates `[REC].2007...`, whose
  // title comes back empty, from `[REC] 2 (2009)`, whose title comes back as
  // `2`. Chad reports those films are not distributed with the brackets in
  // the filename anyway, so this guards a shape rather than an observed
  // name -- cheap insurance against a whole class rather than a fix.
  const survives = titleFrom(findBoundary(tokenize(rest)).titleTokens);
  if (!HAS_LETTER.test(survives)) return null;

  return { group, rest };
}
