import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { handleLookup } from '../../../../lib/http/lookupHandler';

export async function POST(request: Request): Promise<Response> {
  return handleLookup(request, buildTmdbDeps());
}
