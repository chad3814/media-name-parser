import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';

export type Db = NeonHttpDatabase<typeof schema>;

let cached: Db | null = null;

/**
 * The database handle, created on first use.
 *
 * Deliberately lazy rather than a module-level `export const db`. Next.js
 * imports route modules while building, so a top-level `throw` on a missing
 * `DATABASE_URL` would turn a deploy-time config mistake into a build failure
 * with a stack trace pointing at the wrong thing. Failing on first query
 * instead keeps the error where the cause is.
 */
export function getDb(): Db {
  if (cached !== null) return cached;
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL is not set');
  }
  cached = drizzle(neon(url), { schema });
  return cached;
}
