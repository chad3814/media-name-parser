import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { Category } from '../parse/types';
import type { JsonValue } from '../providers/types';
import { PARSER_VERSION } from '../parse/markers';
import { envNumber } from '../env';


export const STALE_AFTER_HOURS = envNumber('STALE_AFTER_HOURS', 12);

export type LookupState = 'resolved' | 'unresolved' | 'pending';

export interface LookupRow {
  readonly id: string;
  readonly category: Category;
  readonly name: string;
  readonly normalizedKey: string;
  readonly mediaId: string | null;
  readonly confidence: number | null;
  readonly pinned: boolean;
  readonly state: LookupState;
  readonly lastAttemptAt: Date | null;
  /** From the joined `parses` row; null when no parse exists yet. */
  readonly parserVersion: number | null;
}

export type CacheDecision =
  /** Serve it. No parse, no provider call, no write beyond the hit counter. */
  | { readonly kind: 'fresh'; readonly lookup: LookupRow }
  /** Incomplete but attempted recently. Serve what exists; attempt nothing. */
  | { readonly kind: 'cooling'; readonly lookup: LookupRow }
  /** Parse and resolve. */
  | { readonly kind: 'resolve'; readonly lookup: LookupRow | null };

/**
 * The freshness rule, in one pure function.
 *
 * Order matters. A pinned row short-circuits everything, because a human
 * correction outranks every automatic signal. A stale parser version comes
 * next: re-parsing is local and free, and a parse produced by an older parser
 * may now yield different tokens, so its resolution cannot be trusted even if
 * it was confident.
 */
export function decide(row: LookupRow | null, now: Date, floor: number): CacheDecision {
  if (row === null) return { kind: 'resolve', lookup: null };
  if (row.pinned) return { kind: 'fresh', lookup: row };

  if (row.parserVersion === null || row.parserVersion < PARSER_VERSION) {
    return { kind: 'resolve', lookup: row };
  }

  const complete =
    row.state === 'resolved' && row.mediaId !== null &&
    row.confidence !== null && row.confidence >= floor;
  if (complete) return { kind: 'fresh', lookup: row };

  if (row.lastAttemptAt === null) return { kind: 'resolve', lookup: row };
  const ageHours = (now.getTime() - row.lastAttemptAt.getTime()) / 3600_000;
  return ageHours < STALE_AFTER_HOURS
    ? { kind: 'cooling', lookup: row }
    : { kind: 'resolve', lookup: row };
}

export async function readLookup(
  tx: Tx, category: Category, name: string,
): Promise<LookupRow | null> {
  const result = await tx.execute(sql`
    SELECT l.id, l.category, l.name, l.normalized_key, l.media_id, l.confidence,
           l.pinned, l.state, l.last_attempt_at, p.parser_version
      FROM lookups l
      LEFT JOIN parses p
        ON p.category = l.category AND p.normalized_key = l.normalized_key
     WHERE l.category = ${category}::category AND l.name = ${name}`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: String(row.id),
    category: row.category as Category,
    name: String(row.name),
    normalizedKey: String(row.normalized_key),
    mediaId: row.media_id === null ? null : String(row.media_id),
    confidence: row.confidence === null ? null : Number(row.confidence),
    pinned: row.pinned === true,
    state: row.state as LookupState,
    lastAttemptAt: row.last_attempt_at === null ? null : new Date(String(row.last_attempt_at)),
    parserVersion: row.parser_version === null ? null : Number(row.parser_version),
  };
}

export async function upsertParse(
  tx: Tx, category: Category, normalizedKey: string, tokens: JsonValue,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO parses (category, normalized_key, tokens, parser_version, updated_at)
    VALUES (${category}::category, ${normalizedKey}, ${JSON.stringify(tokens)}::jsonb,
            ${PARSER_VERSION}, now())
    ON CONFLICT (category, normalized_key) DO UPDATE SET
      tokens = excluded.tokens, parser_version = excluded.parser_version, updated_at = now()`);
}

/**
 * Another lookup that already resolved the same normalized key.
 *
 * This is what makes a second spelling of one release cost a parse rather than
 * three provider calls. `excludeId` skips the row being resolved right now.
 */
export async function findResolvedSibling(
  tx: Tx, category: Category, normalizedKey: string, excludeId: string | null,
): Promise<{ readonly mediaId: string; readonly confidence: number } | null> {
  const result = await tx.execute(sql`
    SELECT media_id, confidence FROM lookups
     WHERE category = ${category}::category
       AND normalized_key = ${normalizedKey}
       AND state = 'resolved' AND media_id IS NOT NULL
       AND (${excludeId}::uuid IS NULL OR id <> ${excludeId}::uuid)
     ORDER BY confidence DESC NULLS LAST
     LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined || row.media_id === null) return null;
  return { mediaId: String(row.media_id), confidence: Number(row.confidence ?? 0) };
}

export interface LookupOutcome {
  readonly category: Category;
  readonly name: string;
  readonly normalizedKey: string;
  readonly mediaId: string | null;
  readonly confidence: number | null;
  readonly state: LookupState;
}

export async function writeLookupOutcome(tx: Tx, args: LookupOutcome): Promise<string> {
  const result = await tx.execute(sql`
    INSERT INTO lookups (
      category, name, normalized_key, media_id, confidence, state,
      last_attempt_at, resolved_at
    ) VALUES (
      ${args.category}::category, ${args.name}, ${args.normalizedKey},
      ${args.mediaId}::uuid, ${args.confidence}, ${args.state}::lookup_state,
      now(), ${args.state === 'resolved' ? sql`now()` : sql`NULL`}
    )
    ON CONFLICT (category, name) DO UPDATE SET
      normalized_key = excluded.normalized_key,
      -- A pinned row keeps its own answer: a human correction outranks a
      -- re-resolution. Its timestamps still advance so it is not retried.
      media_id = CASE WHEN lookups.pinned THEN lookups.media_id ELSE excluded.media_id END,
      confidence = CASE WHEN lookups.pinned THEN lookups.confidence ELSE excluded.confidence END,
      state = CASE WHEN lookups.pinned THEN lookups.state ELSE excluded.state END,
      last_attempt_at = now(),
      resolved_at = CASE WHEN lookups.pinned THEN lookups.resolved_at ELSE excluded.resolved_at END
    RETURNING id`);
  const id = result.rows[0]?.id;
  if (typeof id !== 'string') throw new Error('lookup upsert returned no id');
  return id;
}

/** Records a cache hit. Deliberately separate: a hit must not touch anything else. */
export async function recordHit(tx: Tx, lookupId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE lookups SET hit_count = hit_count + 1, last_hit_at = now()
     WHERE id = ${lookupId}::uuid`);
}
