import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, magicLink } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { logFailure } from '../http/log';

export interface MagicLinkDelivery {
  readonly email: string;
  readonly token: string;
  readonly url: string;
}

/**
 * Where the magic-link sender puts tokens when `MAGIC_LINK_SINK=1`.
 *
 * Better Auth has no built-in mailer -- it calls a function you supply -- and
 * that is exactly what makes the sign-in flow testable without sending mail.
 * Gated on an explicit variable rather than on a "am I in a test" guess, so
 * production never accumulates live tokens in memory.
 */
export const magicLinkSink: MagicLinkDelivery[] = [];

function env(name: string): string {
  return process.env[name] ?? '';
}

export function githubConfigured(): boolean {
  return env('GITHUB_CLIENT_ID').length > 0 && env('GITHUB_CLIENT_SECRET').length > 0;
}

function secret(): string {
  const value = env('BETTER_AUTH_SECRET');
  if (value.length === 0) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set. Generate one with: ' +
      "printf 'BETTER_AUTH_SECRET=%s\\n' \"$(openssl rand -base64 32)\" >> .env.local",
    );
  }
  return value;
}

// A named function, rather than inlining `betterAuth({...})` inside
// `getAuth()`, so its return type is the concrete type TypeScript infers from
// this literal config -- not the generic `Auth<BetterAuthOptions>` default
// that `ReturnType<typeof betterAuth>` would otherwise widen to. That default
// drops the plugin-specific surface (`signInMagicLink` disappears from
// `.api`) and, under `exactOptionalPropertyTypes`, is mutually unassignable
// with the literal type in both directions.
function buildAuth() {
  return betterAuth({
    secret: secret(),
    baseURL: env('BETTER_AUTH_URL').length > 0 ? env('BETTER_AUTH_URL') : 'http://localhost:3000',
    database: drizzleAdapter(getDb(), { provider: 'pg', schema }),

    // No passwords. The service has no password-reset flow, no rotation policy
    // and no appetite for storing hashes; magic link and OAuth cover it.
    emailAndPassword: { enabled: false },

    // Registered only when both credentials exist. A fake client id produces a
    // confusing redirect failure at sign-in time rather than a clean absence,
    // so the provider is simply not offered until it can work.
    ...(githubConfigured()
      ? {
          socialProviders: {
            github: {
              clientId: env('GITHUB_CLIENT_ID'),
              clientSecret: env('GITHUB_CLIENT_SECRET'),
            },
          },
        }
      : {}),

    plugins: [
      admin(),
      magicLink({
        sendMagicLink: async ({ email, token, url }) => {
          if (env('MAGIC_LINK_SINK') === '1') {
            magicLinkSink.push({ email, token, url });
            return;
          }
          // Deliberately not a throw: failing the sign-in request would tell a
          // caller their address is bad when the real problem is server
          // configuration. The token is never logged.
          logFailure('magicLink', new Error(
            `no mailer is configured, so no link was delivered to ${email}`,
          ));
        },
      }),
      // Must be last: it lets Better Auth set cookies through Next's cookie API.
      nextCookies(),
    ],
  });
}

let instance: ReturnType<typeof buildAuth> | null = null;

/**
 * The Better Auth instance, built on first use.
 *
 * Not a top-level `const`: constructing it calls `getDb()` and reads
 * `BETTER_AUTH_SECRET`, and both throw when unset. At module scope that turns a
 * missing variable into an import-time crash -- `lib/db/client.ts` makes the
 * same argument for `getDb()` itself, and the cost here is concrete. With
 * `DATABASE_URL` unset, every test in a file importing this module fails
 * instead of skipping, and `next build` fails pointing at the wrong thing.
 */
export function getAuth(): ReturnType<typeof buildAuth> {
  if (instance === null) {
    instance = buildAuth();
  }
  return instance;
}
