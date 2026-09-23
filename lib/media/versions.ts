import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

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
  const [a, b] = one < other ? [one, other] : [other, one];
  const written = await tx.execute(sql`
    INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)
    ON CONFLICT DO NOTHING
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
  const rows = await tx.execute(sql`
    SELECT CASE WHEN a = ${mediaId}::uuid THEN b ELSE a END AS other
      FROM media_versions
     WHERE a = ${mediaId}::uuid OR b = ${mediaId}::uuid`);
  return rows.rows.map((row) => String(row.other));
}
