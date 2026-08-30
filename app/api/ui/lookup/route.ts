import { handleLookup } from '../../../../lib/http/lookupHandler';
import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { sessionGate } from '../../../../lib/http/gate';
import { badRequest } from '../../../../lib/http/problem';

export const maxDuration = 60;

/**
 * The lookup the browser calls.
 *
 * Identical to `/api/v1/lookup` but for the gate, and it returns the same
 * envelope. Batched bodies are refused here: `sessionGate` charges no rate
 * limit -- a person clicking a form does not need throttling -- but the shared
 * handler accepts up to 100 items, so without this the session route is an
 * unthrottled bulk endpoint. The page sends one name at a time. `/api/ui/corpus`
 * is the bulk route: it lifts this check deliberately, with its own cap
 * attached, rather than by deleting it here.
 *
 * The body is read from a clone so `handleLookup` still gets an unconsumed
 * request.
 */
export async function POST(request: Request): Promise<Response> {
  const raw: unknown = await request.clone().json().catch(() => null);
  // `unknown` is the deserialization exception: `raw` is only tested for the
  // presence of an `items` key, never read as a typed value.
  if (typeof raw === 'object' && raw !== null && 'items' in raw) {
    return badRequest('batched lookups go to /api/ui/corpus');
  }
  return handleLookup(request, buildTmdbDeps, { gate: sessionGate });
}
