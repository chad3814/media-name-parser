import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { CATEGORIES, type Category } from '../parse/types';

export type ConfidenceBand = 'any' | 'high' | 'medium' | 'low' | 'none';
export const CONFIDENCE_BANDS: readonly ConfidenceBand[] = ['any', 'high', 'medium', 'low', 'none'];

export type LookupState = 'resolved' | 'unresolved' | 'pending';
export const LOOKUP_STATES: readonly LookupState[] = ['resolved', 'unresolved', 'pending'];

/** Not user-controlled: a query asking for 100000 rows is a denial of service with extra steps. */
export const PER_PAGE = 25;

export interface CacheFilters {
  readonly category: Category | null;
  readonly state: LookupState | null;
  readonly band: ConfidenceBand;
  readonly disagreementOnly: boolean;
  readonly page: number;
  readonly perPage: number;
}

export interface CacheRow {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly state: string;
  readonly confidence: number | null;
  readonly hitCount: number;
  readonly pinned: boolean;
  readonly disagreement: boolean;
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
}

export interface CachePage {
  readonly rows: readonly CacheRow[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly pageCount: number;
}

/**
 * Filters from a URL, which is user input.
 *
 * Total by construction: every unrecognised value falls back, `page` clamps to
 * at least 1, and `perPage` is not read from the query at all. Nothing here can
 * throw, and nothing user-supplied reaches SQL as a value the query did not
 * choose.
 */
export function parseFilters(params: URLSearchParams): CacheFilters {
  const one = (key: string): string | null => params.get(key);

  const rawCategory = one('category');
  const category = CATEGORIES.find((value) => value === rawCategory) ?? null;

  const rawState = one('state');
  const state = LOOKUP_STATES.find((value) => value === rawState) ?? null;

  const rawBand = one('band');
  const band = CONFIDENCE_BANDS.find((value) => value === rawBand) ?? 'any';

  const rawPage = Number.parseInt(one('page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  return {
    category,
    state,
    band,
    disagreementOnly: one('disagreement') === '1',
    page,
    perPage: PER_PAGE,
  };
}

/**
 * The band predicate.
 *
 * `low` names `IS NOT NULL` explicitly even though SQL would treat
 * `confidence < 0.75` as not-true for a NULL anyway. Being explicit means the
 * next person writing `NOT (confidence >= 0.75)` elsewhere does not get a
 * different answer, and it documents that unscored rows are `none`, not `low`.
 */
function bandPredicate(band: ConfidenceBand): SQL | null {
  switch (band) {
    case 'high': return sql`l.confidence >= 0.9`;
    case 'medium': return sql`l.confidence >= 0.75 AND l.confidence < 0.9`;
    case 'low': return sql`l.confidence IS NOT NULL AND l.confidence < 0.75`;
    case 'none': return sql`l.confidence IS NULL`;
    case 'any': return null;
  }
}

/**
 * One page of the cache, with the total for the same filters.
 *
 * `count(*) OVER ()` returns the unfiltered-by-LIMIT total alongside the rows,
 * so this is one round trip rather than two — and the total cannot disagree
 * with the page, which is what a separate count query risks under concurrent
 * writes.
 *
 * The join is LEFT rather than INNER even though `lookups_parse_fk` currently
 * guarantees a matching `parses` row for every lookup -- so today the two are
 * equivalent. LEFT because the constraint is a fact about the schema and not
 * about this query: if it is ever relaxed, an INNER join here would silently
 * start dropping rows from every unfiltered page. `COALESCE` earns its place
 * regardless, because a parse may exist whose `tokens` has no
 * `categoryDisagreement` key. `disagreementOnly` adds a predicate rather than
 * changing the join, for the same reason.
 */
export async function browseCache(tx: Tx, filters: CacheFilters): Promise<CachePage> {
  const conditions: SQL[] = [];
  if (filters.category !== null) conditions.push(sql`l.category = ${filters.category}`);
  if (filters.state !== null) conditions.push(sql`l.state = ${filters.state}::lookup_state`);
  const band = bandPredicate(filters.band);
  if (band !== null) conditions.push(band);
  if (filters.disagreementOnly) {
    conditions.push(sql`(p.tokens->>'categoryDisagreement')::boolean IS TRUE`);
  }

  const where = conditions.length === 0
    ? sql``
    : sql`WHERE ${sql.join(conditions, sql` AND `)}`;

  const offset = (filters.page - 1) * filters.perPage;

  // ORDER BY created_at alone is not a total order: rows sharing a timestamp
  // can swap between pages, so one is seen twice and another never. `id` is
  // the tiebreak.
  const result = await tx.execute(sql`
    SELECT l.id, l.category, l.name, l.state, l.confidence, l.hit_count, l.pinned,
           l.created_at, l.last_attempt_at,
           COALESCE((p.tokens->>'categoryDisagreement')::boolean, false) AS disagreement,
           count(*) OVER () AS total
      FROM lookups l
      LEFT JOIN parses p ON p.category = l.category AND p.normalized_key = l.normalized_key
      ${where}
     ORDER BY l.created_at DESC, l.id
     LIMIT ${filters.perPage} OFFSET ${offset}`);

  // `unknown` here is the deserialization exception: these are database columns
  // narrowed on the way out, never read as application state.
  const rows: CacheRow[] = result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    category: String(row.category),
    name: String(row.name),
    state: String(row.state),
    confidence: row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence),
    hitCount: Number(row.hit_count),
    pinned: row.pinned === true,
    disagreement: row.disagreement === true,
    createdAt: String(row.created_at),
    lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined
      ? null
      : String(row.last_attempt_at),
  }));

  // A page past the end returns no rows and therefore no window total, but the
  // filtered total is still a fact the caller needs — so ask for it rather than
  // reporting zero and making the pager look empty.
  const total = rows.length > 0
    ? Number(result.rows[0]?.total ?? 0)
    : await countOnly(tx, where);

  return {
    rows,
    total,
    page: filters.page,
    perPage: filters.perPage,
    pageCount: Math.max(1, Math.ceil(total / filters.perPage)),
  };
}

async function countOnly(tx: Tx, where: SQL): Promise<number> {
  const result = await tx.execute(sql`
    SELECT count(*)::int AS total
      FROM lookups l
      LEFT JOIN parses p ON p.category = l.category AND p.normalized_key = l.normalized_key
      ${where}`);
  return Number(result.rows[0]?.total ?? 0);
}
