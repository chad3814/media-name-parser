import { headers } from 'next/headers';
import { requireAdmin } from '../../../lib/auth/session';

// Checks again rather than trusting the layout: the layout does not re-run on
// client-side navigation, so a page that serves data checks for itself.
//
// Goes through requireAdmin rather than a bare getCurrentUser so a thrown
// database error is logged via logFailure instead of reaching Next's generic
// error boundary unlabeled. Unlike the layout, a page cannot redirect and
// stay a page -- so both the not-signed-in and the wrong-role refusal render
// the same markup here rather than one of them navigating away.
export default async function AdminPage() {
  const guard = await requireAdmin(await headers());
  if (!guard.ok) {
    return (
      <main>
        <h1>Not available</h1>
        <p>This area requires the admin role.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Admin</h1>
      <p>Signed in as {guard.user.email}.</p>
      <p>Cache inspection lands here in Plan 5.</p>
    </main>
  );
}
