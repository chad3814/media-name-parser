import { withTransaction } from '../db/client';
import { requireAdmin } from '../auth/session';
import { browseCache, parseFilters, type CacheFilters, type CachePage } from './browse';

// Re-exported so a caller (the page) can get the filter/page shapes from this
// module alone, without a second import path into `./browse` that could
// tempt someone into calling `browseCache`/`parseFilters` directly and
// querying around the guard below.
export type { CacheFilters, CachePage };

/**
 * What the cache page should render, decided outside the component.
 *
 * The decision lives here because an async Server Component cannot be rendered
 * from `node:test`, so a guard inside the page is untestable -- and a review
 * proved that replacing it left every test passing while serving cache data to
 * a non-admin.
 *
 * The shape is what does the work: `page` exists only on the `ready` arm, so a
 * refusal cannot carry data even by mistake, and a test asserting the arm is
 * also asserting the absence of the query's result.
 */
export type CacheView =
  | { readonly kind: 'signin' }
  | { readonly kind: 'refused'; readonly reason: 'role' | 'unavailable' }
  | { readonly kind: 'ready'; readonly filters: CacheFilters; readonly page: CachePage };

export async function loadCacheView(
  headers: Headers,
  params: URLSearchParams,
): Promise<CacheView> {
  const guard = await requireAdmin(headers);
  if (!guard.ok) {
    if (guard.response.status === 401) return { kind: 'signin' };
    if (guard.response.status === 403) return { kind: 'refused', reason: 'role' };
    // 503 from requireUser: reading the session failed. Not a permissions
    // problem, and must not be reported as one.
    return { kind: 'refused', reason: 'unavailable' };
  }
  // Reached only past the guard: the query does not run for a refused caller.
  const filters = parseFilters(params);
  const page = await withTransaction((tx) => browseCache(tx, filters));
  return { kind: 'ready', filters, page };
}
