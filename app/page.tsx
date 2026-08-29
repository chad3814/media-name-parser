import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../lib/auth/session';
import { LookupForm } from '../components/lookup-form';

// Checks for itself rather than trusting the shell: a layout does not re-run
// on client-side navigation. `redirect()` throws control flow, so it stays
// outside any try.
export default async function HomePage() {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Look up a filename</h1>
        <p className="text-sm text-muted-foreground">
          Paste a release name or a library path. The parse is derived here; the match comes from
          the cache when it can.
        </p>
      </div>
      <LookupForm />
    </div>
  );
}
