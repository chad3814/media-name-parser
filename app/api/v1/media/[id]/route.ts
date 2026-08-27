import { withTransaction } from '../../../../../lib/db/client';
import { authenticate } from '../../../../../lib/http/authenticate';
import { badRequest, notFound, unavailable } from '../../../../../lib/http/problem';
import { logFailure } from '../../../../../lib/http/log';
import { readMediaTree } from '../../../../../lib/media/read';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `params` is a Promise in Next 16 and must be awaited. */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  // Checked before the query: passing a non-uuid to a uuid column is a
  // database error, and a 500 for a client's typo is the wrong answer.
  if (!UUID.test(id)) return badRequest('id must be a uuid');

  try {
    const view = await withTransaction(async (tx) => readMediaTree(tx, id));
    if (view === null) return notFound('no media with that id');
    return Response.json({ media: view });
  } catch (error) {
    logFailure(`media ${id}`, error);
    return unavailable('the database is unreachable');
  }
}
