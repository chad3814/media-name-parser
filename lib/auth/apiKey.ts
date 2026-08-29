import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

const PREFIX_BYTES = 4;   // 8 hex characters
const SECRET_BYTES = 24;  // 48 hex characters

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256, hex, via WebCrypto.
 *
 * `crypto.subtle` rather than `node:crypto`'s `createHash`: this runs on every
 * authenticated request, and the synchronous form blocks the event loop for
 * every other request sharing it.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export interface MintedKey {
  readonly token: string;
  readonly prefix: string;
  readonly tokenHash: string;
}

/**
 * A new key: `mnp_<prefix>_<secret>`.
 *
 * The `mnp_` marker makes a leaked key greppable in a log or a repository. The
 * prefix is stored in the clear so a UI can say which key is which without
 * holding the secret. The hash covers the whole token, prefix included.
 */
export async function mintApiKey(): Promise<MintedKey> {
  const prefix = toHex(crypto.getRandomValues(new Uint8Array(PREFIX_BYTES)));
  const secret = toHex(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const token = `mnp_${prefix}_${secret}`;
  return { token, prefix, tokenHash: await hashToken(token) };
}

const BEARER = /^bearer\s+(\S+)\s*$/i;

export function parseBearer(header: string | null): string | null {
  if (header === null || header.length === 0) return null;
  const match = BEARER.exec(header.trim());
  return match?.[1] ?? null;
}

export interface Caller {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly rateLimitPerMin: number;
}

/**
 * The caller behind a token, or null.
 *
 * Lookup is by hash, so there is no secret comparison to make constant-time --
 * the index does the work and no timing signal exists to leak. A revoked key
 * is excluded in SQL rather than checked afterwards, so there is no path where
 * a caller is built from a revoked row.
 *
 * Also excludes a key whose owner is currently banned, joined in the same
 * query rather than a second round trip. `getCurrentUser` already refuses a
 * banned user on the session path; a ban that stopped a session but not an
 * API key would be worse than no ban at all, because whoever set it would
 * believe it covered both. The expiry semantics match `getCurrentUser`
 * exactly: a ban applies while `banned` is true and `ban_expires` is null or
 * still in the future, so a ban whose `ban_expires` is exactly now, or in the
 * past, no longer applies.
 */
export async function verifyApiKey(tx: Tx, token: string): Promise<Caller | null> {
  const tokenHash = await hashToken(token);
  const result = await tx.execute(sql`
    SELECT ak.id, ak.user_id, ak.rate_limit_per_min
      FROM api_keys ak
      JOIN "user" u ON u.id = ak.user_id
     WHERE ak.token_hash = ${tokenHash}
       AND ak.revoked_at IS NULL
       AND NOT (u.banned AND (u.ban_expires IS NULL OR u.ban_expires > now()))`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    apiKeyId: String(row.id),
    userId: String(row.user_id),
    rateLimitPerMin: Number(row.rate_limit_per_min),
  };
}

export async function touchApiKey(tx: Tx, apiKeyId: string): Promise<void> {
  await tx.execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${apiKeyId}::uuid`);
}
