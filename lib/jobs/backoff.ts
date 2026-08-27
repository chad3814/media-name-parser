function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

export const JOB_MAX_ATTEMPTS = envNumber('JOB_MAX_ATTEMPTS', 6);

/**
 * How long a sweeper's claim on a job is honoured before another sweeper may
 * take it back.
 *
 * Five minutes is chosen from both ends. The floor: a claimed job runs one
 * lookup under an 8-second deadline (`LOOKUP_DEADLINE_MS`), so any lease past
 * ~10 seconds cannot expire under a worker still making progress, and five
 * minutes leaves room for a whole sweep of jobs to finish without any of them
 * being stolen mid-flight. The ceiling: the cron runs every minute, so a job
 * stranded by a platform timeout or a mid-loop crash -- the two ways a claim
 * outlives its worker, since nothing else ever clears `state = 'running'` --
 * comes back within five sweeps rather than never. Without a lease those rows
 * are permanently invisible to `claimDue`, which is the whole failure this
 * constant exists to bound.
 */
export const JOB_LEASE_MS = envNumber('JOB_LEASE_MS', 5 * 60_000);

const BASE_MS = 15_000;
const CAP_MS = 6 * 3600_000;
/** Up to +50%, so two jobs failing in the same tick do not return together. */
const JITTER_FRACTION = 0.5;

/**
 * How long to wait before the next attempt.
 *
 * Pure, with the random source injected, because "does the delay grow" and
 * "does jitter actually spread things" are the only interesting questions and
 * both are untestable against `Math.random`.
 */
export function nextDelayMs(attempts: number, random: () => number = Math.random): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const exponential = Math.min(CAP_MS, BASE_MS * 2 ** (safeAttempts - 1));
  return Math.round(exponential * (1 + JITTER_FRACTION * random()));
}
