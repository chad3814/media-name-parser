import { sql } from 'drizzle-orm';
import { getDb } from '../../../../lib/db/client';
import { unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';

/**
 * Unauthenticated on purpose: a health check that needs a credential cannot be
 * used by the thing most likely to call it. It reveals only reachability and a
 * migration count, neither of which is sensitive.
 */
export async function GET(): Promise<Response> {
  try {
    const result = await getDb().execute(sql`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    return Response.json({
      status: 'ok',
      migrations: Number(result.rows[0]?.n ?? 0),
    });
  } catch (error) {
    logFailure('health', error);
    return unavailable('the database is unreachable');
  }
}
