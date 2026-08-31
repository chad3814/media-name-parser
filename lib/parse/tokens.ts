export type TokenClass =
  | 'resolution'
  | 'source'
  | 'videoCodec'
  | 'audioCodec'
  | 'hdr'
  | 'language'
  | 'edition'
  | 'streaming'
  | 'threeD'
  | 'ancillary'
  | 'container';

const SOURCE = new Set([
  'WEB-DL', 'WEBDL', 'WEB', 'WEBRIP', 'WEB-RIP', 'SITERIP', 'BLURAY', 'BLU-RAY',
  'BDRIP', 'BRRIP', 'DVDRIP', 'HDTV', 'AHDTV', 'SDTV', 'PDTV', 'DVD', 'DVD5',
  'DVD9', 'DVDR', 'REMUX', 'SATFEED', 'LIVESTREAM', 'UHD', 'HDDVD', 'VHS',
  'SCREENER', 'CAM', 'TS',
  // From the corpus blocking-token census.
  'BLURAYRIP', 'BR', 'ULTRAHD', '4K', '8K', 'HDLIGHT', 'WEBDLRIP', 'BDMV',
]);

const VIDEO_CODEC = new Set([
  'X264', 'X265', 'H264', 'H265', 'H.264', 'H.265', 'HEVC', 'AVC', 'AV1',
  'XVID', 'DIVX', 'VP9', 'MPEG2', 'VC-1', 'VC1', 'MPEG4',
]);

const AUDIO_CODEC = new Set([
  'AAC', 'AC3', 'EAC3', 'DD', 'DDP', 'DD+', 'DTS', 'DTS-HD', 'DTS-HD-MA',
  'DTSHD', 'DTS-X', 'DTSX', 'TRUEHD', 'ATMOS', 'FLAC', 'OPUS', 'MP3', 'LPCM',
  'PCM', 'MA', 'AAC2', 'DDP2', 'DOLBYD', 'DD5', 'DTSHDMA', 'DTS-HD.MA',
]);

const HDR = new Set([
  'HDR', 'HDR10', 'HDR10+', 'HDR10P', 'DV', 'DOVI', 'SDR', '10BIT', '8BIT',
  '10BITS', 'HLG',
]);

const LANGUAGE = new Set([
  'MULTI', 'DUAL', 'DUAL-AUDIO', 'NORDIC', 'VFI', 'VFF', 'VOSTFR', 'MULTISUBS',
  'MULTIAUDIOS', 'SUBBED', 'DUBBED', 'DUB', 'ENGLISH', 'FRENCH', 'GERMAN',
  'SPANISH', 'ITALIAN', 'RUSSIAN', 'DUTCH', 'JAPANESE', 'POLISH', 'CZECH',
  'ARABIC', 'PT-BR', 'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JPN',
  // Deliberately absent: 'IT'. It is the title of a film.
  'VFQ', 'VOF', 'VOSTA', 'TRUEFRENCH', 'VF', 'VF1', 'VF2',
  // Deliberately absent: the two-letter codes EN, DE, NL, SE, NO, DK, FI.
  // They are ordinary title words -- No Time to Die, Spider-Man: No Way Home,
  // Hauru no ugoku shiro -- and a handful of `MULTi.En.De` releases is not
  // worth losing them.
]);

const EDITION = new Set([
  'REPACK', 'PROPER', 'INTERNAL', 'UNRATED', 'UNCUT', 'UNCENSORED', 'EXTENDED',
  'REMASTERED', 'REMASTER', 'DIRECTORS', 'DIRECTORSCUT', 'SPECIAL', 'EDITION',
  'EDITIONS', 'FULLSCREEN', 'WIDESCREEN', 'FORCED', 'LIMITED', 'THEATRICAL',
  'SPEC', 'IMAX', 'BONUS',
  // From the corpus blocking-token census. 'CUT' and 'AD' only ever apply
  // inside a trailing junk run, so `Ad Astra` and a film called `Cut` are safe.
  'CUT', 'HC', 'CONV', 'AD', 'RERIP',
]);

const STREAMING = new Set([
  'NF', 'AMZN', 'MAX', 'HMAX', 'DSNP', 'OSN', 'PCOK', 'RTLP', 'TNAP', 'YT',
  'ATVP', 'HULU', 'STAN', 'CRAV', 'CR', 'ROKU', 'PMTP', 'SHO',
  'SONYLIV', 'HBOMAX', 'MGMP', 'FLMC', 'CEE', 'ZEE5', 'JIO', 'SKST',
  // Deliberately absent: 'IP' and 'RED'. Both are common title words -- IP Man,
  // Red River, Red Dawn -- and a streaming-service tag is not worth losing them.
]);

// Only `mp4` -- not `mkv`/`avi`/etc -- because mid-name `.mp4.` is the one
// container tag measured to occur 0 times in the movies and tv corpora
// (`...2160p.MP4-WRB` is a real xxx release shape). Adding the rest of the
// container family was not measured against those corpora, so it stays out
// until it is.
const CONTAINER = new Set(['MP4']);

