import { unauthorized, unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';
import { sweep } from '../../../../lib/jobs/sweep';

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set,
 * so the same header check serves both the platform and a manual curl.
 *
 * A missing `CRON_SECRET` refuses every request rather than allowing them: an
 * unset secret is a misconfiguration, and the safe reading of a
 * misconfiguration on a route that mutates data is "no".
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization');
  if (secret === undefined || secret.length === 0 || header !== `Bearer ${secret}`) {
    return unauthorized();
  }

  try {
    const report = await sweep({
      workerId: `cron-${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}`,
      now: () => new Date(),
    });
    return Response.json(report);
  } catch (error) {
    // The report is the only output, so a failure has to be visible somewhere.
    logFailure('cron sweep', error);
    return unavailable('the sweep could not be completed');
  }
}
