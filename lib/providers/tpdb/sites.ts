import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';

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
 * `shortName` is lowercased before the lookup because the filename gives the
 * display spelling (`SpankMonster`) while the API and this table store the
 * lowercase form (`spankmonster`) — they must meet in the same case.
 */
export async function findSiteId(tx: Tx, shortName: string): Promise<string | null> {
  const result = await tx.execute(sql`
    SELECT provider_ref FROM provider_sites
     WHERE provider = 'tpdb' AND short_name = ${shortName.toLowerCase()}`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return String(row.provider_ref);
}

/**
 * Remembers a site's numeric id for future lookups.
 *
 * Conflicts on `(provider, provider_ref)` update the name and short name
 * rather than doing nothing: if a site is renamed upstream, the next
 * resolution for that same numeric id should overwrite the stale name here
 * rather than leave this table quietly wrong forever. `short_name` is stored
 * lowercased so lookups never need to case-fold at read time.
 */
export async function rememberSite(tx: Tx, site: RememberedSite): Promise<void> {
  await tx.execute(sql`
    INSERT INTO provider_sites (provider, provider_ref, short_name, name)
    VALUES ('tpdb', ${site.providerRef}, ${site.shortName.toLowerCase()}, ${site.name})
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      short_name = excluded.short_name, name = excluded.name`);
}
