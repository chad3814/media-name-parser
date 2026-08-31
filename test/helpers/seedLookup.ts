import { sql } from 'drizzle-orm';
import { getDb, withTransaction } from '../../lib/db/client';
import { upsertParse, writeLookupOutcome, type LookupState } from '../../lib/cache/lookup';
import { normalizeKey } from '../../lib/parse/normalize';
import type { Category } from '../../lib/parse/types';

/** The kind a category's top-level media row takes. */
const KIND: Readonly<Record<Category, string>> = {
  tv: 'series', movies: 'movie', books: 'book', xxx: 'scene',
};

export interface SeedArgs {
  readonly category: Category;
  readonly name: string;
  readonly state: LookupState;
  readonly confidence: number | null;
}

export interface Seeded {
  readonly name: string;
  readonly release: () => Promise<void>;
}

/**
 * Creates the cache row a test needs, rather than hoping the database already
 * holds one.
 *
 * Three tests once queried the dev cache for a row of the shape they wanted
 * and asserted it existed. That passed only because months of prior runs had
 * left suitable rows behind: against a freshly migrated database -- a Vercel
 * preview branch, CI, a new clone -- they failed, and one of them could never
 * pass, because the only row a full run leaves behind is scored and it wanted
 * an unscored one.
 *
 * The writes go through `upsertParse` and `writeLookupOutcome`, the same
 * functions the resolution pipeline uses, so a fixture cannot drift into a
 * shape production never produces. `writeLookupOutcome` also sets
 * `last_attempt_at` to now, which is what makes a seeded row read as fresh.
 *
 * A `resolved` row gets a media row and points at it. That is not a
 * convenience: `decide()` only returns `fresh` for a resolved row whose
 * `media_id` is set, and the pipeline only ever writes `resolved` together
 * with a media id, so a resolved lookup without one is not a state the
 * system can reach.
 */
export async function seedLookup(args: SeedArgs): Promise<Seeded> {
  const { category, name, state, confidence } = args;
  const key = normalizeKey(name);

  const mediaId = await withTransaction(async (tx) => {
    // parses first: lookups_parse_fk is not deferrable.
    await upsertParse(tx, category, key, { categoryDisagreement: false });

    // Direct SQL rather than `persistResolved`, which wants a whole
    // ResolvedMedia with a provider payload. A fixture needs an id to point
    // at, not a faithful provider response.
    let id: string | null = null;
    if (state === 'resolved') {
      const media = await tx.execute(sql`
        INSERT INTO media (category, kind, title, sort_title, provider, provider_ref,
                           raw, raw_fetched_at)
        VALUES (${category}::category, ${KIND[category]}::media_kind,
                ${name}, ${name}, 'tmdb'::provider, ${`fixture:${key}`},
                '{}'::jsonb, now())
        RETURNING id`);
      const row = media.rows[0];
      if (row === undefined) throw new Error('seedLookup: media insert returned no row');
      id = String(row.id);
    }

    await writeLookupOutcome(tx, {
      category, name, normalizedKey: key, mediaId: id, confidence, state,
    });
    return id;
  });

  return {
    name,
    release: async () => {
      const db = getDb();
      // lookups first: ON DELETE RESTRICT refuses to drop a referenced parse.
      await db.execute(sql`DELETE FROM lookups WHERE category = ${category}::category AND name = ${name}`);
      await db.execute(sql`
        DELETE FROM parses WHERE category = ${category}::category AND normalized_key = ${key}
          AND NOT EXISTS (SELECT 1 FROM lookups
                           WHERE category = ${category}::category AND normalized_key = ${key})`);
      if (mediaId !== null) {
        await db.execute(sql`DELETE FROM media WHERE id = ${mediaId}::uuid`);
      }
    },
  };
}
