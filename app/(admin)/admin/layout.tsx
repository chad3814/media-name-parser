import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireAdmin } from '../../../lib/auth/session';

/**
 * The admin segment's user-experience guard.
 *
 * Not the security boundary: a layout does not re-run on client-side
 * navigation, so enforcement lives in the page and in the route handlers that
 * serve data. This exists so a person who does not belong here is told so
 * once, at the door, instead of meeting an empty page.
 *
 * `redirect()` only for the not-signed-in case, where /sign-in is genuinely
 * what they need. A signed-in non-admin gets a sentence: Next 16's
 * `forbidden()` needs the experimental `authInterrupts` flag, and turning that
 * on to render one sentence is a poor trade when a layout can just return its
 * own markup instead of children.
 *
 * Goes through `requireAdmin` rather than a bare `getCurrentUser` so a thrown
 * database error is caught and logged by `requireUser` (via `logFailure`)
 * instead of reaching Next's generic error boundary unlabeled. `redirect()`
 * throws control flow and must stay outside the guard's own try/catch, which
 * is exactly what `requireAdmin` already does -- nothing here wraps it in a
 * broader catch that could swallow it.
 */
export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const guard = await requireAdmin(await headers());
  if (!guard.ok) {
    if (guard.response.status === 401) redirect('/sign-in');
    if (guard.response.status === 403) {
      return (
        <main>
          <h1>Not available</h1>
          <p>This area requires the admin role.</p>
        </main>
      );
    }
    // Anything else -- in practice a 503 from requireUser's own catch, when
    // reading the session throws. Rendering "requires the admin role" here
    // would be false: the visitor may well be an admin, and the real fault
    // is a database error requireUser has already sent to logFailure. A false
    // permissions message sends them off to ask for access they already
    // have, which they cannot act on; this message names no cause -- not the
    // error, not the database -- because there is nothing here for the
    // visitor to do with it beyond trying again. Falls through to this
    // return in every remaining case, never to `children`.
    return (
      <main>
        <h1>Temporarily unavailable</h1>
        <p>Your access could not be checked just now. Please try again shortly.</p>
      </main>
    );
  }
  return <>{children}</>;
}
