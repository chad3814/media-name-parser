import { headers } from 'next/headers';
import { getCurrentUser } from '../../../lib/auth/session';

// Checks again rather than trusting the layout: the layout does not re-run on
// client-side navigation, so a page that serves data checks for itself.
export default async function AdminPage() {
  const user = await getCurrentUser(await headers());
  if (user === null || !user.isAdmin) {
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
      <p>Signed in as {user.email}.</p>
      <p>Cache inspection lands here in Plan 5.</p>
    </main>
  );
}
