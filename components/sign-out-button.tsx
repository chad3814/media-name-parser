'use client';

import { useState } from 'react';
import { signOut } from '../lib/auth/client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const [leaving, setLeaving] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={leaving}
      onClick={() => {
        setLeaving(true);
        // The redirect is deliberate rather than a router refresh: signing out
        // invalidates the session the current page was rendered against, and
        // re-rendering it would show a stale identity until the next fetch.
        void signOut().finally(() => { window.location.href = '/sign-in'; });
      }}
    >
      {leaving ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
