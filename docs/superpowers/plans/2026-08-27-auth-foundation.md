# Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the service real users — sign-in, sessions, an enforced admin boundary, and API keys that belong to a person rather than a placeholder row.

**Architecture:** Better Auth owns identity and its four tables (already in the schema and conformance-tested since Plan 1). This plan configures it, mounts its handler, and wraps it in three functions the rest of the app uses: `getCurrentUser`, `requireUser`, `requireAdmin`. Magic link is the primary and only testable sign-in path; GitHub is registered only when its credentials exist, so the app boots without them.

**Tech Stack:** Node 26, Next.js 16.3.3 App Router, TypeScript 7.0.2, Better Auth 1.7.1 with the `admin` and `magicLink` plugins over `better-auth/adapters/drizzle`, Drizzle 0.45.2, zod 4.4.3, oxlint 1.80.0, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`

**Plan sequence:** Plan 4 of 5. Plans 1–3 are merged: the parser, the resolution engine, and the authenticated API with its job system. **Plan 5 covers the UI** — Tailwind and shadcn setup, then the four pages (`/`, `/corpus`, `/keys`, `/admin/cache`). This plan deliberately stops at a minimal unstyled sign-in page and one guarded admin stub, because the pages need an auth boundary to sit behind and the boundary is worth reviewing on its own.

## Before you start: two things the user must supply

Neither is code, and the tasks below say where each is needed.

1. **`BETTER_AUTH_SECRET`.** Better Auth refuses to start without one. Generate it straight into the env file so the value never passes through a transcript:

   ```bash
   printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env.local
   printf 'BETTER_AUTH_URL=http://localhost:3000\n' >> .env.local
   ```

2. **GitHub OAuth credentials are optional.** `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` require registering an OAuth app, which nobody can do from here. Task 1 registers the GitHub provider **only when both are present**, so every task in this plan is completable and testable without them. Do not stub them with fake values — a fake client id produces a confusing redirect failure rather than a clean absence.

   When the app is registered, the **Authorization callback URL** is:

   ```
   http://localhost:3000/api/auth/callback/github      # local
   https://<domain>/api/auth/callback/github           # deployed
   ```

   The path is `/callback/:providerId`, **not** `/:providerId/callback` — a natural guess that fails with a redirect-URI mismatch. This was verified by having Better Auth 1.7.1 build a real authorize URL, not read from memory: `sign-in.mjs` composes `redirectURI` as `${context.baseURL}${getOAuthCallbackPath(provider)}`, and `getOAuthCallbackPath` returns `/callback/${provider.id}` while `context.baseURL` already carries the `/api/auth` base path. Task 1's catch-all route serves it; no extra file is needed.

   One practical note: the default scope Better Auth requests is `read:user user:email`, so a verified email comes back without configuration. (An earlier version of this plan claimed GitHub permits only one callback URL per OAuth app, so localhost and production needed separate apps. That is no longer true — GitHub supports multiple redirect URIs per app, so one app can carry both.)

## Global Constraints

- **Node >= 26.** ESM only. No `require`.
- **No `any`.** oxlint sets `typescript/no-explicit-any` to `error`.
- **`unknown` only at a deserialization boundary**, with a comment naming which exception it is.
- **No TypeScript enums, namespaces, or parameter properties** (`erasableSyntaxOnly: true`).
- **`exactOptionalPropertyTypes: true`.** Prefer `field: T | null` over `field?: T`.
- **`noUncheckedIndexedAccess: true`.** `array[i]` is `T | undefined`; narrow before use.
- **2-space indentation, semicolons always.** `readonly` on interface fields and array types.
- **Prefer the async form of any API.** No `*Sync` in a request path.
- **Never log a credential.** `BETTER_AUTH_SECRET`, a session token, a magic-link token, an API-key secret, and `DATABASE_URL` never reach a log line, an error body, or a test's stdout. **Never `cat` or print `.env.local`** — an agent did that earlier in this project and leaked a database password.
- **Every `catch` that produces a 5xx calls `logFailure`** from `lib/http/log.ts`.
- **Offline tests. No test reaches the network.** Magic link is testable precisely because its sender is a function you supply; use that rather than sending mail.
- **Database-backed tests skip without `DATABASE_URL`**, following the pattern from Plans 1–3.
- **Verification gate.** No task is complete until `npm run check` passes. The final task also requires `npm run build`.
- **Commit at the end of each task. Never push.**

---

## Platform facts, verified rather than assumed

Every line here was checked against the installed Better Auth 1.7.1 and the live dev branch while writing this plan. A wrong guess about any of them would reshape a task.

| Fact | Consequence |
|---|---|
| `betterAuth()` constructs successfully against our **hand-written** schema via `drizzleAdapter(db, { provider: 'pg', schema })` | No schema changes needed. Plan 1's conformance test already pins the four tables' shape. |
| `auth.api.getSession({ headers })` returns `null` for a cookie-less request and queries our tables without error | The session helper can be a thin wrapper. |
| The magic-link methods are `signInMagicLink` and **`magicLinkVerify`** | These exact names appear in Task 6's end-to-end test. |
| `signInMagicLink` **requires a `headers` option** and throws `Headers is required` without one | Easy to miss; the test passes `new Headers({'content-type':'application/json'})`. |
| `magicLinkVerify({ query: { token }, headers, asResponse: true })` returns 200 with `Set-Cookie: better-auth.session_token` and writes a real row to our `session` table | This is the whole basis of testing a signed-in request without a browser. |
| The magic-link row lands in `verification` with the **token as `identifier`** and a JSON blob including the email as `value` | Do not search `identifier` for an email address; it is not there. |
| `better-auth/next-js` exports `toNextJsHandler` and `nextCookies` | Task 1 uses `nextCookies`. `toNextJsHandler` is a five-line convenience returning the same `auth.handler` under GET/POST/PATCH/PUT/DELETE; the route writes GET and POST out by hand so the instance is not built at module load. |
| GitHub's callback path is `/api/auth/callback/github` — `/callback/:providerId`, not `/:providerId/callback` | Registered as-is on the catch-all route; the wrong guess fails with a redirect-URI mismatch. Confirmed by making 1.7.1 build an authorize URL. |
| `better-auth/plugins` exports `admin`, `magicLink`, `bearer`; `better-auth/client/plugins` exports `magicLinkClient`, `adminClient` | Task 1 and Task 4 respectively. |
| `user.role` is a **text** column, not an enum, because the admin plugin treats it as a string and supports comma-separated multiple roles | `requireAdmin` must not assume a single exact value. |

---

## Spec coverage, and the two places this plan diverges

The spec is the binding authority, so both divergences are named here rather
than discovered in review.

**1. `requireAdmin()` is built from the role column, not from
`createAccessControl`/`hasPermission`.** The spec (line 186) says the admin
plugin "also supplies `createAccessControl` and `hasPermission`, which is what
`requireAdmin()` is built from." Those are for fine-grained permission
statements — "may this role ban a user", "may it delete media" — and using
them means first declaring a statement set and a role-to-permission mapping.
This plan has exactly one question to answer, and it is a boolean: is this
person an admin. A statement set for one boolean is more machinery than the
question needs, and `userHasPermission` is a server-API round trip for a value
we already hold on the session. `lib/auth/roles.ts` is deliberately the seam
where access control would slot in later: every caller asks `hasRole`, so
replacing its body reaches all of them. **If a reviewer wants the spec's
letter here, this is the decision to overturn, and Task 2 is where.**

**2. The segment layout calls `getCurrentUser`, not `requireAdmin`.** The spec
(line 592) requires `requireAdmin()` "in **both** the segment layout and each
route handler." `requireAdmin` returns a `Response`, and a layout cannot return
one — so the layout asks the same question through `getCurrentUser` and renders
or redirects instead. The spec's actual requirement, stated in its next
sentence — "a layout check alone controls navigation, not authorization" — is
met and then exceeded: Task 5 checks in the layout, again in the page, and
again in the route handler.

**Spec requirements this plan completes:** Better Auth over its four tables in
Neon (line 65); `user.role` as text with multiple-role support (line 181);
sign-in as GitHub plus `magicLink` (line 190); `lib/auth/roles.ts` as a module
in its own right (line 101); `api_keys.user_id` as a real foreign key to a real
row (line 65), which is what Task 3 finally makes true.

**Spec requirements this plan deliberately leaves to Plan 5:** the four pages
and Tailwind/shadcn (line 581); `app/api/keys/route.ts`, the session-authed
token create/revoke endpoint (line 90); success criterion 6's "mint an API
token" through a UI rather than a CLI; and success criterion 7's `/admin/cache`
in particular — Plan 4 proves the same boundary on `/admin` and
`/api/v1/admin/whoami`, so Plan 5 inherits a mechanism rather than inventing
one.

**Beyond the spec's file list:** `lib/auth/users.ts` and `lib/auth/client.ts`
are not in the spec's `lib/auth/` sketch (line 101). Both are additions, not
substitutions: the first exists because Task 3 needs to create a user row from
a script, the second because the sign-in page needs a browser client.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/auth/server.ts` | the `betterAuth()` instance — the single source of auth configuration |
| `lib/auth/roles.ts` | the `user.role` column read and written in one place — `parseRoles`, `hasRole`, `withRole`, `withoutRole` |
| `lib/auth/session.ts` | `getCurrentUser`, `requireUser`, `requireAdmin` — the only way the app asks "who is this" |
| `lib/auth/users.ts` | user rows from outside Better Auth — `findUserIdByEmail`, `ensureUser`, `setUserRole` |
| `lib/auth/client.ts` | the browser client, with the magic-link and admin client plugins |
| `app/api/auth/[...all]/route.ts` | mounts Better Auth's own routes |
| `app/(auth)/sign-in/page.tsx` | minimal unstyled sign-in, server half — reads whether GitHub is configured |
| `app/(auth)/sign-in/sign-in-form.tsx` | the `'use client'` half; Plan 5 styles it |
| `app/(admin)/admin/layout.tsx` | the segment guard |
| `app/(admin)/admin/page.tsx` | one guarded stub proving the boundary |
| `app/api/v1/admin/whoami/route.ts` | a guarded route handler — the second half of the double check |
| `scripts/seed-api-key.ts` | **modified** — attaches a key to a real user by email |
| `scripts/promote-admin.ts` | grant or revoke the admin role |
| `test/helpers/signIn.ts` | the shared sign-in fixture — a real session cookie with no browser, mail, or network |
| `README.md` | **modified** — the two credentials, their audiences, and the env table |
| `test/auth/*.test.ts` | roles, session helpers, users, the guarded route, and the end-to-end sign-in |

