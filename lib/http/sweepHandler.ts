import { unauthorized, unavailable } from './problem';
import { logFailure } from './log';
import { sweep, type SweepDeps } from '../jobs/sweep';

/**
 * The cron endpoint's body, with its dependencies passed in.
 *
 * Extracted from the route for the same reason `lookupHandler` was: the route
 * built its own `SweepDeps` with no `fetchImpl`, so the only way to test it
 * offline was to swap `globalThis.fetch` and restore it afterwards. That works
 * and it is order-fragile — a test that throws before its `finally` leaves a
 * stubbed global behind for whatever runs next. A parameter is not fragile.
 */
export async function handleSweep(
  request: Request,
  deps: SweepDeps,
  options: { readonly limit?: number } = {},
): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization');
  // A missing `CRON_SECRET` refuses every request rather than allowing them:
  // an unset secret is a misconfiguration, and the safe reading of a
  // misconfiguration on a route that mutates data is "no".
  if (secret === undefined || secret.length === 0 || header !== `Bearer ${secret}`) {
    return unauthorized();
  }

  try {
    return Response.json(await sweep(deps, options));
  } catch (error) {
    // The report is the only output, so a failure has to be visible somewhere.
    logFailure('cron sweep', error);
    return unavailable('the sweep could not be completed');
  }
}
