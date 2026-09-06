import type { ExternalId } from './ids';

export type Category = 'tv' | 'movies' | 'books' | 'xxx';

export const CATEGORIES: readonly Category[] = ['tv', 'movies', 'books', 'xxx'];

export interface Quality {
  readonly resolution: string | null;
  readonly source: string | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly hdr: readonly string[];
  readonly threeD: readonly string[];
}

export interface ParseHints {
  /** Ancestor directory names that contributed, nearest first. */
  readonly fromDirectories: readonly string[];
  /** A parenthesised year or region taken from a directory, e.g. `US`, `2019`. */
  readonly disambiguator: string | null;
  readonly discNumber: number | null;
}

interface ParsedCommon {
  /**
   * A record the filename named outright, via `{tmdb-603}` or `{imdb-tt...}`.
   *
   * Optional rather than nullable so it is absent from a parse that has none.
   * `exactOptionalPropertyTypes` is on, so an absent optional property does
   * not serialise -- which keeps the 13,000 committed golden expectations
   * unchanged, since none of those names carry a token.
   */
  readonly externalId?: ExternalId;
  readonly title: string;
  readonly year: number | null;
  readonly quality: Quality;
  readonly edition: readonly string[];
  readonly language: readonly string[];
  readonly group: string | null;
  readonly hints: ParseHints;
  readonly categoryDisagreement: boolean;
}

export type ParsedVideo =
  | (ParsedCommon & { readonly kind: 'movie' })
  | (ParsedCommon & { readonly kind: 'series' })
  | (ParsedCommon & {
      readonly kind: 'season';
      readonly seasonNumber: number;
      readonly yearSeason: boolean;
    })
  | (ParsedCommon & {
      readonly kind: 'episode';
      readonly seasonNumber: number | null;
      readonly episodeNumbers: readonly number[];
      readonly yearSeason: boolean;
      readonly airDate: string | null;
      readonly episodeTitle: string | null;
    })
  | (ParsedCommon & {
      readonly kind: 'scene';
      /** The producing site. From the name's head, else the nearest ancestor. */
      readonly site: string | null;
      /** ISO `YYYY-MM-DD`. Null when the name carries no date. */
      readonly releasedOn: string | null;
    });

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedVideo }
  | { readonly ok: false; readonly refusal: string };
