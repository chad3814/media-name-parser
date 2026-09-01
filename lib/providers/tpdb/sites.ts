import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { normalizeSiteName } from '../../parse/normalize';

/**
 * A site remembered from a resolved scene, keyed by provider + short name.
 *
 * theporndb.net's `/scenes` endpoint accepts a numeric `site_id` filter that,
 * combined with a date, is very nearly a primary key on that API. The parser
 * only ever has the site's display name from the filename (`SpankMonster`);
 * the API's `site.short_name` is that name lowercased (`spankmonster`), with
 * no fuzzy matching required. This cache is populated opportunistically —
 * whenever a scene resolves, its site is remembered here — so the first
 * lookup for a site pays for a text search and every later lookup narrows by
 * `site_id`. There is no sync job; the cache warms itself.
 */
export interface RememberedSite {
  readonly providerRef: string;
  readonly shortName: string;
  readonly name: string;
}

/**
 * The numeric site id for a short name, or null on a cache miss.
 *
 * `shortName` is normalized before the lookup because the caller gives the
 * parsed spelling (`SpankMonster`, `Passion HD`) while the API and this table
 * store the bare alphanumeric form (`spankmonster`, `passionhd`) -- they must
 * meet in the same spelling. Lowercasing alone was not enough: a multi-token
 * site arrives from `parseScene` with spaces in it and could never match.
 */
export async function findSiteId(tx: Tx, shortName: string): Promise<string | null> {
  const result = await tx.execute(sql`
    SELECT provider_ref FROM provider_sites
     WHERE provider = 'tpdb' AND short_name = ${normalizeSiteName(shortName)}`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return String(row.provider_ref);
}

/**
 * Remembers a site's numeric id for future lookups.
 *
 * This row can collide two different ways, because the table carries two
 * unique constraints: `PRIMARY KEY (provider, provider_ref)` and
 * `UNIQUE (provider, short_name)`. An `ON CONFLICT` clause can name only one
 * of them, so naming the primary key alone left the other free to raise --
 * and it did, the first time a short name already cached under one numeric id
 * arrived carrying another. Because this runs on every successful resolution,
 * that error would have surfaced as the whole lookup failing rather than as a
 * cache write quietly declining.
 *
 * Both directions are now handled:
 *
 *   same id, new short name  -- the site was renamed upstream. The primary-key
 *                               conflict updates the row in place.
 *   same short name, new id  -- the short name moved to a different site id.
 *                               The delete clears the stale row first, so the
 *                               insert has nothing left to collide with.
 *
 * The short name wins, because it is what `findSiteId` reads by: one current
 * id per short name is the invariant this cache exists to hold. Both
 * statements run in the caller's transaction, so a reader never observes the
 * gap between them.
 *
 * `short_name` is stored through the same `normalizeSiteName` the read side
 * applies, so the column holds one spelling and a lookup never folds at read
 * time. The API's own short names are already bare alphanumerics, so this is
 * a no-op for them -- it exists so a write that arrives from anywhere else
 * cannot seed a row the read side can never find.
 */
export async function rememberSite(tx: Tx, site: RememberedSite): Promise<void> {
  const shortName = normalizeSiteName(site.shortName);
  await tx.execute(sql`
    DELETE FROM provider_sites
     WHERE provider = 'tpdb' AND short_name = ${shortName}
       AND provider_ref <> ${site.providerRef}`);
  await tx.execute(sql`
    INSERT INTO provider_sites (provider, provider_ref, short_name, name)
    VALUES ('tpdb', ${site.providerRef}, ${shortName}, ${site.name})
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      short_name = excluded.short_name, name = excluded.name`);
}
