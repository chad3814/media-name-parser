import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getCurrentUser } from '../lib/auth/session';
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
  const user = await getCurrentUser(await headers());

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="font-semibold">media-name-parser</Link>
            {/* The Keys link is added in Task 5, not here. `typedRoutes: true`
                types `Link href` against the routes that exist, so linking to
                /keys before app/keys/page.tsx exists is a TS2322 error, not a
                dead link. */}
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
