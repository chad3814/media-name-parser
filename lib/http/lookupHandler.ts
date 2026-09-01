import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { waitUntil } from '@vercel/functions';
import { withTransaction } from '../db/client';
import { apiKeyGate, type Gate } from './gate';
import { badRequest, notFound, unavailable } from './problem';
import { logFailure } from './log';
import { toEnvelope, type LookupEnvelope } from './envelope';
import { suggestForScene } from '../cache/suggest';
import { parseVideo } from '../parse/video';
import { readMediaTree } from '../media/read';
import { resolveLookup, type PipelineDeps } from '../resolve/pipeline';
import type { Category } from '../parse/types';
import { enqueue, settle } from '../jobs/queue';

export const BATCH_CAP = 100;

export const lookupRequestSchema = z.object({
  category: z.enum(['tv', 'movies', 'books', 'xxx']),
  // `.trim()` before `.min(1)`: zod applies these in order, so reversing them
  // would validate the untrimmed string and accept a name of pure whitespace.
  // Trimming here rather than only in the parser keeps the stored name clean,
  // which matters because two spellings that differ by padding share one
  // normalized key but conflict on (category, name) -- two rows, one release.
  name: z.string().trim().min(1, 'name must not be empty'),
});

export const lookupBatchSchema = z.object({
  items: z.array(lookupRequestSchema).min(1).max(BATCH_CAP),
});

/**
 * Which schema applies, decided before either is validated.
 *
 * Validating a `z.union([single, batch])` in one shot reports whichever branch's
 * error zod happens to surface first. For a body like
 * `{ category: 'music', name: 'x.mkv' }` both branches fail, and the reported
 * issue can come from the batch branch -- "items is required" -- which is
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

  // Only when nothing resolved. A cache hit must not pay for this read, and a
  // refusal has no site or performers to offer. `result.parsed` is set only
  // when this request did the parsing, so a cooling row re-parses -- the
  // parser is pure and deterministic, so that costs microseconds and cannot
  // disagree with what was stored under the same parser version.
  const suggestions = result.state !== 'unresolved'
    ? null
    : await withTransaction(async (tx) => {
      const parse = result.parsed ?? (() => {
        const again = parseVideo(category, name);
        return again.ok ? again.parsed : null;
      })();
      return suggestForScene(tx, parse);
    });

  return toEnvelope(result, media, suggestions);
}

/**
 * Finishes a lookup whose in-request attempt blew the deadline, then clears the
 * job row that attempt left behind.
 *
 * The settle is the point. Only `settle(..., { kind: 'done' })` deletes a job
 * row, and without this call the happy path -- the continuation completing in
 * the same invocation, which is what makes the hybrid fast -- left a `pending`
 * job due immediately. The next cron minute then re-ran the whole provider
 * resolution for an already-resolved lookup, and if that redundant retry blew
 * its own deadline it wrote `media_id = NULL, state = 'pending'` over a good
 * answer. The spec is explicit that a job row exists only while work is
 * outstanding.
 *
 * Any state other than `pending` counts as settled, matching the sweeper's own
 * rule: an `unresolved` answer is a completed attempt, not outstanding work,
 * and the 12-hour rule is what revisits it. A still-`pending` outcome leaves
 * the durable row exactly as `enqueue` left it, which is the whole reason the
 * row is written before the continuation starts rather than after.
 */
async function finishAfterDeadline(
  category: Category, name: string, deps: PipelineDeps, jobId: string,
): Promise<void> {
  const result = await resolveLookup({ category, name }, deps, { force: true });
  if (result.state === 'pending') return;
  await withTransaction(async (tx) => settle(tx, jobId, { kind: 'done' }));
}

export interface LookupHandlerOptions {
  /**
   * Where the post-response continuation is handed off. Defaults to Vercel's
   * `waitUntil`, which is the only correct answer in production.
   *
   * Injectable because outside a Vercel invocation `waitUntil` has no context
   * to register with and drops the promise on the floor, leaving a test with a
   * detached continuation still writing to the database after it finished.
   * A test that needs to assert what the continuation did -- that it settled
   * its job, for instance -- has to be able to await it.
   */
  readonly defer?: (promise: Promise<void>) => void;

