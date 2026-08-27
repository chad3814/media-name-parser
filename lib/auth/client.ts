'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient, magicLinkClient } from 'better-auth/client/plugins';

/**
 * The browser half of Better Auth.
 *
 * No `baseURL`: the client defaults to the current origin, which is right for
 * every environment we deploy to and avoids an env var that would be wrong on
 * exactly one of them. The plugin list must mirror the server's, or a method
 * the server implements is silently undefined here.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()],
});

export const { signIn, signOut, useSession } = authClient;
