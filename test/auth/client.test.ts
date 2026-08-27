import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authClient } from '../../lib/auth/client';

// The guard against a dropped plugin is `npm run typecheck`, not a runtime
// assertion: removing magicLinkClient() from lib/auth/client.ts makes
// `authClient.signIn.magicLink` a TS2339 error ("Property 'magicLink' does not
// exist"), both here and in sign-in-form.tsx. Verified with a tsc probe.
const magicLinkIsTypedOnTheClient: typeof authClient.signIn.magicLink = authClient.signIn.magicLink;
void magicLinkIsTypedOnTheClient;

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

function recorder(seen: SeenRequest[]) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body;
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: body === undefined || body === null ? null : String(body),
    });
    return new Response('{"status":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('signIn.magicLink posts the address to the magic-link route', async () => {
  // The client is a dynamic path proxy, so `typeof signIn.magicLink` is
  // 'function' even on a client with no plugins at all -- asserting that
  // proves nothing. What is worth pinning is the request it actually makes,
  // because that path is the contract with the route Task 1 mounted.
  const seen: SeenRequest[] = [];
  const result = await authClient.signIn.magicLink(
    { email: 'probe@example.test', callbackURL: '/' },
    { baseURL: 'http://localhost:3000/api/auth', customFetchImpl: recorder(seen) },
  );
  const call = seen[0];
  assert.ok(call !== undefined, 'no request was made');
  assert.equal(new URL(call.url).pathname, '/api/auth/sign-in/magic-link');
  assert.equal(call.method, 'POST');
  assert.ok((call.body ?? '').includes('probe@example.test'));
  assert.equal(result.error, null);
});

test('signOut posts to the sign-out route', async () => {
  const seen: SeenRequest[] = [];
  await authClient.signOut({
    fetchOptions: { baseURL: 'http://localhost:3000/api/auth', customFetchImpl: recorder(seen) },
  });
  const call = seen[0];
  assert.ok(call !== undefined, 'no request was made');
  assert.equal(new URL(call.url).pathname, '/api/auth/sign-out');
  assert.equal(call.method, 'POST');
});
