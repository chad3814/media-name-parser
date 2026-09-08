import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { getDb } from '../../lib/db/client';
import { getAuth, githubConfigured, magicLinkSink, baseURL } from '../../lib/auth/server';

const run = promisify(execFile);

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

// Any test that calls getAuth() is database-backed and carries opts: getAuth()
// builds the instance on first call, which calls getDb(), which needs
// DATABASE_URL. Only githubConfigured (reads process.env) and the import test
// below (never calls getAuth()) are safe to leave ungated.

test('the instance exposes the api surface the app depends on', opts, async () => {
  for (const method of ['getSession', 'signInMagicLink', 'magicLinkVerify']) {
    assert.ok(method in getAuth().api, `auth.api.${method} is missing`);
  }
});

test('githubConfigured requires both credentials, not either', () => {
  // The values are placeholders, not credentials -- only presence is read.
  const id = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  try {
    process.env.GITHUB_CLIENT_ID = 'placeholder-id';
    process.env.GITHUB_CLIENT_SECRET = 'placeholder-secret';
    assert.equal(githubConfigured(), true);

    delete process.env.GITHUB_CLIENT_SECRET;
    assert.equal(githubConfigured(), false, 'an id alone is not configured');

    process.env.GITHUB_CLIENT_SECRET = 'placeholder-secret';
    delete process.env.GITHUB_CLIENT_ID;
    assert.equal(githubConfigured(), false, 'a secret alone is not configured');

    process.env.GITHUB_CLIENT_ID = '';
    assert.equal(githubConfigured(), false, 'an empty value is not a value');
  } finally {
    restore('GITHUB_CLIENT_ID', id);
    restore('GITHUB_CLIENT_SECRET', secret);
  }
});

