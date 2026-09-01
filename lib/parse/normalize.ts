export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'mkv', 'mp4', 'avi', 'wmv', 'mov', 'm4v', 'mpg', 'mpeg', 'flv', 'ts',
  'webm', 'iso', 'm2ts', 'nzb',
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

export interface SplitInput {
  readonly stem: string;
  readonly extension: string | null;
  /** Nearest directory first, so `ancestors[0]` is the containing folder. */
  readonly ancestors: readonly string[];
  readonly isMedia: boolean;
}

export function splitInput(input: string): SplitInput {
  // Trimmed because a name pasted from a shell or a spreadsheet arrives with a
  // trailing space, and that space lands in the extension rather than the
  // stem: `mkv ` is not in MEDIA_EXTENSIONS, so a real release gets refused as
  // "not a media file". The stem is unaffected, so no stored key changes.
  const segments = input.trim().split('/').filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? '';
  const ancestors = segments.slice(0, -1).reverse();
  const dot = basename.lastIndexOf('.');
  // A dot at index 0 is a dotfile, not an extension.
  if (dot <= 0) {
    return { stem: basename, extension: null, ancestors, isMedia: false };
  }
  const extension = basename.slice(dot + 1).toLowerCase();
  return {
    stem: basename.slice(0, dot),
    extension,
    ancestors,
    isMedia: MEDIA_EXTENSIONS.has(extension),
  };
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
