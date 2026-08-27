import { handleSweep } from '../../../../lib/http/sweepHandler';

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set,
 * so one header check serves both the platform and a manual curl. The check
 * itself lives in `handleSweep`.
 */

/**
 * Sixty seconds, paired with `SWEEP_LIMIT`.
 *
 * The sweep is sequential and each job may spend up to `LOOKUP_DEADLINE_MS`
 * (8s), so the worst case is the limit times that — six jobs is about 48
 * seconds. Raising one without the other is what put the previous default of
 * twenty-five jobs at 200 seconds against an unset duration, where a cut-short
 * sweep booked reclaims as attempts and could abandon a job on a stale error.
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleSweep(request, {
    workerId: `cron-${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}`,
    now: () => new Date(),
  });
}
