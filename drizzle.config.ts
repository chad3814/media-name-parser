import { defineConfig } from 'drizzle-kit';

// Empty rather than a throw: `drizzle-kit generate` only reads the schema and
// must work without credentials. `migrate` fails loudly on an empty url.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