Not created here: Tailwind, shadcn, `/`, `/corpus`, `/keys`, `/admin/cache`. Those are Plan 5.

---

### Task 1: The Better Auth instance and its handler

**Files:**
- Create: `lib/auth/server.ts`, `app/api/auth/[...all]/route.ts`
- Test: `test/auth/server.test.ts`

**Interfaces:**
- Consumes: `getDb` (`lib/db/client.ts`), the schema (`lib/db/schema.ts`).
- Produces:
  - `getAuth(): ReturnType<typeof buildAuth>` — the instance, memoized and built on first use. The type derives from a local `buildAuth()` because `ReturnType<typeof betterAuth>` widens to the generic default and loses the plugin surface. **Not a top-level `const`**: constructing it calls `getDb()` and reads `BETTER_AUTH_SECRET`, both of which throw when unset, so at module scope a missing variable becomes an import-time crash that makes importing tests *fail* where they must *skip*. Used by Tasks 2, 5 and 6
  - `magicLinkSink` — a module-level array the default sender pushes into when `MAGIC_LINK_SINK` is set, so a local dev or a test can read the token without email
  - `githubConfigured(): boolean`

**On the magic-link sender.** Better Auth calls a function you supply; there is no built-in mailer. That is what makes the whole flow testable offline. Rather than a test-only branch inside production code, the sender writes to `magicLinkSink` **only when `MAGIC_LINK_SINK=1`**, and otherwise logs that no mailer is configured. Sending real mail is a Plan 5 concern at the earliest, and probably a separate provider decision.

- [ ] **Step 1: Write the failing test**

`test/auth/server.test.ts`. **Any test that calls `getAuth()` is database-backed and carries `opts`** — constructing the instance calls `getDb()`. That leaves exactly two ungated tests: `githubConfigured`, which reads only `process.env`, and the import test, which never calls `getAuth()`. With `DATABASE_URL` unset this file must report 2 passing and 4 skipped, never a failure.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAuth, githubConfigured, magicLinkSink } from '../../lib/auth/server';

const run = promisify(execFile);

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

test('the instance exposes the api surface the app depends on', opts, async () => {
  for (const method of ['getSession', 'signInMagicLink', 'magicLinkVerify']) {
    assert.ok(method in getAuth().api, `auth.api.${method} is missing`);
  }
});

test('githubConfigured requires both credentials, not either', () => {
  // Asserting concrete outcomes rather than recomputing the implementation's
  // own expression. Both variables are set in development, so a test that
  // compared `githubConfigured()` against `id && secret` would still pass with
  // `&&` changed to `||`. The values here are placeholders, not credentials --
  // only their presence is read.
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
    // A later test in this file constructs the instance; leaving these cleared
    // would change how it is built.
    restore('GITHUB_CLIENT_ID', id);
    restore('GITHUB_CLIENT_SECRET', secret);
  }
});

