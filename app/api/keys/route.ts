import { z } from 'zod';
import { withTransaction } from '../../../lib/db/client';
import { requireUser } from '../../../lib/auth/session';
import { badRequest, unavailable } from '../../../lib/http/problem';
import { logFailure } from '../../../lib/http/log';
import { createKey, listKeys } from '../../../lib/keys/manage';

/**
 * A user's own API keys.
 *
 * `requireUser` rather than Task 2's gate: every query here is scoped to the
 * owner, so this route needs the user the gate deliberately discards.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireUser(request.headers);
  if (!guard.ok) return guard.response;
  try {
    const keys = await withTransaction((tx) => listKeys(tx, guard.user.id));
    return Response.json({ keys });
  } catch (error) {
    logFailure('listKeys', error);
    return unavailable('the keys could not be read');
  }
}

const createBody = z.object({ label: z.string().min(1, 'label must not be empty').max(120) });

export async function POST(request: Request): Promise<Response> {
  const guard = await requireUser(request.headers);
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('the body must be JSON');
  }
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'invalid body');
  }

  try {
    const made = await withTransaction((tx) => createKey(tx, guard.user.id, parsed.data.label));
    // The only time the secret is ever sent. It is not stored and cannot be
    // shown again.
    return Response.json({ key: made.row, token: made.token }, { status: 201 });
  } catch (error) {
    logFailure('createKey', error);
    return unavailable('the key could not be created');
  }
}
