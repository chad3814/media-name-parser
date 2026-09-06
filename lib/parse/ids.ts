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
