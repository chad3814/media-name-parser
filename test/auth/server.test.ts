import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAuth, githubConfigured, magicLinkSink } from '../../lib/auth/server';

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

test('a cookie-less request has no session', opts, async () => {
  assert.equal(await getAuth().api.getSession({ headers: new Headers() }), null);
});

test('the magic-link sink captures a token when enabled, so no mail is needed', opts, async () => {
  const previous = process.env.MAGIC_LINK_SINK;
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    await getAuth().api.signInMagicLink({
      body: { email: 'sinkprobe@example.test', callbackURL: '/' },
      // Required: without a headers option this throws "Headers is required".
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    assert.equal(magicLinkSink.length, 1, 'the sender should have been called once');
    const entry = magicLinkSink[0];
    assert.equal(entry?.email, 'sinkprobe@example.test');
    assert.ok((entry?.token ?? '').length > 16, 'and it should carry a real token');
  } finally {
    if (previous === undefined) delete process.env.MAGIC_LINK_SINK;
    else process.env.MAGIC_LINK_SINK = previous;
    magicLinkSink.length = 0;
  }
});

test('the sink stays empty when it is not enabled', opts, async () => {
  const previous = process.env.MAGIC_LINK_SINK;
  delete process.env.MAGIC_LINK_SINK;
  magicLinkSink.length = 0;
  try {
    await getAuth().api.signInMagicLink({
      body: { email: 'nosink@example.test', callbackURL: '/' },
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    assert.equal(magicLinkSink.length, 0, 'production must not accumulate tokens in memory');
  } finally {
    if (previous !== undefined) process.env.MAGIC_LINK_SINK = previous;
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
