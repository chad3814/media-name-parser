import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/**
 * User rows, from outside Better Auth.
 *
 * Better Auth owns the `user` table and generates its own string ids, but the
 * column is `text` and nothing makes its ids special -- a randomUUID is just
 * as valid. That matters because a seed script must be able to attach an API
 * key to a person without a browser and a running dev server. A user created
 * here has `email_verified = false` and no `account` row; a later magic-link
 * sign-in to the same address finds this row by email and attaches a session.
 */

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.length === 0 ? email : local;
}

export async function findUserIdByEmail(tx: Tx, email: string): Promise<string | null> {
  const result = await tx.execute(sql`SELECT id FROM "user" WHERE email = ${email}`);
  const row = result.rows[0];
  return row === undefined ? null : String(row.id);
}

export async function ensureUser(
  tx: Tx,
  email: string,
  name?: string,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const id = crypto.randomUUID();
  // DO NOTHING rather than DO UPDATE: an existing user's name is theirs, and a
  // seed script's guess at it is worse than what is already stored.
  const inserted = await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES (${id}, ${name ?? nameFromEmail(email)}, ${email}, false)
    ON CONFLICT (email) DO NOTHING
    RETURNING id`);
  const row = inserted.rows[0];
  if (row !== undefined) return { id: String(row.id), created: true };

  const existing = await findUserIdByEmail(tx, email);
  if (existing === null) {
    // The insert was skipped and the row is not there: something else deleted
    // it between the two statements. Surfacing this beats returning a
    // fabricated id that no row uses.
    throw new Error(`the user row for ${email} vanished mid-transaction`);
  }
  return { id: existing, created: false };
}

/** Writes the role column verbatim. Compose the value with `lib/auth/roles.ts`. */
export async function setUserRole(tx: Tx, email: string, role: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE "user" SET role = ${role}, updated_at = now() WHERE email = ${email} RETURNING id`);
  return result.rows.length > 0;
}
