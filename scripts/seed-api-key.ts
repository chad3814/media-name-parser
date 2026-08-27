import { sql } from 'drizzle-orm';
import { closeDb, withTransaction } from '../lib/db/client';
import { mintApiKey } from '../lib/auth/apiKey';

const label = process.argv[2] ?? 'local development';
const email = process.argv[3] ?? 'dev@localhost';

const minted = await mintApiKey();

await withTransaction(async (tx) => {
  // Better Auth owns the `user` table and generates its own string ids. Until
  // Plan 4 wires sign-in up there is no real user to attach a key to, so a
  // deterministic local one is created here and reused.
  await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('local-dev', 'Local Development', ${email}, false)
    ON CONFLICT (id) DO NOTHING`);
  await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES ('local-dev', ${label}, ${minted.tokenHash}, ${minted.prefix})`);
});
await closeDb();

// The secret is printed exactly once, here, and is not recoverable afterwards.
// It goes to stdout so it can be redirected straight into a file or a variable
// without appearing in a log.
process.stdout.write(`${minted.token}\n`);
process.stderr.write(`\nstored key ${minted.prefix} for '${label}'. The token above is shown once.\n`);
