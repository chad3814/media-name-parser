import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getCurrentUser, type CurrentUser } from '../lib/auth/session';
import { logFailure } from '../lib/http/log';
import { SignOutButton } from './sign-out-button';

/**
 * The header every signed-in page sits under.
 *
 * A server component because it displays session state. Only the sign-out
 * control is a client component, which is the same split the sign-in page
 * uses: the boundary carries rendered values, never credentials.
 *
 * It does not guard anything. Pages guard themselves -- a layout does not
 * re-run on client-side navigation -- so a shell that refused to render would
 * give a false sense of protection.
 */
export async function AppShell({ children }: { readonly children: ReactNode }) {
  // Outside the try on purpose. `headers()` throws Next's dynamic-usage signal
  // during static generation, and that throw is how a route gets marked
  // dynamic -- catching it logs a control-flow signal as an error and, for a
  // page that reached `headers()` only through this shell, would let Next
  // prerender a page that must not be prerendered. Same rule as `redirect()`:
  // a function that throws control flow does not belong in a try.
  const requestHeaders = await headers();

  let user: CurrentUser | null = null;
  try {
    user = await getCurrentUser(requestHeaders);
  } catch (error) {
    // The shell wraps every page, including /sign-in. A database outage here
    // must not turn the sign-in page into a 500, and must not go unlogged.
    logFailure('appShell', error);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="font-semibold">media-name-parser</Link>
            <Link href="/keys" className="text-muted-foreground hover:text-foreground">Keys</Link>
            <Link href="/corpus" className="text-muted-foreground hover:text-foreground">Corpus</Link>
            {user?.isAdmin === true ? (
              <Link href="/admin" className="text-muted-foreground hover:text-foreground">Admin</Link>
            ) : null}
          </nav>
          {user === null ? (
            <Link href="/sign-in" className="text-sm underline">Sign in</Link>
          ) : (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">{user.email}</span>
              <SignOutButton />
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
