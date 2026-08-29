import { handleLookup } from '../../../../lib/http/lookupHandler';
import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { sessionGate } from '../../../../lib/http/gate';

/**
 * The lookup the browser calls.
 *
 * Identical to `/api/v1/lookup` in every respect but the gate, and it returns
 * the same envelope, so the page and any API consumer read the same shape.
 * It lives under `/api/ui/` rather than `/api/v1/` because `/api/v1` is the
 * documented key-authenticated surface and this is not part of it.
 */
export async function POST(request: Request): Promise<Response> {
  return handleLookup(request, buildTmdbDeps, { gate: sessionGate });
}
