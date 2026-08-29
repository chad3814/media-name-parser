import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/session';
import { withTransaction } from '../../lib/db/client';
import { listKeys } from '../../lib/keys/manage';
import { KeysManager } from '../../components/keys-manager';

// Guards itself, like every other page: a layout does not re-run on
// client-side navigation. `redirect()` throws control flow, so it stays
// outside any try.
export default async function KeysPage() {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');

  // Listed during the render so the page arrives populated rather than
  // empty-then-flashing. The client keeps its own copy afterwards, because it
  // mutates the list as keys come and go.
  const keys = await withTransaction((tx) => listKeys(tx, user.id));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Send a key as <code className="font-mono">Authorization: Bearer …</code> to{' '}
          <code className="font-mono">/api/v1/lookup</code>. The secret is shown once, when you
          create it.
        </p>
      </div>
      <KeysManager initialKeys={keys} />
    </div>
  );
}
