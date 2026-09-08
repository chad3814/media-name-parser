import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, magicLink, oAuthProxy } from 'better-auth/plugins';
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

/**
 * The origin the OAuth provider redirects to, in every environment.
 *
 * `oAuthProxy` defaults this to `BETTER_AUTH_URL`, which is correct on
 * production and wrong everywhere else: a preview sets `BETTER_AUTH_URL` to
 * its own origin, so the plugin would conclude it already *is* production and
 * decline to proxy -- silently, with the provider then refusing an
 * unregistered callback. Naming it separately keeps the two ideas apart.
 *
 * Undefined on production, where the plugin's own default is right.
 */
function proxyProductionURL(): string | undefined {
  const explicit = env('BETTER_AUTH_PRODUCTION_URL');
  return explicit.length > 0 ? explicit : undefined;
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

/**
 * `BETTER_AUTH_URL` in production, or `http://localhost:3000` in development.
 *
 * A missing `baseURL` is not an error to Better Auth -- it derives one from
 * the incoming request and warns that callbacks and redirects may not work
 * correctly. But an explicit `baseURL`, once set, short-circuits that
 * resolution chain entirely and also becomes the only trusted origin
 * (`trustedOrigins` is derived from the same value). A silent
 * `http://localhost:3000` default in production would therefore pin
 * `trustedOrigins` to localhost and send every magic link there too -- a
 * deployment that omits the variable would see broken OAuth callbacks and
 * failed origin checks that look like a provider problem, not a
 * configuration one. Development keeps the convenience default because
 * nothing there is reachable from outside localhost anyway.
 */
export function baseURL(): string {
  const value = env('BETTER_AUTH_URL');
  if (value.length > 0) return value;

  // A Vercel preview gets a fresh hostname on every deployment, so its own
  // origin cannot be configured ahead of time; `VERCEL_URL` is that hostname.
  //
  // Gated on `VERCEL_ENV === 'preview'` deliberately. `VERCEL_URL` is set on
  // production too -- to the `.vercel.app` deployment URL rather than the
  // custom domain -- so an ungated fallback would quietly serve auth from the
  // wrong origin on production instead of raising below. A missing
  // `BETTER_AUTH_URL` in production stays loud.
  if (env('VERCEL_ENV') === 'preview') {
    const host = env('VERCEL_URL');
    if (host.length > 0) return `https://${host}`;
  }

  if (env('NODE_ENV') === 'production') {
    throw new Error(
      'BETTER_AUTH_URL is not set. Set it to this deployment\'s own origin, ' +
      'e.g. BETTER_AUTH_URL=https://example.com',
    );
  }
  return 'http://localhost:3000';
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
    baseURL: baseURL(),
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
      // Preview deployments cannot register their own OAuth callback: the
      // hostname changes every deployment, and GitHub's wildcard matching is
      // over subdomains of a host you control -- which `*.vercel.app` is not.
      //
      // So the provider always redirects to production, and production hands
      // the handshake onward to whichever preview started it, carrying the
      // `set-cookie` across. One registered callback covers every preview.
      //
      // The proxy secret is deliberately separate from `secret()`. It has to
      // be shared by every environment taking part, and sharing the main
      // secret would let a leak from a preview forge production sessions.
      // Falls back to the main secret when unset, which is the plugin's own
      // default and fine for a single-environment deployment.
      // The last hop is production redirecting into the preview that began the
      // handshake, and Better Auth's `originCheck` validates that
      // `callbackURL` against its trusted origins. Production trusts only its
      // own `baseURL` by default and this plugin does not widen it, so
      // without `BETTER_AUTH_TRUSTED_ORIGINS` the handshake reaches GitHub and
      // is refused 403 on the way home.
      //
      // That variable is read by Better Auth itself, so there is nothing to
      // wire here -- only to set. Scope it to the project and the team,
      // `https://open-metadata-*-chad3814.vercel.app`; a bare
      // `https://*.vercel.app` would trust every deployment on the platform,
      // strangers' included, which is the same mistake as a wildcard OAuth
      // callback and defeats the reason this proxy exists.
      oAuthProxy({
        ...(env('BETTER_AUTH_PROXY_SECRET').length > 0
          ? { secret: env('BETTER_AUTH_PROXY_SECRET') }
          : {}),
        ...(proxyProductionURL() === undefined
          ? {}
          : { productionURL: proxyProductionURL() as string }),
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
