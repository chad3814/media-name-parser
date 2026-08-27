import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { handleLookup } from '../../../../lib/http/lookupHandler';

export async function POST(request: Request): Promise<Response> {
  // The function itself, not its result: buildTmdbDeps must not run until
  // handleLookup has already authenticated and validated the request, since
  // it throws when no TMDB credential is configured.
  return handleLookup(request, buildTmdbDeps);
}
