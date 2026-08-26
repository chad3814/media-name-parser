import type { Category, ParsedVideo } from '../parse/types';

/** What a jsonb column accepts. Used for the stored `raw` payloads. */
export type JsonValue =
  | string | number | boolean | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type PersonRole =
  | 'performer' | 'director' | 'producer' | 'writer'
  | 'author' | 'illustrator' | 'narrator';

export type MediaKind = 'movie' | 'series' | 'season' | 'episode' | 'book' | 'scene';
export type ProviderName = 'tmdb' | 'ibdb' | 'tpdb';

export interface ResolvedPerson {
  readonly providerRef: string;
  readonly name: string;
  readonly role: PersonRole;
  readonly characterName: string | null;
  readonly billingOrder: number | null;
  readonly raw: JsonValue;
}

export interface ResolvedDetails {
  readonly movie: {
    readonly runtimeMinutes: number | null;
    readonly imdbId: string | null;
    readonly tagline: string | null;
    readonly collectionName: string | null;
  } | null;
  readonly series: {
    readonly firstAirDate: string | null;
    readonly lastAirDate: string | null;
    readonly status: string | null;
  } | null;
  readonly season: { readonly seasonNumber: number } | null;
  readonly episode: {
    readonly seasonNumber: number;
    readonly episodeNumber: number;
    readonly airDate: string | null;
  } | null;
}

/**
 * A provider's answer: one node plus its ancestors, each carrying its own
 * people and raw payload. `parent` runs upward, so an episode's parent is its
 * season and that season's parent is the series.
 */
export interface ResolvedMedia {
  readonly category: Category;
  readonly kind: MediaKind;
  readonly provider: ProviderName;
  readonly providerRef: string;
  readonly title: string;
  readonly sortTitle: string;
  readonly originalTitle: string | null;
  readonly releaseDate: string | null;
  readonly year: number | null;
  readonly overview: string | null;
  readonly raw: JsonValue;
  readonly details: ResolvedDetails;
  readonly people: readonly ResolvedPerson[];
  readonly parent: ResolvedMedia | null;
}

export interface ResolveContext {
  readonly signal: AbortSignal;
  /** For `provider_calls.lookup_id`; null when resolving outside a lookup. */
  readonly lookupId: string | null;
}

export interface Provider {
  readonly name: ProviderName;
  supports(category: Category): boolean;
  resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolvedMedia | null>;
}

/** What the pipeline records for observability. Never contains a credential. */
export interface ProviderCallRecord {
  readonly provider: ProviderName;
  readonly endpoint: string;
  readonly status: number;
  readonly durationMs: number;
  readonly lookupId: string | null;
}
