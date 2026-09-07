'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signIn } from '../../../lib/auth/client';

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'error'; readonly message: string };

export function SignInForm({ githubEnabled }: { readonly githubEnabled: boolean }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  /**
   * Starts the GitHub redirect, and reports it when it does not happen.
   *
   * This was `void signIn.social(...)`, which discarded the promise and every
   * rejection with it: a failed request meant no navigation and no message,
   * so the button looked inert. On a Vercel preview behind Deployment
   * Protection that is the normal failure -- the request is redirected to
   * vercel.com, which fails cross-origin -- and the page said nothing at all.
   */
  async function github(): Promise<void> {
    setStatus({ kind: 'sending' });
    try {
      const result = await signIn.social({ provider: 'github', callbackURL: '/' });
      if (result.error) {
        setStatus({ kind: 'error', message: result.error.message ?? 'GitHub sign-in failed' });
        return;
      }
      // Better Auth navigates on success, so reaching here without an error
      // and without leaving the page means the redirect did not happen.
      setStatus({ kind: 'idle' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error
          ? `GitHub sign-in could not start: ${error.message}`
          : 'GitHub sign-in could not start',
      });
    }
  }

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
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
    <div className="space-y-4">
      <form onSubmit={send} className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={status.kind === 'sending'} className="w-full">
          {status.kind === 'sending' ? 'Sending...' : 'Email me a link'}
        </Button>
      </form>

      {status.kind === 'sent' ? (
        <p className="text-sm text-muted-foreground">Check your email for a sign-in link.</p>
      ) : null}
      {status.kind === 'error' ? (
        <p role="alert" className="text-sm text-red-600">{status.message}</p>
      ) : null}

      {githubEnabled ? (
        <>
          {/* A labelled rule, so the second option does not read as part of the form. */}
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={status.kind === 'sending'}
            onClick={() => { void github(); }}
          >
            Continue with GitHub
          </Button>
        </>
      ) : null}
    </div>
  );
}
