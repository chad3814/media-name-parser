import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { ExternalId } from '../parse/ids';
import type { Category } from '../parse/types';
import { titleSimilarity } from '../resolve/confidence';

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

/** The `provider_ref` namespace a declared category fixes, or null. */
function namespaceFor(category: Category): 'movie' | 'tv' | null {
  if (category === 'movies') return 'movie';
  if (category === 'tv') return 'tv';
  return null;
}

/**
 * How much a stored title must agree before a cross-namespace id is believed.
 * Same bar the provider path uses for the same question.
 */
const CORROBORATION = 0.8;

export async function findMediaByExternalId(
  tx: Tx, named: ExternalId, category: Category, title: string,
): Promise<string | null> {
  if (named.source === 'tmdb') {
    // The declared category IS the namespace when there is one. TMDB numbers
    // films and series separately -- 5725 is the film `Supervixens` and the
    // series `Project Catwalk` -- but a `movies` lookup has already said which
    // of those it means, so there is nothing to decline.
    const namespace = namespaceFor(category);
    if (namespace !== null) {
      const row = await tx.execute(sql`
        SELECT id FROM media
         WHERE provider = 'tmdb' AND provider_ref = ${`tmdb:${namespace}:${named.id}`}`);
      const only = row.rows[0];
      return only === undefined ? null : String(only.id);
    }

    // No namespace: the caller filed this under a category TMDB does not
    // serve, so the id alone cannot say film or series. The stored title
    // settles it without a provider call -- `tmdb:movie:5725` is titled
    // `Supervixens` and so is the filename. Bound as parameters because the id
    // came out of a filename.
    const rows = await tx.execute(sql`
      SELECT id, title FROM media
       WHERE provider = 'tmdb'
         AND provider_ref IN (${`tmdb:movie:${named.id}`}, ${`tmdb:tv:${named.id}`})`);
    const agreeing = rows.rows.filter(
      (row) => titleSimilarity(title, String(row.title)) >= CORROBORATION,
    );
    // Two agreeing titles is a genuine tie, and a guess reported at confidence
    // 1 is the worst answer available.
    if (agreeing.length !== 1) return null;
    const only = agreeing[0];
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

  // imdb and tvdb ids are globally unique within their own catalogue, so the
  // side table answers them outright with no namespace to resolve.
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
