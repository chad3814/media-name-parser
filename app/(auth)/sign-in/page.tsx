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
    <main>
      <h1>Sign in</h1>
      <SignInForm githubEnabled={githubConfigured()} />
    </main>
  );
}
