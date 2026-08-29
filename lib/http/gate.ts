import { authenticate } from './authenticate';
import { requireUser } from '../auth/session';

/**
 * Who is allowed to run a lookup, as an injectable decision.
 *
 * There are two audiences and two credentials: machine callers with API keys
 * on `/api/v1/*`, and people with session cookies in the browser. They
 * deliberately do not mix -- a session cookie gets 401 from `/api/v1/lookup`
 * and an API key gets 401 from `/api/ui/lookup` -- and each route names
 * exactly one gate, which is what keeps that true.
 *
 * The result carries no caller because `handleLookup` never reads one; it
 * branches on `ok` and returns `response`. Inventing a synthetic `Caller` for
 * the session path would add a field nothing reads and imply an API key exists
 * where none does.
 */
export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly response: Response };

export type Gate = (request: Request) => Promise<GateResult>;

/** The default: a Bearer API key, rate-limited and recorded. */
export const apiKeyGate: Gate = async (request) => {
  const auth = await authenticate(request);
  return auth.ok ? { ok: true } : { ok: false, response: auth.response };
};

/**
 * A signed-in person.
 *
 * No rate limit is charged here, unlike the key path: a human clicking a form
 * does not need throttling. The batch body is refused at the route
 * (`app/api/ui/lookup/route.ts`) instead, because this gate is shared and a
 * rate limit here would not be -- a session route that accepted batches would
 * otherwise be an unthrottled bulk endpoint through the one shared handler.
 */
export const sessionGate: Gate = async (request) => {
  const guard = await requireUser(request.headers);
  return guard.ok ? { ok: true } : { ok: false, response: guard.response };
};
