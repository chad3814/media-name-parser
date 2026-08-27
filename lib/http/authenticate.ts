import { withTransaction } from '../db/client';
import { parseBearer, touchApiKey, verifyApiKey, type Caller } from '../auth/apiKey';
import { consume } from '../auth/rateLimit';
import { rateLimited, unauthorized, unavailable } from './problem';
import { logFailure } from './log';

export type AuthResult =
  | { readonly ok: true; readonly caller: Caller }
  | { readonly ok: false; readonly response: Response };

/**
 * The one place a request becomes a caller.
 *
 * Every authenticated route calls this and nothing else, so there is a single
 * answer to "what does an unauthenticated request get" and a single place the
 * rate limit is charged. A 401 detail never quotes the header it rejected --
 * the value is a credential.
 */
export async function authenticate(request: Request): Promise<AuthResult> {
  const token = parseBearer(request.headers.get('authorization'));
  if (token === null) {
    return { ok: false, response: unauthorized('a Bearer token is required') };
  }

  try {
    const outcome = await withTransaction(async (tx) => {
      const caller = await verifyApiKey(tx, token);
      if (caller === null) return { kind: 'unknown' as const };
      const verdict = await consume(tx, caller.apiKeyId, caller.rateLimitPerMin);
      if (!verdict.allowed) {
        return { kind: 'limited' as const, retryAfterSeconds: verdict.retryAfterSeconds };
      }
      await touchApiKey(tx, caller.apiKeyId);
      return { kind: 'ok' as const, caller };
    });

    if (outcome.kind === 'unknown') {
      // Deliberately the same response as a missing token: distinguishing them
      // tells an attacker which of their guesses was a real key prefix.
      return { ok: false, response: unauthorized('the token is not valid') };
    }
    if (outcome.kind === 'limited') {
      return { ok: false, response: rateLimited(outcome.retryAfterSeconds) };
    }
    return { ok: true, caller: outcome.caller };
  } catch (error) {
    // The caller gets nothing about the cause -- it cannot act on it and the
    // detail could name internals -- but it is logged, because a 503 with no
    // corresponding log line cannot be diagnosed from outside.
    logFailure('authenticate', error);
    return { ok: false, response: unavailable('the database is unreachable') };
  }
}
