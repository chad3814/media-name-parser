'use client';

import { useState } from 'react';
import { signIn } from '../../../lib/auth/client';

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'error'; readonly message: string };

export function SignInForm({ githubEnabled }: { readonly githubEnabled: boolean }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function send(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus({ kind: 'sending' });
    const result = await signIn.magicLink({ email, callbackURL: '/' });
    if (result.error) {
      // The message is Better Auth's, not ours, and never contains the token.
      setStatus({ kind: 'error', message: result.error.message ?? 'sign-in failed' });
      return;
    }
    setStatus({ kind: 'sent' });
  }

  return (
    <>
      <form onSubmit={send}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={status.kind === 'sending'}>
          {status.kind === 'sending' ? 'Sending...' : 'Email me a link'}
        </button>
      </form>

      {status.kind === 'sent' ? <p>Check your email for a sign-in link.</p> : null}
      {status.kind === 'error' ? <p role="alert">{status.message}</p> : null}

      {githubEnabled ? (
        <button type="button" onClick={() => { void signIn.social({ provider: 'github' }); }}>
          Continue with GitHub
        </button>
      ) : null}
    </>
  );
}
