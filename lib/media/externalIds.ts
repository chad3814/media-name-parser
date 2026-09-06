import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { ExternalId } from '../parse/ids';

/**
 * Finding a stored record from an id a filename carried.
 *
 * This is the one thing an id can do that a title cannot: address the cache
 * directly. A new filename for a record already stored misses the lookup cache
 * (different name) and the sibling check (different normalized key), so before
 * this it cost a provider call to rediscover a row that was already there.
 *
 * Two shapes, because the ids live in two places for a reason. A TMDB id is
 * `media.provider_ref` already -- `tmdb:movie:5725` -- and is read from there
 * rather than duplicated. Everything else lives in `media_external_ids`.
 */

export async function findMediaByExternalId(tx: Tx, named: ExternalId): Promise<string | null> {
  if (named.source === 'tmdb') {
    // TMDB numbers films and series separately and both spaces are populated:
    // 5725 is the film `Supervixens` and the series `Project Catwalk`. Two
    // hits mean the id alone cannot say which, so this declines rather than
    // guessing and the caller corroborates against the provider.
    // Both forms bound as parameters. The id came from a filename, so it is
    // caller-controlled text and never belongs in the statement itself.
    const rows = await tx.execute(sql`
      SELECT id FROM media
       WHERE provider = 'tmdb'
         AND provider_ref IN (${`tmdb:movie:${named.id}`}, ${`tmdb:tv:${named.id}`})`);
    if (rows.rows.length !== 1) return null;
    const only = rows.rows[0];
    return only === undefined ? null : String(only.id);
  }

  // A TPDB uuid IS the provider_ref, while its numeric id and slug are only in
  // the side table, so both are checked for that source.
  if (named.source === 'tpdb') {
    const direct = await tx.execute(sql`
      SELECT id FROM media WHERE provider = 'tpdb' AND provider_ref = ${named.id}`);
    const hit = direct.rows[0];
    if (hit !== undefined) return String(hit.id);
  }

  const rows = await tx.execute(sql`
    SELECT media_id FROM media_external_ids
     WHERE source = ${named.source}::id_source AND ref = ${named.id}`);
  const row = rows.rows[0];
  return row === undefined ? null : String(row.media_id);
}

/**
 * Records the alternate ids a provider handed back, so a later filename naming
 * any of them is answered from here.
 *
 * A conflict repoints the id rather than failing: an id moving between records
 * upstream is a thing that happens, and refusing the write would fail the
 * whole resolution over a cache row.
 */
export async function rememberExternalIds(
  tx: Tx, mediaId: string, ids: readonly ExternalId[],
): Promise<void> {
  for (const named of ids) {
    if (named.id.length === 0) continue;
    await tx.execute(sql`
      INSERT INTO media_external_ids (media_id, source, ref)
      VALUES (${mediaId}::uuid, ${named.source}::id_source, ${named.id})
      ON CONFLICT (source, ref) DO UPDATE SET media_id = excluded.media_id`);
  }
}
