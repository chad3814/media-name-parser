import { buildDeps } from '../../../../lib/http/envelope';
import { handleLookup } from '../../../../lib/http/lookupHandler';

export async function POST(request: Request): Promise<Response> {
  // The function itself, not a built result: `buildDeps` needs the request's
  // category, and it must not run until handleLookup has authenticated and
  // validated the request -- it throws when the credential for that category
  // is not configured, and only inside handleLookup's own try does that throw
  // become a logged 503 rather than an uncaught exception.
  return handleLookup(request, buildDeps);
}
