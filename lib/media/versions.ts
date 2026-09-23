import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/**
 * The other side of every pair a row is in.
 *
 * One definition, used by `versionsOf` below and by `readMediaTree`. A link
 * is stored once under `CHECK (a < b)`, so a reader that only looked at `a`
 * would find half of them -- and two copies of that CASE would be two
 * places to get it wrong.
 */
export function versionIdsSql(mediaId: string) {
  return sql`
    SELECT CASE WHEN a = ${mediaId}::uuid THEN b ELSE a END
      FROM media_versions
     WHERE a = ${mediaId}::uuid OR b = ${mediaId}::uuid`;
}

/** A pair the backfill is considering, with what a human needs to judge it. */
export interface VersionCandidate {
  readonly aId: string;
  readonly aRef: string;
  readonly bId: string;
  readonly bRef: string;
  readonly title: string;
  readonly year: number | null;
}

/**
 * Series held by two providers that are plausibly the same show.
 *
 * Series only: across every kind the same join finds 2,994 pairs in
 * production against 13 real ones, because episodes are routinely titled
 * `Episode 1` and seasons `Season 1`. It also matches what the resolve path
 * records, which is series links and nothing else.
 *
 * The year is part of the match, not decoration. `sort_title` carries no
 * year, so title alone pairs every row of one name with every other: The
 * Office (US, 2005) and The Office (UK, 2001) are both held by both
 * providers, and matching on title gives four pairs of which two join a US
 * row to a UK one. A row with no year is skipped rather than guessed at.
 */
export async function seriesVersionCandidates(tx: Tx): Promise<readonly VersionCandidate[]> {
  const rows = await tx.execute(sql`
    SELECT a.id AS a_id, a.provider::text || ':' || a.provider_ref AS a_ref,
           b.id AS b_id, b.provider::text || ':' || b.provider_ref AS b_ref,
           a.title AS title, a.year AS year
      FROM media a
      JOIN media b
        ON b.kind = a.kind
       AND lower(b.sort_title) = lower(a.sort_title)
       AND b.year = a.year
       AND b.provider <> a.provider
       AND a.id < b.id
     WHERE a.kind = 'series' AND a.year IS NOT NULL
     ORDER BY a.title, a.year`);
  return rows.rows.map((row) => ({
    aId: String(row.a_id),
    aRef: String(row.a_ref),
    bId: String(row.b_id),
    bRef: String(row.b_ref),
    title: String(row.title),
    year: row.year === null ? null : Number(row.year),
  }));
}

/**
 * Records that two rows are the same thing, seen by different providers.
 *
 * The pair is sorted before it is written, because `media_versions` stores
 * it under `CHECK (a < b)`: one fact, one row, whichever order the caller
 * happens to hold the two ids in. `ON CONFLICT DO NOTHING` because the
 * resolve path re-offers a link every time a stale lookup runs again, and
 * that is not news.
 *
 * Returns whether a row was written, which is what lets the backfill report
 * what it did rather than what it tried.
 */
export async function linkVersions(tx: Tx, one: string, other: string): Promise<boolean> {
  // A row is not a version of itself, and asking would violate the CHECK
  // rather than simply doing nothing.
  if (one === other) return false;
  // Sorted as JavaScript strings, which agrees with Postgres `uuid` order
  // only because the driver returns lowercase canonical uuids. Worth stating
  // because `ON CONFLICT` does not catch a CHECK violation: an uppercase or
  // braced id would throw out of here and abort the whole lookup, not skip a
  // row.
  const [a, b] = one < other ? [one, other] : [other, one];
  const written = await tx.execute(sql`
    INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)
    ON CONFLICT (a, b) DO NOTHING
    RETURNING a`);
  return written.rows.length > 0;
}

/**
 * Every row linked to this one, from either side of the pair.
 *
 * A link is stored once, canonically ordered, so a reader that only looked
 * at `a` would find half of them.
 */
export async function versionsOf(tx: Tx, mediaId: string): Promise<readonly string[]> {
  const rows = await tx.execute(sql`SELECT x AS other FROM (${versionIdsSql(mediaId)}) AS t(x)`);
  return rows.rows.map((row) => String(row.other));
}
