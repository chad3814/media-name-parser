import Link from 'next/link';
import { headers } from 'next/headers';
import { requireAdmin } from '../../../lib/auth/session';

// Checks again rather than trusting the layout: the layout does not re-run on
// client-side navigation, so a page that serves data checks for itself.
//
// Goes through requireAdmin rather than a bare getCurrentUser so a thrown
// database error is logged via logFailure instead of reaching Next's generic
// error boundary unlabeled. Unlike the layout, a page cannot redirect and
// stay a page -- so the not-signed-in (401) and wrong-role (403) refusals
// render the same "Not available" markup here rather than one of them
// navigating away. A third, distinct branch covers anything else -- in
// practice the 503 requireUser returns when reading the session throws --
// because presenting a database error as a permissions problem would be
// false, and false is worse than vague: the visitor would go ask for access
// they already have while the real fault is an outage. See the layout's
// comment for the same reasoning. This branch names no cause; requireUser
// already logged it.
export default async function AdminPage() {
  const guard = await requireAdmin(await headers());
  if (!guard.ok) {
    if (guard.response.status === 401 || guard.response.status === 403) {
      return (
        <main>
          <h1>Not available</h1>
          <p>This area requires the admin role.</p>
        </main>
      );
    }
    return (
      <main>
        <h1>Temporarily unavailable</h1>
        <p>Your access could not be checked just now. Please try again shortly.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Admin</h1>
      <p>Signed in as {guard.user.email}.</p>
      <p><Link href="/admin/cache" className="underline">Browse the lookup cache</Link>.</p>
    </main>
  );
}
