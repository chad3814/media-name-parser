import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, githubConfigured, magicLinkSink } from '../../lib/auth/server';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

test('the instance exposes the api surface the app depends on', () => {
  for (const method of ['getSession', 'signInMagicLink', 'magicLinkVerify']) {
    assert.ok(method in auth.api, `auth.api.${method} is missing`);
  }
});

test('githubConfigured reflects whether both credentials are present', () => {
  const id = process.env.GITHUB_CLIENT_ID ?? '';
  const secret = process.env.GITHUB_CLIENT_SECRET ?? '';
  assert.equal(githubConfigured(), id.length > 0 && secret.length > 0);
});

test('a cookie-less request has no session', opts, async () => {
  assert.equal(await auth.api.getSession({ headers: new Headers() }), null);
});

test('the magic-link sink captures a token when enabled, so no mail is needed', opts, async () => {
  const previous = process.env.MAGIC_LINK_SINK;
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    await auth.api.signInMagicLink({
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
    await auth.api.signInMagicLink({
      body: { email: 'nosink@example.test', callbackURL: '/' },
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    assert.equal(magicLinkSink.length, 0, 'production must not accumulate tokens in memory');
  } finally {
    if (previous !== undefined) process.env.MAGIC_LINK_SINK = previous;
  }
});
