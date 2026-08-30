/**
 * How many names one corpus request may carry.
 *
 * Arithmetic rather than taste. `handleLookup` runs batch items sequentially --
 * deliberately, so a burst does not exhaust the TMDB budget -- and each item
 * has up to `LOOKUP_DEADLINE_MS` (8s) before it gives up and returns partial.
 * With `maxDuration` at 60, five items is 40s of worst case and leaves room for
 * the round trip. Ten would be 80s: the request would die mid-batch, and the
 * items it had already written would never be reported to the caller.
 *
 * This lives here rather than in the route because the browser must chunk to
 * the same number the route enforces, and `CORPUS_CHUNK` is a value -- so a
 * client component importing it from the route would drag `handleLookup`,
 * Drizzle and the TMDB client into the bundle. This module imports nothing, on
 * purpose. Keep it that way.
 */
export const CORPUS_CHUNK = 5;
