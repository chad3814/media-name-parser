import { githubConfigured } from '../../../lib/auth/server';
import { SignInForm } from './sign-in-form';

// Evaluated per request, not at build. githubConfigured() reads the
// environment, and a statically prerendered page freezes that answer into
// HTML -- so a build without the GitHub credentials would keep hiding the
// button after a deployment that has them, and a build with them would keep
// showing a button that cannot work.
export const dynamic = 'force-dynamic';

// A server component so it can read whether GitHub is configured. The boolean
// crosses the boundary to the client; neither credential does.
export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            We will email you a link. No password to remember.
          </p>
        </div>
        <SignInForm githubEnabled={githubConfigured()} />
      </div>
    </main>
  );
}
