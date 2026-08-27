import { githubConfigured } from '../../../lib/auth/server';
import { SignInForm } from './sign-in-form';

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
