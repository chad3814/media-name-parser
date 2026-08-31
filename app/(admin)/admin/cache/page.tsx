import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadCacheView, type CacheFilters as Filters } from '../../../../lib/cache/view';
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

/**
 * Formats `createdAt` for display.
 *
 * Matches `components/keys-manager.tsx`'s `when()`: deterministic in UTC
 * regardless of the server's or the visitor's timezone, so the table cannot
 * render one time during SSR and a different one after hydration --
 * `toLocaleString()` guarantees exactly that mismatch. Reimplemented locally
 * rather than imported, because `when()` lives in a `'use client'` module and
 * this page must stay a server component.
 */
function firstSeen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

interface CachePageProps {
  // A Promise in Next 16, like `params`. Both annotations typecheck, so a
  // missing await is not a compile error -- it would silently make every
  // filter undefined and pin the page to an unfiltered first page.
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// `headers()` and `redirect()` both throw control flow, so neither is inside a
// try. The guard itself lives in lib/cache/view.ts's loadCacheView -- an async
// Server Component cannot be rendered from node:test, so a guard kept here
// would be untestable, which is exactly what let a reviewer replace it with
// `void guard;` and watch every test stay green while the page kept serving
// cache data to a non-admin. This page only interprets the CacheView that
// comes back; it does not import the query functions behind loadCacheView,
// so there is no way for it to query around the guard.
export default async function CachePage({ searchParams }: CachePageProps) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    // First value where a key repeats, matching the filter parser's contract.
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }

  const view = await loadCacheView(await headers(), params);
  if (view.kind === 'signin') redirect('/sign-in');
  if (view.kind === 'refused') {
    return view.reason === 'role' ? (
      <main>
        <h1>Not available</h1>
        <p>This area requires the admin role.</p>
      </main>
    ) : (
      <main>
        <h1>Temporarily unavailable</h1>
        <p>Your access could not be checked just now. Please try again shortly.</p>
      </main>
    );
  }

  // view.kind === 'ready' -- filters and page come from here, not from a
  // second call, so the page cannot query around the guard.
  const { filters, page } = view;

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
            <TableHead>First seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
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
              <TableCell>{firstSeen(row.createdAt)}</TableCell>
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
