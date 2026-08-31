import { buildSpec } from '../../../lib/openapi/spec';

/**
 * The API description, served rather than committed as a file.
 *
 * Built per request from the same zod schemas the handler validates against,
 * so the document cannot describe a contract the code has moved past. It is
 * public and touches no database: the routes it describes are already
 * reachable on the internet and each one demands its own API key, so
 * withholding their description protects nothing.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json(buildSpec(), {
    headers: {
      // Static content derived from code, so it changes only on deploy.
      'cache-control': 'public, max-age=300, stale-while-revalidate=86400',
    },
  });
}
