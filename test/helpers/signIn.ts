import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb } from '../../lib/db/client';
import { getAuth, magicLinkSink } from '../../lib/auth/server';

/**
 * Signs a fresh user in and returns headers carrying their session cookie.
 *
 * `signInMagicLink` requires a `headers` option even though nothing in it
 * matters, and `magicLinkVerify` must be called with `asResponse: true` --
 * without it the return value is not a Response and the Set-Cookie is
 * unreachable.
 *
 * `MAGIC_LINK_SINK` is set and restored around the call rather than left on,
 * so a test that forgets to clean up cannot change how a later test behaves.
 */
export async function signIn(email: string): Promise<Headers> {
  const previous = process.env.MAGIC_LINK_SINK;
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    await getAuth().api.signInMagicLink({
      body: { email, callbackURL: '/' },
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    const delivery = magicLinkSink.at(-1);
    assert.ok(delivery !== undefined, 'no magic link was captured');
    const verified = await getAuth().api.magicLinkVerify({
      query: { token: delivery.token },
      headers: new Headers({ 'content-type': 'application/json' }),
      asResponse: true,
    });
    const setCookie = verified.headers.get('set-cookie');
    assert.ok(setCookie !== null, 'verification issued no session cookie');
    // Only the name=value pair; a client does not send the attributes back.
    return new Headers({ cookie: setCookie.split(';')[0] ?? '' });
  } finally {
    if (previous === undefined) delete process.env.MAGIC_LINK_SINK;
    else process.env.MAGIC_LINK_SINK = previous;
    // The sink held a live credential; do not leave it lying in memory.
    magicLinkSink.length = 0;
  }
}

/** Removes a test user and their sessions. Safe to call before creating them. */
export async function deleteUser(email: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    DELETE FROM session WHERE user_id IN (SELECT id FROM "user" WHERE email = ${email})`);
  await db.execute(sql`DELETE FROM "user" WHERE email = ${email}`);
}

/** Sets the role column directly; Task 3 adds the script that does this properly. */
export async function setRole(email: string, role: string): Promise<void> {
  await getDb().execute(sql`UPDATE "user" SET role = ${role} WHERE email = ${email}`);
}
