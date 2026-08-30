import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../../lib/auth/session';
import { withTransaction } from '../../../../lib/db/client';
import { browseCache, parseFilters, type CacheFilters as Filters } from '../../../../lib/cache/browse';
import { CacheFilters } from '../../../../components/cache-filters';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/**
 * The filters as a query object, for the pager's links.
 *
 * `typedRoutes` cannot check a template string built at runtime, so this
 * returns the object form of `Link`'s `href` instead of a literal string --
 * the supported way to build a typed route dynamically, rather than casting
 * or widening past the check.
 */
function toQuery(filters: Filters, page: number): { readonly pathname: '/admin/cache'; readonly query: Record<string, string> } {
  const query: Record<string, string> = {};
  if (filters.category !== null) query.category = filters.category;
  if (filters.state !== null) query.state = filters.state;
  if (filters.band !== 'any') query.band = filters.band;
  if (filters.disagreementOnly) query.disagreement = '1';
  if (page > 1) query.page = String(page);
  return { pathname: '/admin/cache', query };
}

interface CachePageProps {
  // A Promise in Next 16, like `params`. Both annotations typecheck, so a
  // missing await is not a compile error -- it would silently make every
  // filter undefined and pin the page to an unfiltered first page.
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// `headers()` and `redirect()` both throw control flow, so neither is inside a
// try. The page guards itself as well as the layout, because a layout does not
// re-run on client-side navigation and this is the thing that serves data.
//
// Three branches, matching the layout and the admin index: 401 redirects to
// sign-in; 403 is a genuine wrong-role refusal; anything else -- in practice
// the 503 requireUser returns when reading the session throws -- must not
// claim the reader lacks the admin role, because that is false and would
// send an admin with a fine role off to ask for access they already have.
// requireUser has already logged the real cause via logFailure, so nothing
// here names it. Every arm of `!guard.ok` returns or redirects; none falls
// through to the table below.
export default async function CachePage({ searchParams }: CachePageProps) {
  const guard = await requireAdmin(await headers());
  if (!guard.ok) {
    if (guard.response.status === 401) redirect('/sign-in');
    if (guard.response.status === 403) {
      return (
        <main>
          <h1>Not available</h1>
          <p>This area requires the admin role.</p>
        </main>
      );
    }
    return (
      <main>
        <h1>Temporarily unavailable</h1>
        <p>Your access could not be checked just now. Please try again shortly.</p>
      </main>
    );
  }

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    // First value where a key repeats, matching parseFilters' contract.
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  const filters = parseFilters(params);
  const page = await withTransaction((tx) => browseCache(tx, filters));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Cache browser</h1>
        <p className="text-sm text-muted-foreground">
          {page.total} {page.total === 1 ? 'row' : 'rows'} match. Unscored rows — refused parses,
          lookups with no match, and anything still resolving — are the <em>none</em> band, and are
          usually the interesting ones.
        </p>
      </div>

      <CacheFilters filters={filters} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Hits</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                Nothing matches these filters.
              </TableCell>
            </TableRow>
          ) : page.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs break-all">
                {row.name}
                {row.disagreement ? <Badge variant="outline" className="ml-2">disagreement</Badge> : null}
                {row.pinned ? <Badge variant="outline" className="ml-2">pinned</Badge> : null}
              </TableCell>
              <TableCell>{row.category}</TableCell>
              <TableCell>{row.state}</TableCell>
              <TableCell>{row.confidence === null ? '—' : row.confidence.toFixed(3)}</TableCell>
              <TableCell>{row.hitCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {page.pageCount <= 1 ? null : (
        <div className="flex items-center gap-4 text-sm">
          {page.page > 1
            ? <Link href={toQuery(filters, page.page - 1)} className="underline">Previous</Link>
            : <span className="text-muted-foreground">Previous</span>}
          <span className="text-muted-foreground">Page {page.page} of {page.pageCount}</span>
          {page.page < page.pageCount
            ? <Link href={toQuery(filters, page.page + 1)} className="underline">Next</Link>
            : <span className="text-muted-foreground">Next</span>}
        </div>
      )}
    </div>
  );
}
