import { closeDb, withTransaction } from '../lib/db/client';
import { sql } from 'drizzle-orm';
import { setUserRole } from '../lib/auth/users';
import { ADMIN_ROLE, hasRole, withRole, withoutRole } from '../lib/auth/roles';

const email = process.argv[2] ?? '';
const revoke = process.argv.includes('--revoke');

if (email.length === 0 || !email.includes('@')) {
  process.stderr.write('usage: npm run admin:promote -- <email> [--revoke]\n');
  process.exit(1);
}

const outcome = await withTransaction(async (tx) => {
  // Read and write in one transaction: two concurrent runs would otherwise
  // read the same role and the second write would discard the first.
  const result = await tx.execute(sql`
    SELECT role FROM "user" WHERE email = ${email} FOR UPDATE`);
  const row = result.rows[0];
  if (row === undefined) return { found: false as const };
  const before = String(row.role);
  const after = revoke ? withoutRole(before, ADMIN_ROLE) : withRole(before, ADMIN_ROLE);
  if (after !== before) await setUserRole(tx, email, after);
  return { found: true as const, before, after };
});
await closeDb();

if (!outcome.found) {
  process.stderr.write(`no user with email ${email}. Sign in once, or run 'npm run seed:key'.\n`);
  process.exit(1);
}
process.stderr.write(
  `${email}: ${outcome.before} -> ${outcome.after}` +
  `${outcome.before === outcome.after ? ' (already correct)' : ''}\n` +
  `admin: ${hasRole(outcome.after, ADMIN_ROLE) ? 'yes' : 'no'}\n`,
);
