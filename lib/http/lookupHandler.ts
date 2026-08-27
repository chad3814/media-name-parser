import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { waitUntil } from '@vercel/functions';
import { withTransaction } from '../db/client';
import { authenticate } from './authenticate';
import { badRequest, notFound, unavailable } from './problem';
import { logFailure } from './log';
import { toEnvelope, type LookupEnvelope } from './envelope';
import { readMediaTree } from '../media/read';
import { resolveLookup, type PipelineDeps } from '../resolve/pipeline';
import type { Category } from '../parse/types';
import { enqueue } from '../jobs/queue';

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
  category: Category, name: string, deps: PipelineDeps,
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

/**
 * The `POST /api/v1/lookup` body, given a way to build the provider wiring
 * to resolve with.
 *
 * `makeDeps` is a factory, not a built `PipelineDeps`, and it is called only
 * once auth and body validation have already succeeded, inside the `try`
 * that already turns a failure into a logged 503. Accepting a built object
 * instead would mean the caller's expression -- `buildTmdbDeps()` in
 * production -- evaluates before this function ever runs, since JavaScript
 * evaluates call arguments eagerly. `buildTmdbDeps()` calls
 * `tmdbTokenFromEnv()`, which throws when neither TMDB env var is set; with
 * an eager argument that throw happens outside any `catch` here, so a
 * request that should cleanly 401 (bad token) or 400 (bad body) would
 * instead surface as an uncaught exception before either check ran. Delaying
 * construction behind a factory, and constructing only after those checks
 * pass, keeps a missing credential a 503 -- a server misconfiguration, which
 * is what it actually is -- rather than a crash that bypasses the
 * problem+json contract and `logFailure` entirely.
 */
export async function handleLookup(
  request: Request,
  makeDeps: () => PipelineDeps,
): Promise<Response> {
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

  try {
    // Built here, not passed in already built: this is the one call site
    // that can turn "no TMDB credential configured" into a clean 503 instead
    // of an uncaught throw, because it runs after auth and validation have
    // already succeeded and it is covered by the catch below.
    const deps = makeDeps();

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
      // Two mechanisms, on purpose. `waitUntil` usually finishes the job in
      // this same invocation, which is what makes the hybrid path fast; the
      // durable row is what covers the case where the function dies first.
      await withTransaction(async (tx) => enqueue(tx, envelope.lookupId));
      // A fresh `makeDeps()` call, not the `deps` already in scope: that one's
      // `drainCalls` has already been consumed by the in-request attempt, and
      // this continuation runs after the response is sent, so it should not
      // share a token bucket across that boundary either.
      waitUntil(
        runOne(parsed.data.category, parsed.data.name, makeDeps())
          .catch(() => undefined),
      );
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `GET /api/v1/lookup/[id]` poll.
 *
 * No `deps` parameter: a poll only reads stored rows and never touches a
 * provider. It lives alongside `handleLookup` for symmetry, so both handlers
 * behind the two lookup routes are directly testable without going through
 * Next.js.
 */
export async function handlePoll(
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
