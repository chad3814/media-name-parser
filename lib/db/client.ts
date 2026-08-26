import { Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export type Db = NeonDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let pool: Pool | null = null;
let cached: Db | null = null;

/**
 * The database handle, created on first use.
 *
 * The WebSocket driver, not the HTTP one. `neon-http` throws
 * `No transactions support in neon-http driver`, and this service needs
 * transactions for `pg_advisory_xact_lock`, for the sweeper's
 * `FOR UPDATE SKIP LOCKED`, and for a media upsert that must not half-succeed.
 * Node 26 supplies a global `WebSocket`, so no `ws` shim is configured.
 *
 * Lazy rather than a module-level const: Next.js imports route modules while
 * building, and a top-level throw on a missing `DATABASE_URL` would turn a
 * config mistake into a build failure pointing at the wrong thing.
 */
export function getDb(): Db {
  if (cached !== null) return cached;
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_URL is not set');
  }
  pool = new Pool({ connectionString: url });
  cached = drizzle(pool, { schema });
  return cached;
}

export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

/**
 * A transaction-scoped advisory lock over an arbitrary string.
 *
 * `hashtext` maps the key into the bigint the lock function wants. Collisions
 * are possible and harmless: two unrelated keys that collide serialize against
 * each other, costing a little latency and no correctness, because every write
 * downstream is an upsert on a natural key.
 */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/** For test teardown. A serverless function should never call this. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  cached = null;
  if (current !== null) await current.end();
}
