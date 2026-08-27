'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient, magicLinkClient } from 'better-auth/client/plugins';

/**
 * The browser half of Better Auth.
 *
 * No `baseURL`: the client defaults to the current origin, which is right for
 * every environment we deploy to and avoids an env var that would be wrong on
 * exactly one of them. The plugin list must mirror the server's -- the client
 * is a dynamic path proxy, so a missing plugin does not fail at runtime, it
 * resolves to a callable function on any path you ask for. A mismatch shows
 * up as a type error at build time instead: dropping a plugin here makes the
 * corresponding method (e.g. `signIn.magicLink`) a TS2339 error wherever a
 * caller uses it.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()],
});

export const { signIn, signOut, useSession } = authClient;
