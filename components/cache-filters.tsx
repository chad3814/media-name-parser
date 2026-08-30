import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { CATEGORIES } from '../lib/parse/types';
import { CONFIDENCE_BANDS, LOOKUP_STATES, type CacheFilters as Filters } from '../lib/cache/browse';

interface CacheFiltersProps {
  readonly filters: Filters;
}

/**
 * The filters, as a plain GET form.
 *
 * Deliberately not a client component: the selects submit to the same URL, the
 * page reads them back through `searchParams`, and the URL is the entire state.
 * That makes a filtered view shareable and bookmarkable -- which is what an
 * admin wants the moment they find an interesting row -- and it works with
 * JavaScript disabled.
 *
 * `page` is not carried over: changing a filter should return to the first
 * page, because page 7 of a different result set is meaningless.
 */
export function CacheFilters({ filters }: CacheFiltersProps) {
  const select = 'h-9 rounded-md border border-input bg-transparent px-3 text-sm';

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="category">Category</Label>
        <select id="category" name="category" defaultValue={filters.category ?? ''} className={select}>
          <option value="">any</option>
          {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="state">State</Label>
        <select id="state" name="state" defaultValue={filters.state ?? ''} className={select}>
          <option value="">any</option>
          {LOOKUP_STATES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="band">Confidence</Label>
        <select id="band" name="band" defaultValue={filters.band} className={select}>
          {CONFIDENCE_BANDS.map((value) => (
            <option key={value} value={value}>
              {value === 'none' ? 'none (unscored)' : value}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="disagreement"
          value="1"
          defaultChecked={filters.disagreementOnly}
        />
        category disagreement only
      </label>

      <Button type="submit" variant="outline" size="sm">Apply</Button>
    </form>
  );
}