const THREE_D = new Set([
  '3D', 'SBS', 'HALF-SBS', 'HALF-OU', 'OU', 'RBG', 'MVC', 'ANAGLYPH',
  // `Half.SBS` splits to a bare `Half`, and the scene also writes `H-SBS`,
  // `F-SBS`, `H-OU`, `F-OU`.
  'HALF', 'FULL-SBS', 'H-SBS', 'F-SBS', 'H-OU', 'F-OU', 'HSBS', 'FSBS', 'HOU',
]);

const ANCILLARY = new Set([
  'NTSC', 'PAL', 'USA', 'HYBRID', 'DEF', 'HQ', 'LQ', 'SD', 'HD', 'FHD',
  'RERIP', 'READNFO', 'DL',
  // Site and uploader tags. Dot-splitting destroys the domain shape of
  // `yts.gg-yts.bz`, so the fragments are listed individually.
  'YTS', 'GG', 'BZ', 'MX', 'RARBG', 'TGX', 'GALAXYRG', '1337X',
  // Describes a whole-disc dump, not a source; as a source it would outrank
  // the BLURAY that follows it.
  'COMPLETE',
]);

const RESOLUTION = /^\d{3,4}[pi]$/i;
const FRAMERATE = /^\d{2,3}fps$/i;
/** `12PM`, `1AM` — the broadcast slot of a daily show. */
const CLOCK_SLOT = /^\d{1,2}(?:AM|PM)$/i;
// Must require the dot: a lone digit is never vocabulary, or the `3` in
// `Super.Mario.Bros.3` would be eaten as a channel count.
const CHANNELS = /^[1-9]\.[0-9]$/;
const CHANNEL_SUFFIX = /[.]?[1-9]\.[0-9]$/;
const TRAILING_DIGITS = /\d+$/;

function canonical(token: string): string {
  return token.toUpperCase();
}

export function classifyToken(token: string): TokenClass | null {
  if (token.length === 0) return null;
  const upper = canonical(token);
  if (RESOLUTION.test(token)) return 'resolution';
  // Sonarr writes quality as `Source-Resolution`: `Bluray-2160p`, `HDTV-720p`,
  // `WEBDL-1080p`. When every hyphen part is vocabulary the whole token is
  // too, and it takes the class of its first part. A token with a
  // non-vocabulary part is left alone, so `Wick-Chapter` and `5.1-UnKn0wn`
  // fall through.
  if (token.includes('-') && !SOURCE.has(upper) && !AUDIO_CODEC.has(upper) && !THREE_D.has(upper)) {
    const parts = token.split('-');
    if (parts.length > 1 && parts.every((part) => part.length > 0 && classifyToken(part) !== null)) {
      const first = parts[0];
      if (first !== undefined) return classifyToken(first);
    }
  }
  if (FRAMERATE.test(token)) return 'ancillary';
  if (CLOCK_SLOT.test(token)) return 'ancillary';
  if (SOURCE.has(upper)) return 'source';
  if (VIDEO_CODEC.has(upper)) return 'videoCodec';
  if (AUDIO_CODEC.has(upper)) return 'audioCodec';
  if (HDR.has(upper)) return 'hdr';
  if (LANGUAGE.has(upper)) return 'language';
  if (EDITION.has(upper)) return 'edition';
  if (STREAMING.has(upper)) return 'streaming';
  if (THREE_D.has(upper)) return 'threeD';
  if (ANCILLARY.has(upper)) return 'ancillary';
  if (CONTAINER.has(upper)) return 'container';
  // `5.1`, `7.1`, `2.0` standing alone.
  if (CHANNELS.test(token)) return 'audioCodec';
  // `TrueHD7.1`, `AAC2.0`, `DDP2`: a vocabulary word wearing a channel layout
  // or trailing digits.
  const base = upper.replace(CHANNEL_SUFFIX, '').replace(TRAILING_DIGITS, '');
  if (base.length > 1 && AUDIO_CODEC.has(base)) return 'audioCodec';
  // `DD+Atmos`: two names joined by a plus.
  for (const part of upper.split('+')) {
    if (part.length > 1 && AUDIO_CODEC.has(part)) return 'audioCodec';
  }
  return null;
}

export function isJunk(token: string): boolean {
  return classifyToken(token) !== null;
}

/**
 * A junk compound split into its parts, so that `Bluray-2160p` contributes
 * both a source and a resolution. Anything else is returned unchanged.
 */
export function expandCompound(token: string): readonly string[] {
  if (!token.includes('-')) return [token];
  const parts = token.split('-');
  if (parts.length < 2) return [token];
  if (!parts.every((part) => part.length > 0 && classifyToken(part) !== null)) return [token];
  return parts;
}

