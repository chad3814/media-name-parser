import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { MediaKind, PersonRole, ProviderName } from '../providers/types';

export interface PersonView {
  /** The provider's own person id, so a caller can look the performer up there. */
  readonly providerRef: string;
  readonly name: string;
  readonly role: PersonRole;
  readonly characterName: string | null;
  readonly billingOrder: number | null;
}

export interface MediaNode {
  readonly id: string;
  readonly kind: MediaKind;
  readonly title: string;
  readonly releaseDate: string | null;
  readonly year: number | null;
  readonly provider: ProviderName;
  readonly providerRef: string;
}

export interface MediaView extends MediaNode {
  readonly overview: string | null;
  /** Whatever detail table matches `kind`, flattened. Empty for a bare node. */
  readonly details: Readonly<Record<string, string | number | null>>;
  /** Nearest first: an episode's parents are its season, then its series. */
  readonly parents: readonly MediaNode[];
  readonly people: readonly PersonView[];
}

function node(row: Readonly<Record<string, unknown>>): MediaNode {
  return {
    id: String(row.id),
    kind: row.kind as MediaKind,
    title: String(row.title),
    releaseDate: row.release_date === null ? null : String(row.release_date),
    year: row.year === null ? null : Number(row.year),
    provider: row.provider as ProviderName,
    providerRef: String(row.provider_ref),
  };
}

/**
 * A media row with its ancestors and people.
 *
 * Three queries regardless of depth: one recursive CTE for the row and its
 * parent chain, one for the detail tables, one for the people. Walking
 * `parent_id` in application code would be a round trip per level, which for
 * an episode is three -- and the recursive form is no harder to read.
 */
export async function readMediaTree(tx: Tx, mediaId: string): Promise<MediaView | null> {
  // Columns enumerated, never `m.*`: `media.raw` is the whole provider payload
  // and a recorded season runs 348-388 KB. Every lookup response hydrates a
  // tree, cache hits included, so `*` moved half a megabyte per cached episode
  // out of Neon to be discarded unread -- tens of megabytes for a 100-item
  // batch. Nothing below reads more than these nine. The two arms of the UNION
  // must list the same columns in the same order or Postgres rejects the CTE,
  // so they are kept adjacent and identical apart from the depth expression.
  const chain = await tx.execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT m.id, m.parent_id, m.kind, m.title, m.release_date, m.year,
             m.overview, m.provider, m.provider_ref, 0 AS depth
        FROM media m WHERE m.id = ${mediaId}::uuid
      UNION ALL
      SELECT p.id, p.parent_id, p.kind, p.title, p.release_date, p.year,
             p.overview, p.provider, p.provider_ref, a.depth + 1
        FROM media p JOIN ancestry a ON p.id = a.parent_id
    )
    SELECT * FROM ancestry ORDER BY depth`);

  const rows = chain.rows;
  const self = rows[0];
  if (self === undefined) return null;

  const details = await tx.execute(sql`
    SELECT
      (SELECT to_jsonb(d) - 'media_id' FROM movie_details  d WHERE d.media_id = ${mediaId}::uuid) AS movie,
      (SELECT to_jsonb(d) - 'media_id' FROM series_details d WHERE d.media_id = ${mediaId}::uuid) AS series,
      (SELECT to_jsonb(d) - 'media_id' FROM season_details d WHERE d.media_id = ${mediaId}::uuid) AS season,
      (SELECT to_jsonb(d) - 'media_id' FROM episode_details d WHERE d.media_id = ${mediaId}::uuid) AS episode,
      (SELECT to_jsonb(d) - 'media_id' FROM book_details   d WHERE d.media_id = ${mediaId}::uuid) AS book,
      (SELECT to_jsonb(d) - 'media_id' FROM scene_details  d WHERE d.media_id = ${mediaId}::uuid) AS scene`);

  const people = await tx.execute(sql`
    SELECT p.provider_ref, p.name, mp.role, mp.character_name, mp.billing_order
      FROM media_people mp JOIN people p ON p.id = mp.person_id
     WHERE mp.media_id = ${mediaId}::uuid
     -- Performers first in billing order, then everyone else by name. A
     -- response that led with the third-billed actor would read as unsorted.
     ORDER BY (mp.role <> 'performer'), mp.billing_order NULLS LAST, p.name`);

  const detailRow = details.rows[0] ?? {};
  // The subquery aliases above are named after `kind` exactly, so this is a
  // direct lookup rather than a mapping.
  const kind = String(self.kind);
  const raw = detailRow[kind];
  // Column names arrive snake_case from `to_jsonb`; the API is camelCase.
  const flattened: Record<string, string | number | null> = {};
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const camel = key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      flattened[camel] = value === null ? null
        : typeof value === 'number' ? value
        : String(value);
    }
  }

  return {
    ...node(self),
    overview: self.overview === null ? null : String(self.overview),
    details: flattened,
    parents: rows.slice(1).map(node),
    people: people.rows.map((r) => ({
      providerRef: String(r.provider_ref),
      name: String(r.name),
      role: r.role as PersonRole,
      characterName: r.character_name === null || r.character_name === '' ? null : String(r.character_name),
      billingOrder: r.billing_order === null ? null : Number(r.billing_order),
    })),
  };
}