test('baseURL throws in production when BETTER_AUTH_URL is unset, but not in development', () => {
  // Next's own types declare `NODE_ENV` readonly on ProcessEnv. That is a
  // type-level guarantee only -- the object itself is a plain mutable
  // process.env -- so this narrows to a writable index type rather than
  // reaching for `any`.
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previousUrl = mutableEnv.BETTER_AUTH_URL;
  const previousEnv = mutableEnv.NODE_ENV;
  try {
    delete mutableEnv.BETTER_AUTH_URL;

    mutableEnv.NODE_ENV = 'production';
    assert.throws(() => baseURL(), /BETTER_AUTH_URL is not set/);

    mutableEnv.NODE_ENV = 'development';
    assert.equal(baseURL(), 'http://localhost:3000');

    mutableEnv.BETTER_AUTH_URL = 'https://example.test';
    mutableEnv.NODE_ENV = 'production';
    assert.equal(baseURL(), 'https://example.test');
  } finally {
    if (previousUrl === undefined) delete mutableEnv.BETTER_AUTH_URL;
    else mutableEnv.BETTER_AUTH_URL = previousUrl;
    if (previousEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = previousEnv;
  }
});

test('a cookie-less request has no session', opts, async () => {
  assert.equal(await getAuth().api.getSession({ headers: new Headers() }), null);
});

test('the magic-link sink captures a token when enabled, so no mail is needed', opts, async () => {
  const previous = process.env.MAGIC_LINK_SINK;
  const email = 'sinkprobe@example.test';
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    await getAuth().api.signInMagicLink({
      body: { email, callbackURL: '/' },
      // Required: without a headers option this throws "Headers is required".
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    assert.equal(magicLinkSink.length, 1, 'the sender should have been called once');
    const entry = magicLinkSink[0];
    assert.equal(entry?.email, email);
    assert.ok((entry?.token ?? '').length > 16, 'and it should carry a real token');
  } finally {
    if (previous === undefined) delete process.env.MAGIC_LINK_SINK;
    else process.env.MAGIC_LINK_SINK = previous;
    magicLinkSink.length = 0;
    // A requested-but-never-verified magic link leaves a row here. The email
    // is stored inside the `value` JSON, not in `identifier`.
    await getDb().execute(sql`DELETE FROM verification WHERE value LIKE ${'%' + email + '%'}`);
  }
});

test('the sink stays empty when it is not enabled', opts, async () => {
  const previous = process.env.MAGIC_LINK_SINK;
  const email = 'nosink@example.test';
  delete process.env.MAGIC_LINK_SINK;
  magicLinkSink.length = 0;
  try {
    await getAuth().api.signInMagicLink({
      body: { email, callbackURL: '/' },
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    assert.equal(magicLinkSink.length, 0, 'production must not accumulate tokens in memory');
  } finally {
    if (previous !== undefined) process.env.MAGIC_LINK_SINK = previous;
    await getDb().execute(sql`DELETE FROM verification WHERE value LIKE ${'%' + email + '%'}`);
  }
});

test('the module imports with no DATABASE_URL and no secret', async () => {
  // The eager form of this module threw at import, which made every test in a
  // file that imported it fail rather than skip. A child process is the only
  // way to assert this from a suite whose own environment has the variables.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.BETTER_AUTH_SECRET;
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', '-e', "await import('./lib/auth/server.ts'); process.stdout.write('ok');"],
    { cwd: process.cwd(), env },
  );
  assert.equal(stdout.trim(), 'ok');
});

/**
 * Sets several env vars and restores exactly what was there.
 *
 * `NODE_ENV` is declared readonly by Next's own ProcessEnv types, which is a
 * type-level guarantee only -- the object is a plain mutable process.env -- so
 * this narrows to a writable index type rather than reaching for `any`.
 */
function withEnv(values: Readonly<Record<string, string | undefined>>, fn: () => void): void {
  const mutable = process.env as Record<string, string | undefined>;
  const previous = new Map(Object.keys(values).map((k) => [k, mutable[k]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete mutable[key];
      else mutable[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutable[key];
      else mutable[key] = value;
    }
  }
}

test('a preview infers its own origin, which cannot be configured ahead of time', () => {
  // Every preview deployment gets a fresh hostname, so no value set at
  // configure time can name it. `VERCEL_URL` is that hostname.
  withEnv({
    BETTER_AUTH_URL: undefined,
    VERCEL_ENV: 'preview',
    VERCEL_URL: 'mnp-git-some-branch-chad3814.vercel.app',
  }, () => {
    assert.equal(baseURL(), 'https://mnp-git-some-branch-chad3814.vercel.app');
  });
});

test('production without BETTER_AUTH_URL still raises, though VERCEL_URL is set there too', () => {
  // On production `VERCEL_URL` holds the `.vercel.app` deployment URL, not the
  // custom domain. An ungated fallback would quietly serve auth from the wrong
  // origin instead of failing, so it is gated on VERCEL_ENV and this stays loud.
  withEnv({
    BETTER_AUTH_URL: undefined,
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    VERCEL_URL: 'mnp-abc123def-chad3814.vercel.app',
  }, () => {
    assert.throws(() => baseURL(), /BETTER_AUTH_URL is not set/);
  });
});

test('an explicit BETTER_AUTH_URL wins over the inferred one', () => {
  withEnv({
    BETTER_AUTH_URL: 'https://openmetadata.nexus',
    VERCEL_ENV: 'preview',
    VERCEL_URL: 'mnp-git-branch-chad3814.vercel.app',
  }, () => {
    assert.equal(baseURL(), 'https://openmetadata.nexus');
  });
});

test('the auth instance builds with the proxy configured', () => {
  // The plugin's endpoint is the observable evidence it is registered: without
  // it the provider would redirect to a preview URL no callback matches.
  withEnv({
    BETTER_AUTH_PROXY_SECRET: 'placeholder-proxy-secret',
    BETTER_AUTH_PRODUCTION_URL: 'https://openmetadata.nexus',
  }, () => {
    assert.ok('oAuthProxy' in getAuth().api, 'the oauth-proxy endpoint should be registered');
  });
});

/** The proxy's last hop, as production receives it. */
async function proxyHop(trusted: string, callbackURL: string): Promise<number> {
  const mutable = process.env as Record<string, string | undefined>;
  const previous = mutable.BETTER_AUTH_TRUSTED_ORIGINS;
  mutable.BETTER_AUTH_TRUSTED_ORIGINS = trusted;
  try {
    // A fresh module per pattern, because getAuth() memoizes its config. The
    // handler must be invoked while the variable is still set: the config is
    // built on the first getAuth() call, not at import.
    const mod = await import(`../../lib/auth/server?trusted=${encodeURIComponent(trusted)}`);
    const url = 'https://openmetadata.nexus/api/auth/oauth-proxy-callback'
      + `?callbackURL=${encodeURIComponent(callbackURL)}`;
    const response = await mod.getAuth().handler(new Request(url, {
      headers: { origin: 'https://openmetadata.nexus' },
    }));
    return response.status;
  } finally {
    if (previous === undefined) delete mutable.BETTER_AUTH_TRUSTED_ORIGINS;
    else mutable.BETTER_AUTH_TRUSTED_ORIGINS = previous;
  }
}

const PREVIEW_ORIGIN = 'https://open-metadata-git-a-branch-chad3814.vercel.app';
const SCOPED_PATTERN = 'https://open-metadata-*-chad3814.vercel.app';

test('production refuses the proxy hop home unless the preview is trusted', async () => {
  // The last hop is production redirecting into the preview that began the
  // handshake, and `originCheck` validates that callbackURL against
  // trustedOrigins. Production trusts only its own baseURL by default and
  // `oAuthProxy` does not widen it, so unconfigured the proxy gets as far as
  // GitHub and is refused on the way home.
  assert.equal(await proxyHop('', `${PREVIEW_ORIGIN}/`), 403,
    'an untrusted preview must be refused');
  assert.notEqual(await proxyHop(SCOPED_PATTERN, `${PREVIEW_ORIGIN}/`), 403,
    'a trusted preview must get past originCheck');
});

test('the trusted pattern is scoped to one project and one team', async () => {
  // A bare `https://*.vercel.app` would trust every deployment on the
  // platform, strangers' included, which is the same mistake as a wildcard
  // OAuth callback and defeats the reason the proxy exists.
  for (const foreign of [
    'https://someone-elses-app-chad3814.vercel.app/',
    'https://open-metadata-git-a-branch-someoneelse.vercel.app/',
    'https://open-metadata-x-chad3814.vercel.app.evil.example/',
    'https://evil.example/',
  ]) {
    assert.equal(await proxyHop(SCOPED_PATTERN, foreign), 403, foreign);
  }
});
