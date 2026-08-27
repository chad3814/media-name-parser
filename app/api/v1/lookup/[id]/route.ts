import { sql } from 'drizzle-orm';
import { withTransaction } from '../../../../../lib/db/client';
import { authenticate } from '../../../../../lib/http/authenticate';
import { badRequest, notFound, unavailable } from '../../../../../lib/http/problem';
import { logFailure } from '../../../../../lib/http/log';
import { readMediaTree } from '../../../../../lib/media/read';
import type { LookupEnvelope } from '../../../../../lib/http/envelope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!UUID.test(id)) return badRequest('id must be a uuid');

  try {
    const envelope = await withTransaction(async (tx): Promise<LookupEnvelope | null> => {
      const row = await tx.execute(sql`
        SELECT l.id, l.state, l.confidence, l.media_id, p.tokens
          FROM lookups l
          LEFT JOIN parses p
            ON p.category = l.category AND p.normalized_key = l.normalized_key
         WHERE l.id = ${id}::uuid`);
      const found = row.rows[0];
      if (found === undefined) return null;
      const mediaId = found.media_id === null ? null : String(found.media_id);
      const media = mediaId === null ? null : await readMediaTree(tx, mediaId);
      const state = String(found.state) as LookupEnvelope['state'];
      return {
        lookupId: String(found.id),
        state,
        // A poll reads a stored row, so nothing is in flight from its point of
        // view; `pending` is what says the work is unfinished.
        partial: state === 'pending',
        cached: true,
        confidence: found.confidence === null ? null : Number(found.confidence),
        refusal: null,
        parsed: found.tokens === null
          ? null
          : (found.tokens as Readonly<Record<string, unknown>>),
        media,
      };
    });
    if (envelope === null) return notFound('no lookup with that id');
    return Response.json(envelope);
  } catch (error) {
    logFailure(`poll ${id}`, error);
    return unavailable('the database is unreachable');
  }
}
