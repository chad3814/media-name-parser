/**
 * Numeric environment configuration.
 *
 * Two functions rather than one, because the four call sites this replaced did
 * not agree and were right not to. `CONFIDENCE_FLOOR` is `0.75`; parsing it
 * with `parseInt` yields `0`, every score clears a floor of zero, and the
 * service marks every lookup resolved with no error anywhere. That is the
 * failure a single naive helper invites, so the fractional and integral cases
 * are named separately and neither can be reached by accident.
 */

function read(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw.length === 0 ? null : raw;
}

/** For values that are legitimately fractional: a confidence floor, an hour count. */
export function envNumber(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * For values that must be whole: milliseconds, attempt counts, row limits.
 *
 * Parses as a float and then truncates, so `"6.9"` is 6 rather than the `NaN`
 * a strict integer parse would give — and a malformed value still falls back
 * instead of poisoning arithmetic downstream.
 */
export function envInt(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}
