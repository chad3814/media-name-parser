import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authClient } from '../../lib/auth/client';

test('the client exposes magic-link sign-in', () => {
  // Without magicLinkClient() in the plugin list this is undefined rather than
  // an error, and the sign-in form would fail only when a person clicked it.
  assert.equal(typeof authClient.signIn.magicLink, 'function');
});

test('the client exposes social sign-in and sign-out', () => {
  assert.equal(typeof authClient.signIn.social, 'function');
  assert.equal(typeof authClient.signOut, 'function');
});

test('the client exposes the session hook', () => {
  assert.equal(typeof authClient.useSession, 'function');
});

test('the admin client plugin is registered', () => {
  assert.equal(typeof authClient.admin.setRole, 'function');
});
