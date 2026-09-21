import type { Category, ParsedVideo } from '../parse/types';
import type {
  MediaKind, Provider, ResolveContext, ResolveOutcome, ResolvedMedia,
} from './types';
import { logFailure } from '../http/log';

/**
 * How specific a tv record is. A filename naming an episode that comes back
 * as a season has been answered at depth 2 when it asked for depth 3.
 *
 * Kinds outside this table -- `movie`, `book`, `scene` -- are absent rather
 * than zero, so `needsFallback` can tell "shallower" from "not comparable"
 * and never fires for a category with no seasons to miss.
 */
const DEPTH: ReadonlyMap<MediaKind, number> = new Map([
  ['series', 1], ['season', 2], ['episode', 3],
]);

/**
 * Whether the primary provider fell short of the question it was asked.
 *
 * Pure on purpose: no network, no clock, no provider. The whole fallback rule
 * lives here so it can be read and tested in one place.
 *
 * Two cases. No answer at all is the obvious one. The second is subtler and
 * is the reported failure: `tmdb/resolve.ts` returns the *season* when the
 * episode is not on TMDB, and `confidence.ts` docks 0.4 for the miss -- so
 * the lookup answers a shallower question than it was asked and usually lands
 * under the floor, recorded `unresolved` with no sign of what happened.
 */
export function needsFallback(parsed: ParsedVideo, outcome: ResolveOutcome | null): boolean {
  if (outcome === null) return true;
  const asked = DEPTH.get(parsed.kind);
  const got = DEPTH.get(outcome.media.kind);
  if (asked === undefined || got === undefined) return false;
  return got < asked;
}

/** What the primary already established about the series, if anything. */
interface Handover {
  readonly seriesRef: string;
  readonly seriesTitle: string;
}

/**
 * The TVDB series id the primary already published, with the title it knows
 * that series by.
 *
 * TMDB records the id on the *series* node (`tmdb/normalize.ts`), and the
 * shortfall case returns a season, so the chain is walked upward rather than
 * only the returned node inspected.
 *
 * The title travels with the id because the two are one piece of evidence.
 * TheTVDB answers in a series' primary language -- One Piece comes back as
 * `ワンピース` -- so a receiver scoring the handover against its own
 * title would be measuring translation, not identity, and would reject every
 * correct match on a non-English series.
 */
function handoverFrom(media: ResolvedMedia | null): Handover | undefined {
  for (let node = media; node !== null; node = node.parent) {
    const found = node.externalIds.find((id) => id.source === 'tvdb');
    if (found !== undefined) return { seriesRef: found.id, seriesTitle: node.title };
  }
  return undefined;
}

/**
 * A provider that leads with `primary` and asks `secondary` only when the
 * first fell short.
 *
 * A composite rather than a chain inside `lib/resolve/pipeline.ts`: that file
 * owns the transactions, the advisory lock and the deadline, and a
 * tv-specific rule does not belong in it. The pipeline still selects exactly
 * one provider and never learns there are two.
 *
 * `name` is the primary's. That is the provider this composite leads with and
 * the one `providerForIdSource` routes to, so the pipeline's id-based
 * selection keeps working; each client records its own `provider_calls` rows,
 * so call attribution stays honest either way.
 *
 * A null `secondary` is the ordinary case of an unconfigured credential, not
 * an error: the composite is then simply the primary.
 */
export function createFallbackProvider(primary: Provider, secondary: Provider | null): Provider {
  return {
    name: primary.name,
    supports(category: Category): boolean {
      return primary.supports(category);
    },
    async resolve(parsed: ParsedVideo, ctx: ResolveContext): Promise<ResolveOutcome | null> {
      const first = await primary.resolve(parsed, ctx);
      if (secondary === null || !needsFallback(parsed, first)) return first;

      // Computed outside the try below, which exists to absorb a *secondary
      // provider* failure. Reading our own primary's answer is not that, and
      // folding it in would report a bug here as "TheTVDB is down" while
      // silently skipping the fallback altogether.
      const inherited = handoverFrom(first?.media ?? null);
      const handover = inherited === undefined ? ctx : { ...ctx, ...inherited };

      try {
        // `?? first`, not a bare return: the fallback may only improve an
        // answer. A secondary that knows nothing must not turn the primary's
        // shallow answer into no answer at all.
        return (await secondary.resolve(parsed, handover)) ?? first;
      } catch (error) {
        // Swallowed deliberately. A fallback that is down is not an outage of
        // the thing it backs up: propagating here would turn every tv lookup
        // into a 202 and a sweeper retry the moment TheTVDB had a bad hour.
        logFailure(`fallback provider ${secondary.name} failed; keeping ${primary.name}`, error);
        return first;
      }
    },
  };
}