  /**
   * Who may run this lookup. Defaults to an API key, which is what
   * `/api/v1/lookup` serves. The browser route passes `sessionGate`.
   */
  readonly gate?: Gate;
}

/**
 * The `POST /api/v1/lookup` body, given a way to build the provider wiring
 * to resolve with.
 *
 * `makeDeps` takes the category, and is a factory rather than a built
 * `PipelineDeps` for two reasons.
 *
 * It is called only once auth and body validation have already succeeded,
 * inside the `try` that turns a failure into a logged 503. Accepting a built
 * object instead would mean the caller's expression -- `buildDeps(...)` in
 * production -- evaluates before this function ever runs, since JavaScript
 * evaluates call arguments eagerly; and `buildDeps` throws when the
 * credential for its category is not configured. With an eager argument that
 * throw happens outside any `catch` here, so a request that should cleanly
 * 401 (bad token) or 400 (bad body) would surface as an uncaught exception
 * before either check ran. Constructing only after those checks pass keeps a
 * missing credential a 503 -- a server misconfiguration, which is what it
 * actually is -- rather than a crash that bypasses the problem+json contract
 * and `logFailure` entirely.
 *
 * And it takes the category because a batch may mix them, and a credential
 * missing for one category must not decide the answer for another. It is
 * called at most once per category per request (see `depsFor`), so a batch
 * still shares one client -- and therefore one token bucket -- per category.
 */
