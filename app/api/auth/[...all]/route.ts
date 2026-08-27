import { getAuth } from '../../../../lib/auth/server';

/**
 * Better Auth's own routes: sign-in, callback, sign-out, session.
 *
 * The catch-all segment is `[...all]` rather than `[...nextauth]` -- this is
 * Better Auth, not the Auth.js it replaced, and the name is part of its
 * documented contract.
 *
 * Written out rather than destructured from `toNextJsHandler(getAuth())`,
 * which would build the instance when this module loads. `toNextJsHandler` is
 * a five-line convenience that returns the same `auth.handler` under GET,
 * POST, PATCH, PUT and DELETE; we only ever mount GET and POST.
 */
export async function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
