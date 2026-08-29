import { withTransaction } from '../../../../lib/db/client';
import { requireUser } from '../../../../lib/auth/session';
import { notFound, unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';
import { revokeKey } from '../../../../lib/keys/manage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const guard = await requireUser(request.headers);
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  // Checked before it reaches SQL: `${id}::uuid` on a non-uuid raises a
  // database error, and a 503 is the wrong answer to a malformed id.
  if (!UUID.test(id)) return notFound('no such key');

  try {
    const revoked = await withTransaction((tx) => revokeKey(tx, guard.user.id, id));
    // Absent, someone else's, or already revoked all answer the same way.
    if (!revoked) return notFound('no such key');
    return new Response(null, { status: 204 });
  } catch (error) {
    logFailure('revokeKey', error);
    return unavailable('the key could not be revoked');
  }
}
