import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '../../../../lib/auth/server';

/**
 * Better Auth's own routes: sign-in, callback, sign-out, session.
 *
 * The catch-all segment is `[...all]` rather than `[...nextauth]` -- this is
 * Better Auth, not the Auth.js it replaced, and the name is part of its
 * documented contract.
 */
export const { GET, POST } = toNextJsHandler(auth);