export async function handleLookup(
  request: Request,
  makeDeps: (category: Category) => PipelineDeps,
  options: LookupHandlerOptions = {},
): Promise<Response> {
  const defer = options.defer ?? waitUntil;
  const gate = options.gate ?? apiKeyGate;
  const pass = await gate(request);
  if (!pass.ok) return pass.response;

  let raw: unknown;
  try {
    // The immediate argument of a zod parse: the one permitted `unknown`.
    raw = await request.json();
  } catch {
    return badRequest('the body must be JSON');
  }

  const parsed = isBatchShaped(raw)
    ? lookupBatchSchema.safeParse(raw)
    : lookupRequestSchema.safeParse(raw);
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
    // Built here, not passed in already built: this is the one call site that
    // can turn "no credential configured for this category" into a clean 503
    // instead of an uncaught throw, because it runs after auth and validation
    // have already succeeded and it is covered by the catch below.
    //
    // Memoised per category, so a hundred `movies` items in one batch share
    // one client and therefore one token bucket -- the sequential loop below
    // is not what bounds provider load, and a limiter that works only because
    // nobody has parallelised the loop yet enforces nothing.
    const built = new Map<Category, PipelineDeps>();
    const depsFor = (forCategory: Category): PipelineDeps => {
      const existing = built.get(forCategory);
      if (existing !== undefined) return existing;
      const made = makeDeps(forCategory);
      built.set(forCategory, made);
      return made;
    };

    if ('items' in parsed.data) {
      // Sequential rather than parallel: a batch of 100 fired at once would
      // burn the whole TMDB budget in a burst and the token bucket would then
      // serialise them anyway, just with 100 open sockets instead of one.
      const results: (LookupEnvelope & { readonly status: number })[] = [];
      for (const item of parsed.data.items) {
        const envelope = await runOne(item.category, item.name, depsFor(item.category));
        // A batch item gets the same durability guarantee a single lookup
        // does. The spec's Batch form says "misses are enqueued", and without
        // this an item that blew its deadline came back `pending` with no job
        // row -- so it was only ever retried if somebody asked again, twelve
        // hours later. That is the endpoint the corpus runner uses, which is
        // exactly where silently dropped work is least likely to be noticed.
        //
        // Enqueued but not continued: a hundred `waitUntil` continuations
        // fired from one invocation would burst the provider budget the
        // sequential loop above exists to protect. The cron picks them up
        // within the minute instead.
        if (envelope.partial && !envelope.cached) {
          await withTransaction(async (tx) => enqueue(tx, envelope.lookupId));
        }
        // Per-item status, not a constant: the spec introduced this field to
        // carry per-item state, and hardcoding 200 meant it carried none. An
        // item still resolving is a 202 for the same reason a single lookup is.
        results.push({ ...envelope, status: envelope.partial ? 202 : 200 });
      }
      // The envelope is always 200: the transport succeeded even when an item
      // is still resolving, and a top-level 202 would force callers to
      // re-inspect every entry regardless.
      return Response.json({ results });
    }

    const envelope = await runOne(parsed.data.category, parsed.data.name,
      depsFor(parsed.data.category));
    if (envelope.partial) {
      // Only the request that actually made the attempt owns the follow-up
      // work. A partial *and cached* envelope is the cooling-window answer:
      // some earlier request attempted this lookup within the last 12 hours
      // and its job is already queued. The spec's step 4 says such a request
      // returns current data with `partial: true` and does "no external
      // work", and success criterion 2 says it makes zero provider calls.
      //
      // Acting on `partial` alone did the opposite, twice over: it
      // re-enqueued -- resetting `next_attempt_at` to now, so a client
      // retrying in a loop reset the backoff on every pass and got unbounded
      // provider attempts, and an `abandoned` job was resurrected to
      // `pending` each time -- and it fired a second continuation that called
      // the provider again for a lookup nothing had asked to be retried.
      if (!envelope.cached) {
        // Two mechanisms, on purpose. The continuation usually finishes the
        // job in this same invocation, which is what makes the hybrid path
        // fast; the durable row, written first, is what covers the case where
        // the function dies before it can.
        const jobId = await withTransaction(async (tx) => enqueue(tx, envelope.lookupId));
        // A fresh `makeDeps()` call, not the deps `depsFor` already built:
        // that one's `drainCalls` has already been consumed by the in-request
        // attempt, and this continuation runs after the response is sent, so
        // it should not share a token bucket across that boundary either.
        defer(finishAfterDeadline(
          parsed.data.category, parsed.data.name, makeDeps(parsed.data.category), jobId,
        ).catch((error: unknown) => {
          // Nothing is swallowed. The continuation is past the response, so
          // there is no status left to set; the durable job row is what
          // actually recovers the work.
          logFailure(`lookup continuation ${envelope.lookupId}`, error);
        }));
      }
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
 *
 * Always gated by `apiKeyGate`: nothing supplies an alternative today, since
 * `/api/v1/lookup/[id]` is the only route that calls this. A session-gated
 * poll route belongs to whichever later plan adds one, added together with
 * the option that serves it rather than in advance of it.
 */
export async function handlePoll(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const pass = await apiKeyGate(request);
  if (!pass.ok) return pass.response;

  const { id } = await context.params;
  if (!UUID.test(id)) return badRequest('id must be a uuid');

  try {
    const envelope = await withTransaction(async (tx): Promise<LookupEnvelope | null> => {
      const row = await tx.execute(sql`
        SELECT l.id, l.state, l.confidence, l.media_id, l.category, l.name, p.tokens
          FROM lookups l
          LEFT JOIN parses p
            ON p.category = l.category AND p.normalized_key = l.normalized_key
         WHERE l.id = ${id}::uuid`);
      const found = row.rows[0];
      if (found === undefined) return null;
      const mediaId = found.media_id === null ? null : String(found.media_id);
      const media = mediaId === null ? null : await readMediaTree(tx, mediaId);
      const state = String(found.state) as LookupEnvelope['state'];
      // The spec says a poll returns the same envelope a POST does, so an
      // unresolved poll offers the same suggestions rather than silently
      // dropping them. Re-parsed from the stored name because the row holds
      // the parse as opaque jsonb, not as a typed ParsedVideo.
      let suggestions = null;
      if (state === 'unresolved') {
        const again = parseVideo(String(found.category) as Category, String(found.name));
        suggestions = await suggestForScene(tx, again.ok ? again.parsed : null);
      }
      return {
        suggestions,
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
