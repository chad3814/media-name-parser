import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireUser } from '../../lib/auth/session';
import { CorpusRunner } from '../../components/corpus-runner';

// Guards itself rather than trusting the shell: a layout does not re-run on
// client-side navigation. `redirect()` throws control flow, so it stays outside
// any try -- and so does `headers()`, which is how a route gets marked dynamic.
//
// Goes through requireUser rather than a bare getCurrentUser so a thrown
// database error is caught and logged by requireUser (via logFailure)
// instead of reaching Next's generic error boundary unlabeled -- the mirror
// of the fix just made to the cache page's guard, one directory over.
export default async function CorpusPage() {
  const guard = await requireUser(await headers());
  if (!guard.ok) {
    if (guard.response.status === 401) redirect('/sign-in');
    // Anything else -- in practice the 503 requireUser returns when reading
    // the session throws. requireUser has already logged the real cause.
    return (
      <main>
        <h1>Temporarily unavailable</h1>
        <p>Your session could not be checked just now. Please try again shortly.</p>
      </main>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Corpus runner</h1>
        <p className="text-sm text-muted-foreground">
          Paste or upload newline-delimited names for one category and run them as a batch. Names
          already in the cache answer instantly; cold ones may be queued for the background sweeper.
        </p>
      </div>
      <CorpusRunner />
    </div>
  );
}
