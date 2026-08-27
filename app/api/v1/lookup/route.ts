import { z } from 'zod';
import { withTransaction } from '../../../../lib/db/client';
import { authenticate } from '../../../../lib/http/authenticate';
import { badRequest, unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';
import { buildTmdbDeps, toEnvelope, type LookupEnvelope } from '../../../../lib/http/envelope';
import { readMediaTree } from '../../../../lib/media/read';
import { resolveLookup } from '../../../../lib/resolve/pipeline';
import type { Category } from '../../../../lib/parse/types';

const BATCH_CAP = 100;

const one = z.object({
  category: z.enum(['tv', 'movies', 'books', 'xxx']),
  name: z.string().min(1, 'name must not be empty'),
});

const batch = z.object({ items: z.array(one).min(1).max(BATCH_CAP) });

/**
 * Which schema applies, decided before either is validated.
 *
 * Validating a `z.union([one, batch])` in one shot reports whichever branch's
 * error zod happens to surface first. For a body like
 * `{ category: 'music', name: 'x.mkv' }` both branches fail, and the reported
 * issue can come from the `batch` branch -- "items is required" -- which is
 * true but useless to a caller who sent a single item and typo'd the
 * category. Checking the shape first means the error that comes back always
 * belongs to the schema the caller was actually attempting.
 *
 * `unknown` here is the structural exception: `value` is only ever checked
 * for whether an `items` key is present, never read as anything typed.
 */
function isBatchShaped(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'items' in value;
}

async function runOne(
  category: Category, name: string, deps: ReturnType<typeof buildTmdbDeps>,
): Promise<LookupEnvelope> {
  const result = await resolveLookup({ category, name }, deps);
  // Bound to a const so the null check narrows inside the closure. Casting
  // `result.mediaId as string` would compile and would also be a lie the day
  // someone reorders these lines.
  const mediaId = result.mediaId;
  const media = mediaId === null
    ? null
    : await withTransaction(async (tx) => readMediaTree(tx, mediaId));
  return toEnvelope(result, media);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    // The immediate argument of a zod parse: the one permitted `unknown`.
    raw = await request.json();
  } catch {
    return badRequest('the body must be JSON');
  }

  const parsed = isBatchShaped(raw) ? batch.safeParse(raw) : one.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined
      ? 'the body is not a valid lookup request'
      : `${path.length > 0 ? `${path}: ` : ''}${first.message}`;
    // The cap is named explicitly, because "too big" without a number is a
    // message the caller cannot act on. Keyed off the failure path rather
    // than off a cast of the raw body: a `too_big` issue on `items` is
    // exactly the case that needs the number.
    const overCap = parsed.error.issues.some(
      (issue) => issue.code === 'too_big' && issue.path[0] === 'items',
    );
    return badRequest(overCap ? `${detail} (a batch holds at most ${BATCH_CAP} items)` : detail);
  }

  const deps = buildTmdbDeps();

  try {
    if ('items' in parsed.data) {
      // Sequential rather than parallel: a batch of 100 fired at once would
      // burn the whole TMDB budget in a burst and the token bucket would then
      // serialise them anyway, just with 100 open sockets instead of one.
      const results: (LookupEnvelope & { readonly status: number })[] = [];
      for (const item of parsed.data.items) {
        const envelope = await runOne(item.category, item.name, deps);
        results.push({ ...envelope, status: 200 });
      }
      // Always 200: the transport succeeded even when an item is still
      // resolving. A top-level 202 would force callers to re-inspect every
      // entry regardless.
      return Response.json({ results });
    }

    const envelope = await runOne(parsed.data.category, parsed.data.name, deps);
    if (envelope.partial) {
      const response = Response.json(envelope, { status: 202 });
      response.headers.set('retry-after', '5');
      return response;
    }
    return Response.json(envelope);
  } catch (error) {
    logFailure('lookup', error);
    return unavailable('the lookup could not be completed');
  }
}
