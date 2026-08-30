import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/session';
import { CorpusRunner } from '../../components/corpus-runner';

// Guards itself rather than trusting the shell: a layout does not re-run on
// client-side navigation. `redirect()` throws control flow, so it stays outside
// any try -- and so does `headers()`, which is how a route gets marked dynamic.
export default async function CorpusPage() {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');

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
