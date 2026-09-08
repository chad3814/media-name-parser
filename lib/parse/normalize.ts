export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'mkv', 'mp4', 'avi', 'wmv', 'mov', 'm4v', 'mpg', 'mpeg', 'flv', 'ts',
  // `nzb` and `torrent` are metafiles rather than media, but each names a
  // release and neither belongs in a title, so both are stripped like any
  // container. `nzb` covers the indexer corpora; `torrent` is its
  // BitTorrent counterpart.
  'webm', 'iso', 'm2ts', 'nzb', 'torrent',
]);

/**
 * Recognised in order to refuse. A subtitle or a Plex sidecar is not a
 * lookup failure — refusing it is the correct answer — so these are named
 * rather than left to fall through as unknown.
 */
export const SIDECAR_EXTENSIONS: ReadonlySet<string> = new Set([
  'nfo', 'srt', 'sub', 'idx', 'ass', 'ssa', 'vtt', 'txt', 'jpg', 'jpeg',
  'png', 'webp', 'plexmatch', 'md5', 'sfv', 'par2',
]);

/**
 * What the name's trailing segment turned out to be.
 *
 * `none` covers both an absent extension and an unrecognised trailing
 * segment, because those are the same situation: nothing was stripped and the
 * whole basename is the name.
 */
export type ExtensionKind = 'media' | 'sidecar' | 'none';

export interface SplitInput {
  readonly stem: string;
  /** The recognised extension, lowercased. Null when nothing was stripped. */
  readonly extension: string | null;
  /** Nearest directory first, so `ancestors[0]` is the containing folder. */
  readonly ancestors: readonly string[];
  readonly extensionKind: ExtensionKind;
}

/**
 * Splits a name into the parts the parser needs, stripping only an extension
 * it recognises.
 *
 * An extension is optional. A caller may have nothing but a title -- another
 * service handing over a name it never had a file for -- and requiring one
 * was an arbitrary gate.
 *
 * But an unrecognised trailing segment must not be stripped on the assumption
 * that it is an extension, because `lastIndexOf('.')` cannot tell one from the
 * last segment of a dotted release name.
 * `The.Matrix.1999.1080p.BluRay.x264-GRP` would surrender its release group,
 * and `Movie.Part.2` its `2`. So an extension is stripped only when it is one
 * we know, and otherwise the basename is left whole.
 *
 * A leading-dot basename is reported as a sidecar rather than as a name.
 * `.plexmatch` is a file about media, not a media file, and it was previously
 * refused for having "no extension" -- a reason that no longer refuses
 * anything.
 */
export function splitInput(input: string): SplitInput {
  // Trimmed because a name pasted from a shell or a spreadsheet arrives with a
  // trailing space, and that space lands in the extension rather than the
  // stem: `mkv ` is not in MEDIA_EXTENSIONS, so a real release gets refused as
  // "not a media file". The stem is unaffected, so no stored key changes.
  const segments = input.trim().split('/').filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? '';
  const ancestors = segments.slice(0, -1).reverse();

  const dot = basename.lastIndexOf('.');
  if (dot === 0) {
    return { stem: basename, extension: null, ancestors, extensionKind: 'sidecar' };
  }
  if (dot < 0) {
    return { stem: basename, extension: null, ancestors, extensionKind: 'none' };
  }

  const candidate = basename.slice(dot + 1).toLowerCase();
  if (MEDIA_EXTENSIONS.has(candidate)) {
    return {
      stem: basename.slice(0, dot), extension: candidate, ancestors, extensionKind: 'media',
    };
  }
  if (SIDECAR_EXTENSIONS.has(candidate)) {
    return {
      stem: basename.slice(0, dot), extension: candidate, ancestors, extensionKind: 'sidecar',
    };
  }
  // Unrecognised: not an extension as far as we can tell, so nothing is
  // stripped and the trailing segment stays part of the name.
  return { stem: basename, extension: null, ancestors, extensionKind: 'none' };
}

const BRACKETS = /[[\](){}]/g;
const SEPARATORS = /[._\s-]+/g;

function normalizeSegment(segment: string): string {
  return segment
    .normalize('NFC')
    .toLowerCase()
    .replace(BRACKETS, ' ')
    .replace(SEPARATORS, ' ')
    .trim();
}

/**
 * The cache key. Directory structure is preserved (normalized per segment,
 * rejoined with `/`) because two different shows can own the same basename;
 * within a segment, separators and bracketing are flattened so that a dotted
 * and a space-separated spelling of one release collapse to the same key.
 */
export function normalizeKey(input: string): string {
  const split = splitInput(input);
  const ordered = [...split.ancestors].reverse();
  return [...ordered, split.stem]
    .map(normalizeSegment)
    .filter((part) => part.length > 0)
    .join('/');
}

const DIACRITICS = /\p{Diacritic}/gu;
const APOSTROPHES = /['‘’`]/g;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/**
 * For comparing a parsed title against a provider's. Diacritics are folded
 * and apostrophes dropped so that `90 Day Fiance` matches `90 Day Fiancé`.
 * Never use this for a stored title — it is lossy on purpose.
 */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(APOSTROPHES, '')
    .toLowerCase()
    .replace(NON_ALNUM, ' ')
    .trim();
}

const NON_ALNUM_ASCII = /[^a-z0-9]/g;

/**
 * A site name reduced to the one spelling both sides of the site cache
 * compare on: lowercased, with everything that is not a letter or a digit
 * removed.
 *
 * Three independent copies of a site's name have to meet here, and they are
 * punctuated differently. The filename glues it into one token
 * (`Passion-HD`, `18Lust`), the library path's directory writes it again by
 * hand, and `parseScene` joins a multi-token head with spaces (`Passion HD`)
 * -- while theporndb.net's `site.short_name` is always bare alphanumerics
 * (`passionhd`). Merely lowercasing left all 271 corpus names with a spaced
 * site permanently unable to match a cached row, so every one of them skipped
 * the three indexed date queries and stayed unresolved.
 *
 * It lives here rather than in `lib/parse/scene.ts` because both the parser
 * and the TPDB provider need it, and the provider must not reach into the
 * parser's internals to get it -- `foldForMatch` above is shared the same way.
 *
 * Lossy on purpose, like `foldForMatch`: never store the result as a display
 * name.
 */
export function normalizeSiteName(name: string): string {
  return name.toLowerCase().replace(NON_ALNUM_ASCII, '');
}
