import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { mintApiKey } from '../auth/apiKey';

/**
 * A key as its owner may see it.
 *
 * No `tokenHash` field, and no secret: the hash is an authentication detail
 * and the secret is shown exactly once, at creation. `prefix` is stored in the
 * clear precisely so a UI can name a key without holding its secret.
 */
export interface KeyRow {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

function toRow(row: Record<string, unknown>): KeyRow {
  // `unknown` here is the deserialization exception: these are database
  // columns being narrowed on the way out, not application state.
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    label: String(row.label),
    prefix: String(row.prefix),
    rateLimitPerMin: Number(row.rate_limit_per_min),
    lastUsedAt: text(row.last_used_at),
    revokedAt: text(row.revoked_at),
    createdAt: String(row.created_at),
  };
}

const COLUMNS = sql`id, label, prefix, rate_limit_per_min, last_used_at, revoked_at, created_at`;

/** Every query in this module filters on `user_id`. That is the point. */
export async function listKeys(tx: Tx, userId: string): Promise<readonly KeyRow[]> {
  const result = await tx.execute(sql`
    SELECT ${COLUMNS} FROM api_keys WHERE user_id = ${userId} ORDER BY created_at DESC`);
  return result.rows.map(toRow);
}

export async function createKey(
  tx: Tx,
  userId: string,
  label: string,
): Promise<{ readonly row: KeyRow; readonly token: string }> {
  const minted = await mintApiKey();
  const result = await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES (${userId}, ${label}, ${minted.tokenHash}, ${minted.prefix})
    RETURNING ${COLUMNS}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the inserted api key row was not returned');
  // The token travels back to the caller once, here, and is never stored.
  return { row: toRow(row), token: minted.token };
}

/**
 * Marks a key revoked, scoped to its owner.
 *
 * Returns false when the key does not exist, is not this user's, or was
 * already revoked -- three cases the caller cannot distinguish, deliberately:
 * telling someone their guess at another user's key id was a real id is a
 * disclosure with no upside.
 *
 * The row is kept rather than deleted. `verifyApiKey` excludes revoked rows in
 * SQL, so the key stops working at once, and the record that it existed
 * survives.
 */
export async function revokeKey(tx: Tx, userId: string, keyId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE api_keys SET revoked_at = now()
     WHERE id = ${keyId}::uuid AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id`);
  return result.rows.length > 0;
}
