import type { Category } from '../parse/types';
import type { ProviderName } from './types';

/**
 * Which provider answers a category, or null when none does.
 *
 * One table, imported by both the request path (`lib/http/envelope.ts`) and
 * the retry path (`lib/jobs/sweep.ts`), because those two had the same rule
 * written out twice and a rule duplicated is a rule that drifts.
 *
 * `books` maps to null deliberately. Its provider, ibdb.dev, is not
 * implemented, and the distinction matters: a category with no provider must
 * answer `unresolved`, while a category whose provider exists but whose
 * credential is missing must fail loudly. Routing `books` to TMDB -- which
 * does not support it anyway -- made a `books` lookup on a deployment with no
 * TMDB credential raise a 503 for a category nothing was ever going to serve.
 */
export function providerFor(category: Category): ProviderName | null {
  switch (category) {
    case 'xxx': return 'tpdb';
    case 'tv':
    case 'movies': return 'tmdb';
    // No `default`: adding a category should fail the build here, not silently
    // route somewhere wrong.
    case 'books': return null;
  }
}