/**
 * A group name hiding after a hyphen on an otherwise-junk token, as in
 * `5.1-UnKn0wn` or `DUAL-LACTATO`. Returns null in three cases: the whole
 * token is one vocabulary word (`WEB-DL`); the left side is not vocabulary,
 * so the hyphen is inside a title (`Wick-Chapter`); or the right side is also
 * vocabulary, so this is a Sonarr quality pair and not a group at all
 * (`Bluray-2160p`).
 */
export function splitGroupSuffix(token: string): { readonly head: string; readonly group: string } | null {
  if (isJunk(token)) return null;
  const hyphen = token.indexOf('-');
  if (hyphen <= 0 || hyphen === token.length - 1) return null;
  const head = token.slice(0, hyphen);
  const group = token.slice(hyphen + 1);
  if (!isJunk(head)) return null;
  if (isJunk(group)) return null;
  return { head, group };
}

// Brackets are separators, never part of a token. The bracketed grammar --
// `John.Wick-Chapter.3-Parabellum.[2019].[1080p...English-DarQ.HONE]` -- is
// otherwise unparseable: the year stays glued inside `[2019]` and the closing
// bracket rides along on the group name.
const SEPARATOR = /[._\s[\](){}]+/;

function isSingleLetter(part: string): boolean {
  return part.length === 1 && /\p{L}/u.test(part);
}

function endsWithDigit(part: string): boolean {
  return /\d$/.test(part);
}

/**
 * A part that is a channel count: one digit not followed by another digit or a
 * letter. `1` and `1-FraMeSToR` qualify; `3D` and `4K` must not, or
 * `Thor.2011.3D` fuses into `2011.3D`, destroying both the year and the 3D
 * marker and taking the title boundary with them.
 */
function beginsWithLoneDigit(part: string): boolean {
  return /^\d(?![\dA-Za-z])/.test(part);
}

export function tokenize(text: string): readonly string[] {
  const raw = text
    .split(SEPARATOR)
    // A hyphen adjacent to a separator is punctuation, not structure:
    // `...AC3.5.1-.JFC` would otherwise yield the token `5.1-`, which matches
    // no vocabulary and stops the boundary walk dead.
    .map((part) => part.replace(/^-+/, '').replace(/-+$/, ''))
    .filter((part) => /[\p{L}\p{N}]/u.test(part));

  // Pass 1: rejoin runs of three or more single letters into one acronym.
  const acronyms: string[] = [];
  for (let i = 0; i < raw.length; ) {
    let run = 0;
    while (i + run < raw.length && isSingleLetter(raw[i + run] ?? '')) run += 1;
    if (run >= 3) {
      acronyms.push(raw.slice(i, i + run).join('.'));
      i += run;
      continue;
    }
    const part = raw[i];
    if (part !== undefined) acronyms.push(part);
    i += 1;
  }

  // Pass 2: rejoin `H` + `264` into `H.264`.
  const codecs: string[] = [];
  for (let i = 0; i < acronyms.length; i += 1) {
    const part = acronyms[i];
    const next = acronyms[i + 1];
    // `/^\d{3}/` not `/^\d{3}$/`: the trailing part may carry a group suffix,
    // as in `H` + `264-GLOTZE`, and leaving them split hides the group.
    if (part !== undefined && next !== undefined && isSingleLetter(part) && /^\d{3}(?!\d)/.test(next)) {
      codecs.push(`${part}.${next}`);
      i += 1;
      continue;
    }
    if (part !== undefined) codecs.push(part);
  }

  // Pass 3: rejoin a digit-terminated part with a following lone digit, so
  // `MA` `5` `1` becomes `MA` `5.1` and `AAC2` `0` becomes `AAC2.0`.
  const merged: string[] = [];
  for (let i = 0; i < codecs.length; i += 1) {
    const part = codecs[i];
    const next = codecs[i + 1];
    const after = codecs[i + 2];
    const partIsYear = part !== undefined && /^(?:19|20)\d{2}$/.test(part);
    // `AC3.5.1` arrives as ['AC3','5','1']. Merging left-to-right would pair
    // AC3 with 5 and orphan the 1, so a codec only takes the digit when the
    // digit after it is not itself a lone digit -- in which case those two are
    // the channel pair and the codec keeps to itself.
    const nextPairsRight = next !== undefined && after !== undefined
      && /^\d$/.test(next) && /^\d(?![\dA-Za-z])/.test(after);
    const partIsLoneDigit = part !== undefined && /^\d$/.test(part);
    if (
      part !== undefined && next !== undefined && !partIsYear &&
      (partIsLoneDigit || !nextPairsRight) &&
      endsWithDigit(part) && beginsWithLoneDigit(next) &&
      part.length <= 12
    ) {
      merged.push(`${part}.${next}`);
      i += 1;
      continue;
    }
    if (part !== undefined) merged.push(part);
  }

  return merged;
}
