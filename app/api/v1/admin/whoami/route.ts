import { requireAdmin } from '../../../../../lib/auth/session';

/**
 * Who the caller is, if the caller is an admin.
 *
 * Session-authenticated rather than key-authenticated: this is the admin UI's
 * own endpoint, and `lib/http/authenticate.ts` answers a different question
 * (which API key is this) for a different audience. Mixing the two would give
 * an API key a way into the admin surface.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireAdmin(request.headers);
  if (!guard.ok) return guard.response;
  const { id, email, name, roles, isAdmin } = guard.user;
  return Response.json({ id, email, name, roles, isAdmin });
}
