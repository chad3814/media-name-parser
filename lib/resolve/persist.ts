import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type {
  ProviderCallRecord, ProviderName, ResolvedMedia, ResolvedPerson,
} from '../providers/types';

/**
 * Writes a resolved tree and returns the leaf's `media.id`.
 *
 * Ancestors first, because `parent_id` is a real foreign key. Every statement
 * is an upsert on a natural key -- `(provider, provider_ref)` for media and
 * people -- so a retry after a rollback converges instead of duplicating, and
 * two racing resolvers of the same release agree.
 *
 * Raw SQL rather than the query builder for the upserts: `ON CONFLICT ... DO
 * UPDATE ... RETURNING id` in one round trip is the whole point, and expressing
 * it through the builder here would be more code for the same statement.
 */
export async function persistResolved(tx: Tx, resolved: ResolvedMedia): Promise<string> {
  const parentId = resolved.parent === null ? null : await persistResolved(tx, resolved.parent);

  const inserted = await tx.execute(sql`
    INSERT INTO media (
      category, kind, parent_id, title, sort_title, original_title,
      release_date, year, overview, provider, provider_ref, raw, raw_fetched_at, updated_at
    ) VALUES (
      ${resolved.category}::category, ${resolved.kind}::media_kind,
      ${parentId}::uuid, ${resolved.title}, ${resolved.sortTitle}, ${resolved.originalTitle},
      ${resolved.releaseDate}::date, ${resolved.year}, ${resolved.overview},
      ${resolved.provider}::provider, ${resolved.providerRef},
      ${JSON.stringify(resolved.raw)}::jsonb, now(), now()
    )
    ON CONFLICT (provider, provider_ref) DO UPDATE SET
      title = excluded.title,
      sort_title = excluded.sort_title,
      original_title = excluded.original_title,
      release_date = excluded.release_date,
      year = excluded.year,
      overview = excluded.overview,
      parent_id = excluded.parent_id,
      raw = excluded.raw,
      raw_fetched_at = excluded.raw_fetched_at,
      updated_at = now()
    RETURNING id`);

  const mediaId = inserted.rows[0]?.id;
  if (typeof mediaId !== 'string') {
    throw new Error(`media upsert returned no id for ${resolved.providerRef}`);
  }

  await persistDetails(tx, mediaId, resolved);
  await persistPeople(tx, mediaId, resolved.provider, resolved.people);
  return mediaId;
}

async function persistDetails(tx: Tx, mediaId: string, resolved: ResolvedMedia): Promise<void> {
  const { movie, series, season, episode, scene } = resolved.details;
  if (movie !== null) {
    await tx.execute(sql`
      INSERT INTO movie_details (media_id, runtime_minutes, imdb_id, tagline, collection_name)
      VALUES (${mediaId}::uuid, ${movie.runtimeMinutes}, ${movie.imdbId}, ${movie.tagline}, ${movie.collectionName})
      ON CONFLICT (media_id) DO UPDATE SET
        runtime_minutes = excluded.runtime_minutes, imdb_id = excluded.imdb_id,
        tagline = excluded.tagline, collection_name = excluded.collection_name`);
  }
  if (series !== null) {
    await tx.execute(sql`
      INSERT INTO series_details (media_id, first_air_date, last_air_date, status)
      VALUES (${mediaId}::uuid, ${series.firstAirDate}::date, ${series.lastAirDate}::date, ${series.status})
      ON CONFLICT (media_id) DO UPDATE SET
        first_air_date = excluded.first_air_date, last_air_date = excluded.last_air_date,
        status = excluded.status`);
  }
  if (season !== null) {
    await tx.execute(sql`
      INSERT INTO season_details (media_id, season_number)
      VALUES (${mediaId}::uuid, ${season.seasonNumber})
      ON CONFLICT (media_id) DO UPDATE SET season_number = excluded.season_number`);
  }
  if (episode !== null) {
    await tx.execute(sql`
      INSERT INTO episode_details (media_id, season_number, episode_number, air_date)
      VALUES (${mediaId}::uuid, ${episode.seasonNumber}, ${episode.episodeNumber}, ${episode.airDate}::date)
      ON CONFLICT (media_id) DO UPDATE SET
        season_number = excluded.season_number, episode_number = excluded.episode_number,
        air_date = excluded.air_date`);
  }
  if (scene !== null) {
    await tx.execute(sql`
      INSERT INTO scene_details (media_id, site_name, duration_seconds, released_on)
      VALUES (${mediaId}::uuid, ${scene.siteName}, ${scene.durationSeconds}, ${scene.releasedOn}::date)
      ON CONFLICT (media_id) DO UPDATE SET
        site_name = excluded.site_name, duration_seconds = excluded.duration_seconds,
        released_on = excluded.released_on`);
  }
}

async function persistPeople(
  tx: Tx, mediaId: string, provider: ProviderName, people: readonly ResolvedPerson[],
): Promise<void> {
  for (const person of people) {
    const row = await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES (${provider}::provider, ${person.providerRef}, ${person.name}, ${person.name.toLowerCase()},
              ${JSON.stringify(person.raw)}::jsonb, now())
      ON CONFLICT (provider, provider_ref) DO UPDATE SET
        name = excluded.name, sort_name = excluded.sort_name,
        raw = excluded.raw, raw_fetched_at = excluded.raw_fetched_at
      RETURNING id`);
    const personId = row.rows[0]?.id;
    if (typeof personId !== 'string') {
      throw new Error(`person upsert returned no id for ${person.providerRef}`);
    }
    // `character_name` is NOT NULL DEFAULT '' precisely so it can sit in the
    // primary key; a null there would make the conflict target unusable.
    await tx.execute(sql`
      INSERT INTO media_people (media_id, person_id, role, character_name, billing_order)
      VALUES (${mediaId}::uuid, ${personId}::uuid, ${person.role}::person_role,
              ${person.characterName ?? ''}, ${person.billingOrder})
      ON CONFLICT (media_id, person_id, role, character_name) DO UPDATE SET
        billing_order = excluded.billing_order`);
  }
}

/**
 * Drops `provider_calls` rows older than `keepDays`.
 *
 * The spec fixes the retention at 30 days and puts the prune on the cron that
 * sweeps jobs, which is where this is called from. Without it the table is the
 * one thing in the schema that grows without bound: a row per provider request,
 * forever, for observability nobody will read a year later.
 */
export async function pruneProviderCalls(tx: Tx, keepDays = 30): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM provider_calls
     WHERE created_at < now() - (${keepDays} * interval '1 day')`);
  return Number(result.rowCount ?? 0);
}

export async function recordProviderCalls(
  tx: Tx, rows: readonly ProviderCallRecord[],
): Promise<void> {
  for (const row of rows) {
    await tx.execute(sql`
      INSERT INTO provider_calls (provider, endpoint, status, duration_ms, lookup_id)
      VALUES (${row.provider}::provider, ${row.endpoint}, ${row.status}, ${row.durationMs},
              ${row.lookupId}::uuid)`);
  }
}
