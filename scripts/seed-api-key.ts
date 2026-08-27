import { closeDb, withTransaction } from '../lib/db/client';
import { sql } from 'drizzle-orm';
import { mintApiKey } from '../lib/auth/apiKey';
import { ensureUser } from '../lib/auth/users';

const email = process.argv[2] ?? '';
const label = process.argv[3] ?? 'local development';

if (email.length === 0 || !email.includes('@')) {
  process.stderr.write('usage: npm run seed:key -- <email> [label]\n');
  process.exit(1);
}

const minted = await mintApiKey();

const owner = await withTransaction(async (tx) => {
  const user = await ensureUser(tx, email);
  await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES (${user.id}, ${label}, ${minted.tokenHash}, ${minted.prefix})`);
  return user;
});
await closeDb();

// The secret is printed exactly once, here, and is not recoverable afterwards.
// It goes to stdout so it can be redirected straight into a file or a variable
// without appearing in a log; everything else goes to stderr.
process.stdout.write(`${minted.token}\n`);
process.stderr.write(
  `\nstored key ${minted.prefix} ('${label}') for ${email}` +
  `${owner.created ? ' (new user)' : ''}. The token above is shown once.\n`,
);