test('the module imports with no DATABASE_URL and no secret', async () => {
  // The regression guard for the eager form of this module, which threw at
  // import and so made every test in an importing file fail rather than skip.
  // A child process is the only way to assert it from a suite whose own
  // environment has the variables set.
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
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/server.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/server`.

- [ ] **Step 3: Write `lib/auth/server.ts`**

```ts
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

/**
 * The Better Auth instance, built on first use.
 *
 * Not a top-level `const`: constructing it calls `getDb()` and reads
 * `BETTER_AUTH_SECRET`, and both throw when unset. At module scope that turns a
 * missing variable into an import-time crash -- `lib/db/client.ts` makes the
 * same argument for `getDb()` itself, and the cost here is concrete. With
 * `DATABASE_URL` unset, every test in a file importing this module fails
 * instead of skipping, and `next build` fails pointing at the wrong thing.
 *
 * `buildAuth` is a named function rather than an inline `betterAuth({...})` so
 * its return type is the concrete type TypeScript infers from this literal
 * config. `ReturnType<typeof betterAuth>` widens to the generic
 * `Auth<BetterAuthOptions>` default, which drops `signInMagicLink` from `.api`
 * and, under `exactOptionalPropertyTypes`, is mutually unassignable with the
 * literal type in both directions. Verified with a `tsc` probe, not assumed.
 */
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

export function getAuth(): ReturnType<typeof buildAuth> {
  if (instance === null) {
    instance = buildAuth();
  }
  return instance;
}
```

- [ ] **Step 4: Mount the handler**

`app/api/auth/[...all]/route.ts`:

```ts
import { getAuth } from '../../../../lib/auth/server';

/**
 * Better Auth's own routes: sign-in, callback, sign-out, session.
 *
 * The catch-all segment is `[...all]` rather than `[...nextauth]` -- this is
 * Better Auth, not the Auth.js it replaced, and the name is part of its
 * documented contract.
 */
export async function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
```

- [ ] **Step 5: Add the env template entries**

`.env.example` already names `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (Plan 3 corrected them). Add the one new switch:

```
MAGIC_LINK_SINK=
```

with a comment above it in the file explaining that setting it to `1` captures magic-link tokens in memory for local development instead of sending mail.

- [ ] **Step 6: Run the tests**

```bash
npm run test -- test/auth/server.test.ts
```

Expected: 5 passing. Diagnostics:

- `BETTER_AUTH_SECRET is not set` — do the generate step from the top of this plan. It is the one prerequisite with no code workaround.
- `Headers is required` — `signInMagicLink` needs a `headers` option even when nothing in the headers matters. Verified behaviour, not a guess.
- If `githubConfigured()` is true but you did not set the variables, something else in the environment is setting them; check before assuming the function is wrong.

- [ ] **Step 7: Verify and commit**

```bash
npm run check
git add lib/auth/server.ts app/api/auth test/auth/server.test.ts .env.example
git commit -m "Configure Better Auth over the existing schema

No schema changes: the four tables have been in place and
conformance-tested since plan 1, and drizzleAdapter accepts them as
written.

Passwords are off. The service has no reset flow, no rotation policy and
no appetite for storing hashes, so magic link and OAuth cover it.

GitHub is registered only when both credentials are present. A fake
client id produces a confusing redirect failure at sign-in rather than a
clean absence, so the provider is not offered until it can work -- which
also means every task in this plan is testable without it.

The magic-link sender captures tokens in memory only when
MAGIC_LINK_SINK=1. Better Auth ships no mailer and calls a function you
supply, which is what makes the flow testable offline; gating on an
explicit variable rather than a 'am I in a test' guess keeps production
from accumulating live tokens."
```

---
### Task 2: Roles, session helpers, and the admin guard

**Files:**
- Create: `lib/auth/roles.ts`, `lib/auth/session.ts`, `test/helpers/signIn.ts`
- Test: `test/auth/roles.test.ts`, `test/auth/session.test.ts`

**Interfaces:**
- Consumes: `getAuth` (Task 1 — **a function, not a `const auth`**), `unauthorized`/`forbidden`/`unavailable` (`lib/http/problem.ts`), `logFailure` (`lib/http/log.ts`).
- Produces, from `lib/auth/roles.ts`:
  - `ADMIN_ROLE: 'admin'`
  - `parseRoles(role: string | null | undefined): readonly string[]`
  - `hasRole(role: string | null | undefined, wanted: string): boolean`
  - `withRole(role: string | null | undefined, wanted: string): string`
  - `withoutRole(role: string | null | undefined, unwanted: string): string`
- Produces, from `lib/auth/session.ts`:
  - `interface CurrentUser { readonly id: string; readonly email: string; readonly name: string; readonly roles: readonly string[]; readonly isAdmin: boolean }`
  - `getCurrentUser(headers: Headers): Promise<CurrentUser | null>`
  - `type Guard<T> = { readonly ok: true; readonly user: T } | { readonly ok: false; readonly response: Response }`
  - `requireUser(headers: Headers): Promise<Guard<CurrentUser>>`
  - `requireAdmin(headers: Headers): Promise<Guard<CurrentUser>>`
- Produces, from `test/helpers/signIn.ts` — used by this task's tests and again by Task 5:
  - `signIn(email: string): Promise<Headers>` — headers carrying a real session cookie
  - `deleteUser(email: string): Promise<void>`
  - `setRole(email: string, role: string): Promise<void>`

**Why roles get their own file.** `user.role` is a **text** column, not a Postgres enum, because the admin plugin treats it as a string and supports comma-separated multiple roles. Two different pieces of code need to agree about what that string means: the guard, which reads it, and Task 3's `promote-admin` script, which writes it. Put the reading in one file and the writing in another and they will eventually disagree — a script that writes `"admin"` over an existing `"support"` silently strips a role. One module, four functions, pure, and fully testable without a database.

The two mistakes this module exists to prevent:
- `role === 'admin'` refuses a legitimate admin whose row reads `support,admin`.
- `role.includes('admin')` admits `administrator-readonly`.

**Why a 403 and not a 404.** A signed-in non-admin gets `403`. There is an argument for `404` — not revealing that the route exists — but the route's existence is not a secret worth protecting here, and a `403` tells an honest user with the wrong role something true and actionable, where a `404` sends them hunting for a typo.

- [ ] **Step 1: Write the failing role test**

`test/auth/roles.test.ts` — no database, so these run everywhere:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_ROLE, parseRoles, hasRole, withRole, withoutRole,
} from '../../lib/auth/roles';

test('parseRoles splits a comma-separated column and trims each entry', () => {
  assert.deepEqual(parseRoles('admin'), ['admin']);
  assert.deepEqual(parseRoles('support,admin'), ['support', 'admin']);
  assert.deepEqual(parseRoles(' admin , support '), ['admin', 'support']);
});

test('parseRoles yields an empty list for absent or empty input', () => {
  assert.deepEqual(parseRoles(null), []);
  assert.deepEqual(parseRoles(undefined), []);
  assert.deepEqual(parseRoles(''), []);
  assert.deepEqual(parseRoles(',,  ,'), []);
});

test('hasRole matches a whole entry, never a substring', () => {
  // The two bugs this module exists to prevent, as assertions.
  assert.equal(hasRole('support,admin', ADMIN_ROLE), true, 'multi-role admin must pass');
  assert.equal(hasRole('administrator-readonly', ADMIN_ROLE), false, 'substring must not pass');
  assert.equal(hasRole('adminx', ADMIN_ROLE), false);
  assert.equal(hasRole('user', ADMIN_ROLE), false);
});

test('withRole appends without disturbing existing roles', () => {
  assert.equal(withRole('support', ADMIN_ROLE), 'support,admin');
  assert.equal(withRole('user', ADMIN_ROLE), 'user,admin');
});

test('withRole is idempotent', () => {
  assert.equal(withRole('support,admin', ADMIN_ROLE), 'support,admin');
  assert.equal(withRole('admin', ADMIN_ROLE), 'admin');
});

test('withRole on an empty column yields just the role', () => {
  assert.equal(withRole(null, ADMIN_ROLE), 'admin');
  assert.equal(withRole('', ADMIN_ROLE), 'admin');
});

test('withoutRole removes only the named role', () => {
  assert.equal(withoutRole('support,admin', ADMIN_ROLE), 'support');
  assert.equal(withoutRole('admin,support', ADMIN_ROLE), 'support');
});

test('withoutRole is idempotent', () => {
  assert.equal(withoutRole('support', ADMIN_ROLE), 'support');
});

test('removing the last role falls back to user, never an empty string', () => {
  // The column is NOT NULL DEFAULT 'user'. Writing '' would satisfy the
  // constraint while meaning something no other code understands.
  assert.equal(withoutRole('admin', ADMIN_ROLE), 'user');
  assert.equal(withoutRole(null, ADMIN_ROLE), 'user');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/roles.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/roles`.

- [ ] **Step 3: Write `lib/auth/roles.ts`**

```ts
/**
 * The `user.role` column, read and written in one place.
 *
 * The column is text rather than an enum because the admin plugin treats it as
 * a string and supports comma-separated multiple roles. Two callers need to
 * agree about what that string means -- the guard that reads it and the
 * promote-admin script that writes it -- and a script that wrote `"admin"`
 * over an existing `"support"` would silently strip a role.
 *
 * Comparing `role === 'admin'` would refuse a legitimate admin reading
 * `support,admin`; `role.includes('admin')` would admit
 * `administrator-readonly`. Splitting on commas and matching whole entries is
 * the only reading that gets both right.
 */

export const ADMIN_ROLE = 'admin';

/** The role the column defaults to, and what it falls back to when emptied. */
const DEFAULT_ROLE = 'user';

export function parseRoles(role: string | null | undefined): readonly string[] {
  if (role === null || role === undefined) return [];
  return role.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

export function hasRole(role: string | null | undefined, wanted: string): boolean {
  return parseRoles(role).includes(wanted);
}

export function withRole(role: string | null | undefined, wanted: string): string {
  const roles = parseRoles(role);
  if (roles.includes(wanted)) return roles.join(',');
  return [...roles, wanted].join(',');
}

export function withoutRole(role: string | null | undefined, unwanted: string): string {
  const remaining = parseRoles(role).filter((entry) => entry !== unwanted);
  // Never '': the column is NOT NULL DEFAULT 'user', so an empty string would
  // satisfy the constraint while meaning something no other code understands.
  return remaining.length === 0 ? DEFAULT_ROLE : remaining.join(',');
}
```

- [ ] **Step 4: Run the role tests**

```bash
npm run test -- test/auth/roles.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Write the shared test helper**

`test/helpers/signIn.ts`. This is the reason Task 1's magic-link sink exists: it produces a real session cookie with no browser, no mail, and no network. Task 5's tests import the same three functions, which is why it is a file rather than a local function — two copies of a sign-in helper is two places for a session fixture to drift.

```ts
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
```

- [ ] **Step 6: Write the failing session test**

`test/auth/session.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { getCurrentUser, requireUser, requireAdmin } from '../../lib/auth/session';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { signIn, deleteUser as cleanup, setRole } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

test('no cookie means no current user', opts, async () => {
  assert.equal(await getCurrentUser(new Headers()), null);
});

test('a signed-in user is returned with their email and no admin role', opts, async () => {
  const email = 'sess-plain@example.test';
  await cleanup(email);
  const user = await getCurrentUser(await signIn(email));
  assert.ok(user !== null);
  assert.equal(user.email, email);
  assert.equal(user.isAdmin, false);
  // A magic-link user starts on the column default.
  assert.deepEqual(user.roles, ['user']);
  await cleanup(email);
});

test('requireUser refuses a cookie-less request with 401 and the scheme', opts, async () => {
  const guard = await requireUser(new Headers());
  assert.equal(guard.ok, false);
  if (guard.ok) throw new Error('unreachable');
  assert.equal(guard.response.status, 401);
  assert.equal(guard.response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(guard.response.headers.get('content-type'), 'application/problem+json');
});

test('requireUser admits a signed-in user', opts, async () => {
  const email = 'sess-admit@example.test';
  await cleanup(email);
  const guard = await requireUser(await signIn(email));
  assert.equal(guard.ok, true);
  if (!guard.ok) throw new Error('unreachable');
  assert.equal(guard.user.email, email);
  await cleanup(email);
});

test('requireAdmin refuses a signed-in non-admin with 403, not 401', opts, async () => {
  // 401 would say "authenticate"; they already did. 403 is the truth.
  const email = 'sess-nonadmin@example.test';
  await cleanup(email);
  const guard = await requireAdmin(await signIn(email));
  assert.equal(guard.ok, false);
  if (guard.ok) throw new Error('unreachable');
  assert.equal(guard.response.status, 403);
  await cleanup(email);
});

test('requireAdmin admits an admin', opts, async () => {
  const email = 'sess-admin@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, ADMIN_ROLE);
  const guard = await requireAdmin(headers);
  assert.equal(guard.ok, true);
  if (!guard.ok) throw new Error('unreachable');
  assert.equal(guard.user.isAdmin, true);
  await cleanup(email);
});

test('requireAdmin admits a user with several comma-separated roles', opts, async () => {
  const email = 'sess-multi@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, 'support,admin');
  const guard = await requireAdmin(headers);
  assert.equal(guard.ok, true);
  if (!guard.ok) throw new Error('unreachable');
  assert.deepEqual([...guard.user.roles].sort(), ['admin', 'support']);
  await cleanup(email);
});

test('a role that merely contains the word admin is not admin', opts, async () => {
  const email = 'sess-nearly@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, 'administrator-readonly');
  const guard = await requireAdmin(headers);
  assert.equal(guard.ok, false);
  await cleanup(email);
});
```

- [ ] **Step 7: Run it and confirm it fails**

```bash
npm run test -- test/auth/session.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/session`.

- [ ] **Step 8: Write `lib/auth/session.ts`**

```ts
import { getAuth } from './server';
import { hasRole, parseRoles, ADMIN_ROLE } from './roles';
import { forbidden, unauthorized, unavailable } from '../http/problem';
import { logFailure } from '../http/log';

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly isAdmin: boolean;
}

export type Guard<T> =
  | { readonly ok: true; readonly user: T }
  | { readonly ok: false; readonly response: Response };

export async function getCurrentUser(headers: Headers): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({ headers });
  if (session === null) return null;
  // `role` is contributed by the admin plugin, so it is absent from Better
  // Auth's base user type. Reading it through a narrow record type is the
  // deserialization exception: the value is a database column, not app state.
  const withRoleColumn = session.user as unknown as { readonly role?: string | null };
  const role = withRoleColumn.role ?? null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    roles: parseRoles(role),
    isAdmin: hasRole(role, ADMIN_ROLE),
  };
}

export async function requireUser(headers: Headers): Promise<Guard<CurrentUser>> {
  try {
    const user = await getCurrentUser(headers);
    if (user === null) return { ok: false, response: unauthorized('sign in to continue') };
    return { ok: true, user };
  } catch (error) {
    // A 5xx with no corresponding log line cannot be diagnosed from outside.
    logFailure('requireUser', error);
    return { ok: false, response: unavailable('the session could not be read') };
  }
}

/**
 * Admin or a refusal.
 *
 * A signed-in non-admin gets 403, not 401: they authenticated successfully and
 * telling them to authenticate again is a lie. 404 was considered -- not
 * revealing the route exists -- and rejected, because the route's existence is
 * not a secret worth protecting and 403 tells an honest user with the wrong
 * role something actionable.
 */
export async function requireAdmin(headers: Headers): Promise<Guard<CurrentUser>> {
  const guard = await requireUser(headers);
  if (!guard.ok) return guard;
  if (!guard.user.isAdmin) {
    return { ok: false, response: forbidden('this area requires the admin role') };
  }
  return guard;
}
```

- [ ] **Step 9: Run the tests**

```bash
npm run test -- test/auth/session.test.ts
```

Expected: 8 passing. Diagnostics:

- `no magic link was captured` — `MAGIC_LINK_SINK` is not reaching the sender. It is read at call time inside `sendMagicLink`, so setting it in the test is enough; check the spelling of the variable.
- `verification issued no session cookie` — `magicLinkVerify` was called without `asResponse: true`.
- The multi-role test failing means `parseRoles` is not being used. That test exists to stop the check being "simplified" into an equality comparison.

- [ ] **Step 10: Commit**

```bash
npm run check
git add lib/auth/roles.ts lib/auth/session.ts test/helpers/signIn.ts \
        test/auth/roles.test.ts test/auth/session.test.ts
git commit -m "Add role parsing, session helpers, and the admin guard

Roles get their own module because two callers must agree about what
user.role means: the guard that reads it and Plan 4 Task 3's script that
writes it. A writer that put 'admin' over an existing 'support' would
silently strip a role.

The column is text, not an enum, because the admin plugin supports
comma-separated multiple roles. role === 'admin' would refuse a
legitimate admin reading 'support,admin', and role.includes('admin')
would admit 'administrator-readonly'. There is a test for each, and
withoutRole falls back to 'user' rather than writing an empty string
that satisfies NOT NULL while meaning nothing.

A signed-in non-admin gets 403, not 401: they authenticated
successfully, and telling them to authenticate again is a lie.

The session tests sign a user in through the magic-link sink and read
the Set-Cookie off magicLinkVerify, so a signed-in request is testable
with no browser, no mail and no network."
```

---

### Task 3: API keys that belong to a real user

**Files:**
- Create: `lib/auth/users.ts`, `scripts/promote-admin.ts`
- Modify: `scripts/seed-api-key.ts` (replace the whole file — it currently invents a `local-dev` user), `package.json` (one script entry)
- Test: `test/auth/users.test.ts`

**Interfaces:**
- Consumes: `Tx` (`lib/db/client.ts`), `withTransaction`, `closeDb`, `mintApiKey` (`lib/auth/apiKey.ts`), `parseRoles`/`hasRole`/`withRole`/`withoutRole`/`ADMIN_ROLE` (Task 2).
- Produces:
  - `findUserIdByEmail(tx: Tx, email: string): Promise<string | null>`
  - `ensureUser(tx: Tx, email: string, name?: string): Promise<{ readonly id: string; readonly created: boolean }>`
  - `setUserRole(tx: Tx, email: string, role: string): Promise<boolean>` — false when no such user

**The debt this pays off.** `scripts/seed-api-key.ts` currently inserts a hardcoded user row with the literal id `local-dev` and a comment saying "until Plan 4 wires sign-in up there is no real user to attach a key to". Sign-in now exists, so the placeholder goes. It is not merely untidy: a real magic-link sign-in with the same email would collide on `user.email`'s unique constraint and fail with a database error rather than anything a person could act on.

**The dev database currently holds exactly one user row, `local-dev` / `dev@localhost`.** Step 7 repoints its keys and deletes it. Do not skip that step and do not widen it — deleting any other user row is out of scope for this task.

**Why `ensureUser` creates rather than requiring an existing user.** Better Auth generates its own string ids, and nothing stops us generating one too: the column is `text`, and a `crypto.randomUUID()` is as valid as its own. Requiring the user to sign in through a browser before a key can be minted would make the seed script depend on a running dev server, which defeats the point of a seed script. A user created this way has `email_verified = false` and no `account` row; signing in with a magic link to the same address later finds the existing row by email and attaches a session to it.

- [ ] **Step 1: Write the failing test**

`test/auth/users.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { ensureUser, findUserIdByEmail, setUserRole } from '../../lib/auth/users';
import { ADMIN_ROLE, hasRole, withRole, withoutRole } from '../../lib/auth/roles';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

async function cleanup(email: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM "user" WHERE email = ${email}`);
}

async function readRole(email: string): Promise<string | null> {
  const result = await getDb().execute(sql`SELECT role FROM "user" WHERE email = ${email}`);
  const row = result.rows[0];
  return row === undefined ? null : String(row.role);
}

test('findUserIdByEmail returns null for an unknown address', opts, async () => {
  const id = await withTransaction((tx) => findUserIdByEmail(tx, 'nobody-here@example.test'));
  assert.equal(id, null);
});

test('ensureUser creates a user with a generated id and reports it', opts, async () => {
  const email = 'users-create@example.test';
  await cleanup(email);
  const result = await withTransaction((tx) => ensureUser(tx, email));
  assert.equal(result.created, true);
  // Not the old hardcoded placeholder, and long enough to be a real uuid.
  assert.notEqual(result.id, 'local-dev');
  assert.ok(result.id.length >= 32, `id looks wrong: ${result.id.length} chars`);
  assert.equal(await readRole(email), 'user');
  await cleanup(email);
});

test('ensureUser is idempotent and returns the same id', opts, async () => {
  const email = 'users-idempotent@example.test';
  await cleanup(email);
  const first = await withTransaction((tx) => ensureUser(tx, email));
  const second = await withTransaction((tx) => ensureUser(tx, email));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  await cleanup(email);
});

test('ensureUser derives a name from the address when none is given', opts, async () => {
  const email = 'users-named@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email));
  const result = await getDb().execute(sql`SELECT name FROM "user" WHERE email = ${email}`);
  assert.equal(String(result.rows[0]?.name), 'users-named');
  await cleanup(email);
});

test('ensureUser does not overwrite the name of an existing user', opts, async () => {
  const email = 'users-keepname@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email, 'Original Name'));
  await withTransaction((tx) => ensureUser(tx, email, 'Replacement'));
  const result = await getDb().execute(sql`SELECT name FROM "user" WHERE email = ${email}`);
  assert.equal(String(result.rows[0]?.name), 'Original Name');
  await cleanup(email);
});

test('findUserIdByEmail finds a created user', opts, async () => {
  const email = 'users-find@example.test';
  await cleanup(email);
  const created = await withTransaction((tx) => ensureUser(tx, email));
  const found = await withTransaction((tx) => findUserIdByEmail(tx, email));
  assert.equal(found, created.id);
  await cleanup(email);
});

test('setUserRole writes the role and reports success', opts, async () => {
  const email = 'users-role@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email));
  const ok = await withTransaction((tx) => setUserRole(tx, email, withRole('user', ADMIN_ROLE)));
  assert.equal(ok, true);
  const role = await readRole(email);
  assert.equal(hasRole(role, ADMIN_ROLE), true);
  // The existing role survived: this is the strip-a-role bug, as an assertion.
  assert.equal(hasRole(role, 'user'), true);
  await cleanup(email);
});

test('setUserRole can take the admin role away again', opts, async () => {
  const email = 'users-demote@example.test';
  await cleanup(email);
  await withTransaction((tx) => ensureUser(tx, email));
  await withTransaction((tx) => setUserRole(tx, email, 'support,admin'));
  await withTransaction(async (tx) => {
    const role = await readRole(email);
    return setUserRole(tx, email, withoutRole(role, ADMIN_ROLE));
  });
  assert.equal(await readRole(email), 'support');
  await cleanup(email);
});

test('setUserRole reports failure for an unknown address', opts, async () => {
  const ok = await withTransaction((tx) => setUserRole(tx, 'nobody-here@example.test', 'admin'));
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/users.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/users`.

- [ ] **Step 3: Write `lib/auth/users.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/**
 * User rows, from outside Better Auth.
 *
 * Better Auth owns the `user` table and generates its own string ids, but the
 * column is `text` and nothing makes its ids special -- a randomUUID is just
 * as valid. That matters because a seed script must be able to attach an API
 * key to a person without a browser and a running dev server. A user created
 * here has `email_verified = false` and no `account` row; a later magic-link
 * sign-in to the same address finds this row by email and attaches a session.
 */

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.length === 0 ? email : local;
}

export async function findUserIdByEmail(tx: Tx, email: string): Promise<string | null> {
  const result = await tx.execute(sql`SELECT id FROM "user" WHERE email = ${email}`);
  const row = result.rows[0];
  return row === undefined ? null : String(row.id);
}

export async function ensureUser(
  tx: Tx,
  email: string,
  name?: string,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const id = crypto.randomUUID();
  // DO NOTHING rather than DO UPDATE: an existing user's name is theirs, and a
  // seed script's guess at it is worse than what is already stored.
  const inserted = await tx.execute(sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES (${id}, ${name ?? nameFromEmail(email)}, ${email}, false)
    ON CONFLICT (email) DO NOTHING
    RETURNING id`);
  const row = inserted.rows[0];
  if (row !== undefined) return { id: String(row.id), created: true };

  const existing = await findUserIdByEmail(tx, email);
  if (existing === null) {
    // The insert was skipped and the row is not there: something else deleted
    // it between the two statements. Surfacing this beats returning a
    // fabricated id that no row uses.
    throw new Error(`the user row for ${email} vanished mid-transaction`);
  }
  return { id: existing, created: false };
}

/** Writes the role column verbatim. Compose the value with `lib/auth/roles.ts`. */
export async function setUserRole(tx: Tx, email: string, role: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE "user" SET role = ${role}, updated_at = now() WHERE email = ${email} RETURNING id`);
  return result.rows.length > 0;
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/auth/users.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Replace `scripts/seed-api-key.ts`**

Write the file in full — the placeholder-user block goes away entirely:

```ts
import { closeDb, withTransaction } from '../lib/db/client';
import { sql } from 'drizzle-orm';
import { mintApiKey } from '../lib/auth/apiKey';
import { ensureUser } from '../lib/auth/users';

const email = process.argv[2] ?? '';
const label = process.argv[3] ?? 'local development';

if (email.length === 0 || !email.includes('@')) {
  process.stderr.write('usage: npm run seed:key -- <email> [label]\n');
  process.exit(1);
}

const minted = await mintApiKey();

const owner = await withTransaction(async (tx) => {
  const user = await ensureUser(tx, email);
  await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES (${user.id}, ${label}, ${minted.tokenHash}, ${minted.prefix})`);
  return user;
});
await closeDb();

// The secret is printed exactly once, here, and is not recoverable afterwards.
// It goes to stdout so it can be redirected straight into a file or a variable
// without appearing in a log; everything else goes to stderr.
process.stdout.write(`${minted.token}\n`);
process.stderr.write(
  `\nstored key ${minted.prefix} ('${label}') for ${email}` +
  `${owner.created ? ' (new user)' : ''}. The token above is shown once.\n`,
);
```

The email is now a required first argument rather than an optional third one. That is a deliberate breaking change to a dev script: a key must belong to somebody, and defaulting the owner is how the `local-dev` placeholder came to exist.

- [ ] **Step 6: Write `scripts/promote-admin.ts`**

```ts
import { closeDb, withTransaction } from '../lib/db/client';
import { sql } from 'drizzle-orm';
import { setUserRole } from '../lib/auth/users';
import { ADMIN_ROLE, hasRole, withRole, withoutRole } from '../lib/auth/roles';

const email = process.argv[2] ?? '';
const revoke = process.argv.includes('--revoke');

if (email.length === 0 || !email.includes('@')) {
  process.stderr.write('usage: npm run admin:promote -- <email> [--revoke]\n');
  process.exit(1);
}

const outcome = await withTransaction(async (tx) => {
  // Read and write in one transaction: two concurrent runs would otherwise
  // read the same role and the second write would discard the first.
  const result = await tx.execute(sql`
    SELECT role FROM "user" WHERE email = ${email} FOR UPDATE`);
  const row = result.rows[0];
  if (row === undefined) return { found: false as const };
  const before = String(row.role);
  const after = revoke ? withoutRole(before, ADMIN_ROLE) : withRole(before, ADMIN_ROLE);
  if (after !== before) await setUserRole(tx, email, after);
  return { found: true as const, before, after };
});
await closeDb();

if (!outcome.found) {
  process.stderr.write(`no user with email ${email}. Sign in once, or run 'npm run seed:key'.\n`);
  process.exit(1);
}
process.stderr.write(
  `${email}: ${outcome.before} -> ${outcome.after}` +
  `${outcome.before === outcome.after ? ' (already correct)' : ''}\n` +
  `admin: ${hasRole(outcome.after, ADMIN_ROLE) ? 'yes' : 'no'}\n`,
);
```

`FOR UPDATE` is the point of interest: promote reads the current role and writes a modified copy, so without the row lock two concurrent runs would each read `user` and the second would discard the first's addition.

- [ ] **Step 7: Add the npm script and retire the `local-dev` row**

In `package.json`, beside `"seed:key"`:

```json
    "admin:promote": "node --env-file=.env.local --import tsx scripts/promote-admin.ts"
```

Then repoint the existing placeholder's keys and delete it. The dev database has exactly one user row, `local-dev`; this is a one-time cleanup, not code:

```bash
node --env-file=.env.local --import tsx -e "
import { getDb, closeDb, withTransaction } from './lib/db/client';
import { sql } from 'drizzle-orm';
import { ensureUser } from './lib/auth/users';
await withTransaction(async (tx) => {
  const result = await tx.execute(sql\`SELECT id FROM \"user\" WHERE id = 'local-dev'\`);
  if (result.rows.length === 0) { process.stderr.write('no local-dev row; nothing to do\n'); return; }
  const owner = await ensureUser(tx, 'dev@example.test', 'Local Development');
  const moved = await tx.execute(sql\`
    UPDATE api_keys SET user_id = \${owner.id} WHERE user_id = 'local-dev' RETURNING id\`);
  await tx.execute(sql\`DELETE FROM \"user\" WHERE id = 'local-dev'\`);
  process.stderr.write(\`moved \${moved.rows.length} key(s) to \${owner.id}, removed local-dev\n\`);
});
await closeDb();
"
```

The keys are repointed before the delete rather than being allowed to cascade: `api_keys.user_id` has `ON DELETE CASCADE`, so deleting the row first would silently destroy every existing dev key.

- [ ] **Step 8: Verify the scripts against the dev database**

```bash
npm run seed:key -- plan4-check@example.test 'plan 4 verification' > /dev/null
npm run admin:promote -- plan4-check@example.test
npm run admin:promote -- plan4-check@example.test          # idempotent
npm run admin:promote -- plan4-check@example.test --revoke
npm run admin:promote -- nobody-here@example.test          # must exit 1
```

Expected on stderr, in order: `user -> user,admin`, then `user,admin -> user,admin (already correct)`, then `user,admin -> user`, then `no user with email nobody-here@example.test` with exit status 1. The seed key's secret is discarded to `/dev/null` on purpose — it is a credential, and nothing here needs it.

Then remove the check user:

```bash
node --env-file=.env.local --import tsx -e "
import { getDb, closeDb } from './lib/db/client';
import { sql } from 'drizzle-orm';
await getDb().execute(sql\`DELETE FROM \"user\" WHERE email = 'plan4-check@example.test'\`);
await closeDb();
"
```

- [ ] **Step 9: Commit**

```bash
npm run check
git add lib/auth/users.ts scripts/seed-api-key.ts scripts/promote-admin.ts \
        package.json test/auth/users.test.ts
git commit -m "Attach API keys to real users and add promote-admin

seed-api-key invented a user row with the literal id 'local-dev'
because sign-in did not exist yet. It does now, so the placeholder is
gone: the email is a required first argument, because a key must belong
to somebody and defaulting the owner is how the placeholder came to
exist in the first place.

The placeholder was not merely untidy. A real magic-link sign-in with
the same address would have collided on user.email's unique constraint
and failed with a database error rather than anything a person could
act on.

ensureUser generates its own uuid rather than requiring a prior browser
sign-in: user.id is text, Better Auth's ids are not special, and making
a seed script depend on a running dev server defeats the point of a
seed script. ON CONFLICT DO NOTHING rather than DO UPDATE, because an
existing user's name is theirs and a script's guess is worse.

promote-admin reads and writes the role inside one transaction with FOR
UPDATE: it writes a modified copy of what it read, so two concurrent
runs would otherwise have the second discard the first.

The one-time cleanup repoints existing keys before deleting the
local-dev row -- api_keys.user_id cascades, so deleting first would
have destroyed every dev key."
```

---

### Task 4: The browser client and a sign-in page

**Files:**
- Create: `lib/auth/client.ts`, `app/(auth)/sign-in/page.tsx`, `app/(auth)/sign-in/sign-in-form.tsx`
- Test: `test/auth/client.test.ts`

**Interfaces:**
- Consumes: `githubConfigured` (Task 1).
- Produces:
  - `authClient` — the `createAuthClient` result, with the magic-link and admin client plugins
  - `signIn`, `signOut`, `useSession` — destructured from `authClient` for the components to use

**Unstyled on purpose.** Plan 5 brings Tailwind and shadcn. A styled page written now would be rewritten then, so this is a plain form with a `<p>` for its status. It works, it is reachable, and it is the smallest thing that proves the client talks to the server.

**Why the page splits into two files.** The GitHub button must appear only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are both set, and that is server-side knowledge — a client component cannot read them, and it must not, since one of them is a secret. So `page.tsx` is a server component that calls `githubConfigured()` and passes the answer as a boolean prop to `sign-in-form.tsx`, which is the `'use client'` half. The boolean crosses the boundary; neither credential does.

**What is and is not tested here.** There is no React test renderer in this project and adding one for two components is not worth it. The components are covered by `npm run build`, which type-checks them and fails on a server/client boundary violation. Task 6's end-to-end test covers the flow itself.

**What guards a dropped plugin, corrected after review.** An earlier draft of this task claimed `test/auth/client.test.ts` catches a missing plugin because `signIn.magicLink` would be "silently undefined". **That is false**, and it survived one round of my own checking because I only ever ran the assertion with both plugins registered. Better Auth's client is a dynamic path proxy (`createDynamicPathProxy`): every property path resolves to a callable function, so on a client built with *no plugins at all*, `nonsense.madeUpPath` is also a function. `magicLinkClient()` is types-only — its entire body is `{ id, version, $InferServerPlugin: {} }` — so there is no runtime trace of it to assert.

The real guard is `npm run typecheck`. Removing `magicLinkClient()` makes `authClient.signIn.magicLink` a `TS2339` error — "Property 'magicLink' does not exist" — in both the test and `sign-in-form.tsx`, which calls it in a type-checked position. Verified with a `tsc` probe against this project's own tsconfig, not assumed.

So the runtime test earns its place a different way: it drives the client through a fake `fetch` (`customFetchImpl`, no network) and pins the request path, method and body, because that path is the contract with the route Task 1 mounted. The measured call is `POST http://…/api/auth/sign-in/magic-link` with body `{"email":…,"callbackURL":…}`.

**To be explicit, so nobody derives this a third time:** the behavioural tests are *also* not plugin-discriminating. A re-review ran them against a bare `createAuthClient({})` and they passed identically, because `createDynamicPathProxy` derives the path and method purely from the property-access chain and never consults the plugin array. **No runtime test can distinguish a registered `magicLinkClient()` from a missing one**, because the plugin has no runtime existence. What the behavioural tests do cover is the request-construction contract — path derivation, method inference, response parsing — which would catch a renamed call or a library change to how paths are built. Plugin registration is the type checker's job, and that guard was confirmed load-bearing by direct mutation: removing `magicLinkClient()` produces `TS2339` in `app/(auth)/sign-in/sign-in-form.tsx` and in three places in the test.

- [ ] **Step 1: Write the failing test**

`test/auth/client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authClient } from '../../lib/auth/client';

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

// The guard against a dropped plugin is `npm run typecheck`, not a runtime
// assertion: removing magicLinkClient() from lib/auth/client.ts makes
// `authClient.signIn.magicLink` a TS2339 error ("Property 'magicLink' does not
// exist"), both here and in sign-in-form.tsx. Verified with a tsc probe.
const magicLinkIsTypedOnTheClient: typeof authClient.signIn.magicLink = authClient.signIn.magicLink;
void magicLinkIsTypedOnTheClient;

test('signIn.magicLink posts the address to the magic-link route', async () => {
  // `typeof signIn.magicLink === 'function'` is true even on a client with no
  // plugins at all -- the client is a dynamic path proxy -- so asserting that
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
  // Note the shape: signOut nests its options under `fetchOptions`, where
  // signIn.magicLink takes them as a bare second argument. Measured, not
  // assumed -- the two differ.
  const seen: SeenRequest[] = [];
  await authClient.signOut({
    fetchOptions: { baseURL: 'http://localhost:3000/api/auth', customFetchImpl: recorder(seen) },
  });
  const call = seen[0];
  assert.ok(call !== undefined, 'no request was made');
  assert.equal(new URL(call.url).pathname, '/api/auth/sign-out');
  assert.equal(call.method, 'POST');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/client.test.ts
```

Expected: FAIL — cannot resolve `../../lib/auth/client`.

- [ ] **Step 3: Write `lib/auth/client.ts`**

```ts
'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient, magicLinkClient } from 'better-auth/client/plugins';

/**
 * The browser half of Better Auth.
 *
 * No `baseURL`: the client defaults to the current origin, which is right for
 * every environment we deploy to and avoids an env var that would be wrong on
 * exactly one of them.
 *
 * The plugin list must mirror the server's. A mismatch surfaces as a type error
 * at build time, not at runtime: the client resolves any property path to a
 * callable function, so a missing plugin leaves `signIn.magicLink` callable and
 * wrong rather than undefined.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()],
});

export const { signIn, signOut, useSession } = authClient;
```

- [ ] **Step 4: Run the test**

```bash
npm run test -- test/auth/client.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Write the client half of the page**

`app/(auth)/sign-in/sign-in-form.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { signIn } from '../../../lib/auth/client';

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent' }
  | { readonly kind: 'error'; readonly message: string };

export function SignInForm({ githubEnabled }: { readonly githubEnabled: boolean }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function send(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus({ kind: 'sending' });
    const result = await signIn.magicLink({ email, callbackURL: '/' });
    if (result.error) {
      // The message is Better Auth's, not ours, and never contains the token.
      setStatus({ kind: 'error', message: result.error.message ?? 'sign-in failed' });
      return;
    }
    setStatus({ kind: 'sent' });
  }

  return (
    <>
      <form onSubmit={send}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={status.kind === 'sending'}>
          {status.kind === 'sending' ? 'Sending...' : 'Email me a link'}
        </button>
      </form>

      {status.kind === 'sent' ? <p>Check your email for a sign-in link.</p> : null}
      {status.kind === 'error' ? <p role="alert">{status.message}</p> : null}

      {githubEnabled ? (
        <button type="button" onClick={() => { void signIn.social({ provider: 'github' }); }}>
          Continue with GitHub
        </button>
      ) : null}
    </>
  );
}
```

- [ ] **Step 6: Write the server half of the page**

`app/(auth)/sign-in/page.tsx`:

```tsx
import { githubConfigured } from '../../../lib/auth/server';
import { SignInForm } from './sign-in-form';

// A server component so it can read whether GitHub is configured. The boolean
// crosses the boundary to the client; neither credential does.
export default function SignInPage() {
  return (
    <main>
      <h1>Sign in</h1>
      <SignInForm githubEnabled={githubConfigured()} />
    </main>
  );
}
```

- [ ] **Step 7: Build, then check the page renders**

```bash
npm run build
```

Expected: a clean build listing `/sign-in` among the routes. A `You're importing a component that needs useState` error means `'use client'` is missing from `sign-in-form.tsx`; an error naming `lib/auth/server` in a client bundle means `page.tsx` lost its server-component status.

Then, with the dev server running in another terminal (`npm run dev`), confirm the form works end to end against the sink. Set `MAGIC_LINK_SINK=1` in `.env.local` first, submit the form at `http://localhost:3000/sign-in`, and expect `Check your email for a sign-in link.` The dev server's stdout will not show the link — the sink is an in-process array, and Task 6 is where the flow gets an automated test. This step is a smoke check, not the coverage.

- [ ] **Step 8: Commit**

```bash
npm run check
git add lib/auth/client.ts app/\(auth\)/sign-in/page.tsx \
        app/\(auth\)/sign-in/sign-in-form.tsx test/auth/client.test.ts
git commit -m "Add the browser auth client and a minimal sign-in page

The page is two files because the GitHub button must appear only when
both GitHub credentials exist, and that is server-side knowledge: a
client component cannot read them and must not, since one is a secret.
page.tsx is a server component that calls githubConfigured() and passes
a boolean to the 'use client' half. The boolean crosses the boundary;
neither credential does.

Unstyled on purpose -- Plan 5 brings Tailwind and shadcn, and a styled
page written now would be rewritten then.

The client test checks the method surface rather than rendering. A
missing plugin makes signIn.magicLink undefined rather than throwing,
so the failure would otherwise surface only when a person clicked the
button. The components are covered by the build, which type-checks them
and fails on a server/client boundary violation."
```

---

### Task 5: The admin boundary, enforced twice

**Files:**
- Create: `app/(admin)/admin/layout.tsx`, `app/(admin)/admin/page.tsx`, `app/api/v1/admin/whoami/route.ts`
- Test: `test/auth/adminRoute.test.ts`

**Interfaces:**
- Consumes: `requireAdmin`, `getCurrentUser` (Task 2).
- Produces: nothing other tasks import. Task 6 calls the `whoami` route's `GET`.

**Why the check happens in three places and why that is not duplication.** A Next.js layout does not re-run on every client-side navigation, so a layout is a user-experience guard, not a security boundary — this is documented Next behaviour, not a suspicion. The real enforcement lives where data is actually served: the page component, and the route handler. Each of the three does something different with the same answer:

| Where | On refusal | Role |
|---|---|---|
| `layout.tsx` | redirect to `/sign-in`, or render a refusal in place of `children` | user experience |
| `page.tsx` | render a refusal | enforcement for the page's own data |
| `route.ts` | return the `Response` from `requireAdmin` | enforcement, and the testable one |

**Why the layout renders instead of calling `forbidden()`.** Next 16 exports `forbidden()` from `next/navigation`, but it requires the experimental `authInterrupts` config flag. Turning on an experimental flag to render one sentence is a poor trade, and a layout can simply return its own markup instead of `children`. `redirect()` is used only for the not-signed-in case, where sending someone to `/sign-in` is genuinely what they need.

**The stub is a stub on purpose.** `/admin` renders the signed-in admin's email and a note that Plan 5 fills the area in. Its whole job is to prove the boundary holds; `/admin/cache` is Plan 5's.

- [ ] **Step 1: Write the failing test**

`test/auth/adminRoute.test.ts`. A route handler is an ordinary function, so the guard is directly testable — this is the coverage the pages do not have:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { signIn, deleteUser as cleanup, setRole } from '../helpers/signIn';
import { GET } from '../../app/api/v1/admin/whoami/route';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function get(headers: Headers): Promise<Response> {
  return GET(new Request('http://localhost:3000/api/v1/admin/whoami', { headers }));
}

test('an anonymous request gets 401', opts, async () => {
  const response = await get(new Headers());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
});

test('a signed-in non-admin gets 403', opts, async () => {
  const email = 'whoami-plain@example.test';
  await cleanup(email);
  const response = await get(await signIn(email));
  assert.equal(response.status, 403);
  await cleanup(email);
});

test('an admin gets 200 with their identity', opts, async () => {
  const email = 'whoami-admin@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, ADMIN_ROLE);
  const response = await get(headers);
  assert.equal(response.status, 200);
  const body = await response.json() as { email: string; roles: string[]; isAdmin: boolean };
  assert.equal(body.email, email);
  assert.equal(body.isAdmin, true);
  assert.deepEqual(body.roles, [ADMIN_ROLE]);
  await cleanup(email);
});

test('the response never contains a session token', opts, async () => {
  const email = 'whoami-leak@example.test';
  await cleanup(email);
  const headers = await signIn(email);
  await setRole(email, ADMIN_ROLE);
  const text = await (await get(headers)).text();
  const cookie = headers.get('cookie') ?? '';
  const token = cookie.slice(cookie.indexOf('=') + 1);
  assert.ok(token.length > 0);
  assert.equal(text.includes(token), false, 'the response echoed the session token');
  await cleanup(email);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/adminRoute.test.ts
```

Expected: FAIL — cannot resolve `../../app/api/v1/admin/whoami/route`.

- [ ] **Step 3: Write the route handler**

`app/api/v1/admin/whoami/route.ts`:

```ts
import { requireAdmin } from '../../../../../lib/auth/session';

/**
 * Who the caller is, if the caller is an admin.
 *
 * Session-authenticated rather than key-authenticated: this is the admin UI's
 * own endpoint, and `lib/http/authenticate.ts` answers a different question
 * (which API key is this) for a different audience. Mixing the two would give
 * an API key a way into the admin surface.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireAdmin(request.headers);
  if (!guard.ok) return guard.response;
  const { id, email, name, roles, isAdmin } = guard.user;
  return Response.json({ id, email, name, roles, isAdmin });
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/auth/adminRoute.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Write the layout guard**

`app/(admin)/admin/layout.tsx`:

```tsx
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/auth/session';

/**
 * The admin segment's user-experience guard.
 *
 * Not the security boundary: a layout does not re-run on client-side
 * navigation, so enforcement lives in the page and in the route handlers that
 * serve data. This exists so a person who does not belong here is told so
 * once, at the door, instead of meeting an empty page.
 *
 * `redirect()` only for the not-signed-in case, where /sign-in is genuinely
 * what they need. A signed-in non-admin gets a sentence: Next 16's
 * `forbidden()` needs the experimental `authInterrupts` flag, and turning that
 * on to render one sentence is a poor trade when a layout can just return its
 * own markup instead of children.
 */
export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');
  if (!user.isAdmin) {
    return (
      <main>
        <h1>Not available</h1>
        <p>This area requires the admin role.</p>
      </main>
    );
  }
  return <>{children}</>;
}
```

- [ ] **Step 6: Write the guarded stub page**

`app/(admin)/admin/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { getCurrentUser } from '../../../lib/auth/session';

// Checks again rather than trusting the layout: the layout does not re-run on
// client-side navigation, so a page that serves data checks for itself.
export default async function AdminPage() {
  const user = await getCurrentUser(await headers());
  if (user === null || !user.isAdmin) {
    return (
      <main>
        <h1>Not available</h1>
        <p>This area requires the admin role.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Admin</h1>
      <p>Signed in as {user.email}.</p>
      <p>Cache inspection lands here in Plan 5.</p>
    </main>
  );
}
```

- [ ] **Step 7: Build and check the boundary by hand**

```bash
npm run build
```

Expected: a clean build listing `/admin` and `/api/v1/admin/whoami`.

With `npm run dev` running, visit `http://localhost:3000/admin` while signed out and expect a redirect to `/sign-in`. Signing in via the form (Task 4) and returning gives `This area requires the admin role.`; `npm run admin:promote -- <that email>` followed by a reload gives the admin stub.

- [ ] **Step 8: Commit**

```bash
npm run check
git add app/\(admin\)/admin/layout.tsx app/\(admin\)/admin/page.tsx \
        app/api/v1/admin/whoami/route.ts test/auth/adminRoute.test.ts
git commit -m "Guard the admin segment, and enforce it where data is served

The check appears in three places and each does something different
with the same answer. A Next layout does not re-run on client-side
navigation -- documented behaviour, not a suspicion -- so the layout is
a user-experience guard and the enforcement lives in the page and the
route handler, which is also the one a test can call directly.

The layout returns its own markup for a signed-in non-admin rather than
calling next/navigation's forbidden(), which needs the experimental
authInterrupts flag. Turning on an experimental flag to render one
sentence is a poor trade. redirect() is used only for the
not-signed-in case, where /sign-in is genuinely what they need.

whoami is session-authenticated, not key-authenticated:
lib/http/authenticate.ts answers a different question for a different
audience, and mixing them would give an API key a way into the admin
surface. One test asserts the response never echoes the session token."
```

---

### Task 6: Sign-in end to end, through the mounted handler

**Files:**
- Test: `test/auth/signInFlow.test.ts`
- Modify: `README.md` (an auth section; create the file if it does not exist)

**Interfaces:** consumes the `GET`/`POST` exported by `app/api/auth/[...all]/route.ts` (Task 1) and the `whoami` `GET` (Task 5). Produces nothing.

**What this covers that Task 2 does not.** Task 2 calls `auth.api.*` directly. That proves the plugin works and leaves the mount untested — a wrong catch-all path, a missing `nextCookies()`, or a handler exported under the wrong name would pass every test written so far and fail in a browser. This test drives the real HTTP surface: a `POST` to `/api/auth/sign-in/magic-link`, then a `GET` to `/api/auth/magic-link/verify`, then the cookie against a guarded route.

**The exact values below were verified against the running dev branch, not guessed:**

| Request | Result |
|---|---|
| `POST /api/auth/sign-in/magic-link` with `{email, callbackURL}` | `200`, body `{"status":true}` |
| `GET /api/auth/magic-link/verify?token=…&callbackURL=/` | `302`, `location: http://localhost:3000/`, `Set-Cookie: better-auth.session_token` |
| after verify | one row in `session`, and `user.role` is `'user'` |

Note the 302: `auth.api.magicLinkVerify` returns 200 when called directly, and the HTTP route redirects. Asserting 200 here would fail for a correct implementation.

- [ ] **Step 1: Write the failing test**

`test/auth/signInFlow.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../lib/db/client';
import { magicLinkSink } from '../../lib/auth/server';
import { ADMIN_ROLE } from '../../lib/auth/roles';
import { GET as authGet, POST as authPost } from '../../app/api/auth/[...all]/route';
import { GET as whoami } from '../../app/api/v1/admin/whoami/route';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };
const BASE = 'http://localhost:3000';

after(async () => { if (hasDb) await closeDb(); });

const EMAIL = 'flow@example.test';

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    DELETE FROM session WHERE user_id IN (SELECT id FROM "user" WHERE email = ${EMAIL})`);
  await db.execute(sql`DELETE FROM "user" WHERE email = ${EMAIL}`);
}

test('a magic link signs a user in through the mounted handler', opts, async () => {
  await cleanup();
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    const requested = await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
    assert.equal(requested.status, 200);
    assert.deepEqual(await requested.json(), { status: true });

    const delivery = magicLinkSink.at(-1);
    assert.ok(delivery !== undefined, 'the sink captured no link');
    // The link Better Auth builds must point at the route we mounted.
    assert.equal(new URL(delivery.url).pathname, '/api/auth/magic-link/verify');
    assert.equal(delivery.email, EMAIL);

    const verified = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${delivery.token}&callbackURL=/`,
    ));
    // 302, not 200: the route redirects where auth.api.magicLinkVerify does not.
    assert.equal(verified.status, 302);
    const setCookie = verified.headers.get('set-cookie');
    assert.ok(setCookie !== null, 'no session cookie was set');
    assert.ok(setCookie.startsWith('better-auth.session_token='), setCookie.split('=')[0]);

    const sessions = await getDb().execute(sql`
      SELECT count(*)::int AS n FROM session
       WHERE user_id IN (SELECT id FROM "user" WHERE email = ${EMAIL})`);
    assert.equal(Number(sessions.rows[0]?.n), 1);

    // The cookie is now good enough to pass a guard. Non-admin, so 403.
    const cookie = setCookie.split(';')[0] ?? '';
    const headers = new Headers({ cookie });
    assert.equal((await whoami(new Request(`${BASE}/x`, { headers }))).status, 403);

    await getDb().execute(sql`UPDATE "user" SET role = ${ADMIN_ROLE} WHERE email = ${EMAIL}`);
    const allowed = await whoami(new Request(`${BASE}/x`, { headers }));
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { email: string }).email, EMAIL);
  } finally {
    magicLinkSink.length = 0;
    delete process.env.MAGIC_LINK_SINK;
    await cleanup();
  }
});

test('a magic link cannot be used twice', opts, async () => {
  await cleanup();
  process.env.MAGIC_LINK_SINK = '1';
  magicLinkSink.length = 0;
  try {
    await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
    const token = magicLinkSink.at(-1)?.token ?? '';
    assert.ok(token.length > 0);
    const first = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=/`));
    assert.equal(first.status, 302);
    assert.ok(first.headers.get('set-cookie') !== null);

    // A single-use token that is not single-use is a real vulnerability: a link
    // sitting in a mailbox would be a permanent credential.
    const second = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=/`));
    const reused = second.headers.get('set-cookie');
    assert.ok(
      reused === null || !reused.startsWith('better-auth.session_token='),
      'a reused magic link issued a second session',
    );
  } finally {
    magicLinkSink.length = 0;
    delete process.env.MAGIC_LINK_SINK;
    await cleanup();
  }
});

test('a forged token issues no session', opts, async () => {
  const response = await authGet(new Request(
    `${BASE}/api/auth/magic-link/verify?token=not-a-real-token&callbackURL=/`));
  const setCookie = response.headers.get('set-cookie');
  assert.ok(
    setCookie === null || !setCookie.startsWith('better-auth.session_token='),
    'a forged token issued a session',
  );
});

// NOTE: an earlier draft ended with a test named 'no session token reaches
// stdout' that asserted `magicLinkSink.length === 0`. A review caught it as
// decorative: every earlier test's `finally` already zeroes that array, so it
// passed unconditionally and never looked at any output. It is replaced by the
// two tests below, which were prototyped against the running system first --
// phase one captures zero console lines with a 32-character magic-link token
// and an 81-character session token; phase two captures exactly one line.

test('no credential reaches the log during sign-in', opts, async () => {
  const captured: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };

  let magicToken = '';
  let sessionToken = '';
  try {
    process.env.MAGIC_LINK_SINK = '1';
    magicLinkSink.length = 0;
    await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
    magicToken = magicLinkSink.at(-1)?.token ?? '';
    const verified = await authGet(new Request(
      `${BASE}/api/auth/magic-link/verify?token=${magicToken}&callbackURL=/`));
    const setCookie = verified.headers.get('set-cookie') ?? '';
    sessionToken = setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0] ?? '';
  } finally {
    console.error = originalError;
    console.log = originalLog;
    magicLinkSink.length = 0;
    delete process.env.MAGIC_LINK_SINK;
  }

  // Assert the credentials are real before asserting their absence, so this
  // cannot pass by comparing against empty strings.
  assert.ok(magicToken.length > 16, 'no magic-link token was captured');
  assert.ok(sessionToken.length > 16, 'no session token was issued');

  const output = captured.join('\n');
  assert.equal(output.includes(magicToken), false, 'the magic-link token reached the log');
  assert.equal(output.includes(sessionToken), false, 'the session token reached the log');
  await cleanup();
});

test('with no mailer configured, the failure is logged without the token', opts, async () => {
  // The path that actually logs. With the sink off, sendMagicLink calls
  // logFailure, and the line must name the address so the problem is
  // diagnosable -- while the token stays out of it.
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    delete process.env.MAGIC_LINK_SINK;
    magicLinkSink.length = 0;
    await authPost(new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, callbackURL: '/' }),
    }));
  } finally {
    console.error = originalError;
    magicLinkSink.length = 0;
  }

  const output = captured.join('\n');
  assert.ok(output.includes('no mailer is configured'), 'the failure was not logged');
  assert.ok(output.includes(EMAIL), 'the log line does not say which address');
  // Production must not accumulate live tokens in memory.
  assert.equal(magicLinkSink.length, 0);
  await cleanup();
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/auth/signInFlow.test.ts
```

Expected: FAIL. If it fails on the import of `app/api/auth/[...all]/route`, Task 1's handler is missing or exports different names.

- [ ] **Step 3: Make it pass**

There is nothing new to implement — Tasks 1, 2 and 5 supply everything. Diagnose failures rather than adding code:

- `the sink captured no link` — `MAGIC_LINK_SINK` is not being read at call time inside `sendMagicLink`.
- The `delivery.url` pathname assertion failing means `BETTER_AUTH_URL` or the catch-all route's location disagrees with the mount. This is exactly the class of bug this test exists to catch, and the fix is the route, not the assertion.
- No `set-cookie` on verify — `nextCookies()` is missing from the server plugin list, or it is not last. It must be the final plugin.
- A reused link issuing a second session is a genuine security defect, not a test problem. Stop and investigate the Better Auth configuration before going further.

- [ ] **Step 4: Run the whole suite and build**

```bash
npm run check
npm run build
```

Expected: every test from Plans 1–3 still passing, plus this plan's, and a clean build. The route list should include `/sign-in`, `/admin`, `/api/auth/[...all]`, and `/api/v1/admin/whoami`.

- [ ] **Step 5: Document the auth surface**

Add to `README.md` (create the file with an `# media-name-parser` heading if it is absent):

```markdown
## Authentication

Two independent credentials, for two audiences.

**API keys** authenticate machine callers on `/api/v1/*`, as
`Authorization: Bearer mnp_…`. Mint one with
`npm run seed:key -- <email> [label]`; the secret prints once, to stdout, and
is not recoverable. The key belongs to a real user row.

**Sessions** authenticate people, via a magic link at `/sign-in`. GitHub
appears as an option only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
are both set. `/admin` requires the `admin` role: grant it with
`npm run admin:promote -- <email>`, remove it with `--revoke`.

The two do not mix. An API key cannot reach `/admin`, and a session cannot
stand in for a key on `/api/v1/*`.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string |
| `BETTER_AUTH_SECRET` | yes | signs sessions; Better Auth will not start without it |
| `BETTER_AUTH_URL` | yes | the app's own origin, used to build magic-link URLs |
| `TMDB_READ_ACCESS_TOKEN` | yes | TMDB v4 read access token; the code also accepts the older `TMDB_API_KEY` name |
| `CRON_SECRET` | production | the bearer token Vercel Cron presents to the sweep route |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | no | enables GitHub sign-in when both are set |
| `MAGIC_LINK_SINK` | no | `1` collects magic links in memory instead of sending mail |

No mailer is configured. With `MAGIC_LINK_SINK` unset, requesting a magic link
logs that nothing was delivered rather than pretending to send it. Choosing a
mail provider is deliberately out of this plan's scope.
```

- [ ] **Step 6: Commit**

```bash
git add README.md test/auth/signInFlow.test.ts
git commit -m "Test sign-in end to end through the mounted handler

Task 2 calls auth.api directly, which proves the plugin works and
leaves the mount untested: a wrong catch-all path, a missing
nextCookies(), or a handler exported under the wrong name would pass
every earlier test and fail in a browser. This drives the real HTTP
surface instead -- POST sign-in, GET verify, then the resulting cookie
against a guarded route.

Verify returns 302, not the 200 that auth.api.magicLinkVerify returns
directly; asserting 200 would fail a correct implementation. The test
also asserts a link cannot be used twice and a forged token issues no
session -- a single-use token that is not single-use turns a link
sitting in a mailbox into a permanent credential.

The README now states the two credentials, their audiences, and that
they do not mix."
```

---

## Done when

- `npm run check` and `npm run build` both pass.
- A person can sign in at `/sign-in` with a magic link and reach `/admin` after `npm run admin:promote`.
- A signed-out visitor to `/admin` lands on `/sign-in`; a signed-in non-admin is told they lack the role; `GET /api/v1/admin/whoami` returns 401, 403 and 200 for the three cases.
- No `local-dev` user row remains, and every `api_keys` row points at a real user.
- No test reaches the network, and the suite still skips cleanly with `DATABASE_URL` unset.

## Deliberately not in this plan

Each of these was considered and left out, so a later reader does not mistake absence for oversight.

- **Tailwind, shadcn, and the four pages** (`/`, `/corpus`, `/keys`, `/admin/cache`) — Plan 5. The boundary is worth reviewing without a design system landing in the same diff.
- **A mail provider.** Magic links go to the sink or to a log line saying nothing was delivered. Picking a provider is a decision, not an implementation detail.
- **`app/api/keys/route.ts` and the `/keys` page** — the spec's session-authed token create/revoke endpoint and its UI. `npm run seed:key` covers the need until there is a page to put it on, and the endpoint belongs in the same diff as the page that calls it. Both are Plan 5.
- **Better Auth's `apiKey` plugin.** It does not exist at 1.7.1, and `lib/auth/apiKey.ts` already works and is tested.
- **The `bearer` plugin.** It would let a session token be sent as a bearer header, which is precisely the mixing of the two credentials that Task 5 argues against.
- **Rate limiting on sign-in.** Better Auth has built-in rate limiting worth configuring, but doing it properly means deciding storage and limits, and the existing `lib/auth/rateLimit.ts` covers keys rather than sessions. It is a task, not a step.
