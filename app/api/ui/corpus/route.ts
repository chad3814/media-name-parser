import { handleLookup } from '../../../../lib/http/lookupHandler';
import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { sessionGate } from '../../../../lib/http/gate';
import { badRequest } from '../../../../lib/http/problem';
import { CORPUS_CHUNK } from '../../../../lib/corpus/chunk';

export const maxDuration = 60;

/**
 * The bulk lookup the corpus page calls.
 *
 * A separate route from `/api/ui/lookup` rather than a relaxation of it.
 * `sessionGate` charges no rate limit, so Plan 5 refused batch bodies on the
 * single-item route and asked that a bulk page "lift this deliberately, with a
 * limit attached, rather than by deleting the check". This is that: its own
 * cap, its own budget, and a name that says what it is.
 *
 * Batch only. A single-item body belongs on `/api/ui/lookup`, and a route that
 * accepted either would let a caller half-use both.
 */
export async function POST(request: Request): Promise<Response> {
  // Gate before touching the body: an unauthenticated caller should not have
  // its payload parsed, and its status must not depend on the body's shape.
  // handleLookup gates again below -- one extra session read on a route that
  // is about to do up to five provider lookups, which is a price worth paying
  // for not having an always-passing gate in the codebase.
  const pass = await sessionGate(request);
  if (!pass.ok) return pass.response;

  const raw: unknown = await request.clone().json().catch(() => null);
  // `unknown` is the deserialization exception: `raw` is inspected for the
  // shape of its `items` key and never read as a typed value. The full
  // validation is `handleLookup`'s.
  if (typeof raw !== 'object' || raw === null || !('items' in raw)) {
    return badRequest('this route takes a batch; a single lookup goes to /api/ui/lookup');
  }
  const items = (raw as { readonly items: unknown }).items;
  if (Array.isArray(items) && items.length > CORPUS_CHUNK) {
    return badRequest(`a corpus chunk holds at most ${CORPUS_CHUNK} names`);
  }
  return handleLookup(request, buildTmdbDeps, { gate: sessionGate });
}
