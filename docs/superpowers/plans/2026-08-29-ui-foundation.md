# UI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the service a styled, signed-in interface: a design system, an app shell, and the two pages a user needs before anything else — look a name up, and mint the API key that lets them do it from a script.

**Architecture:** Tailwind v4 (CSS-first, no config file) with a small set of shadcn primitives. The UI never calls `/api/v1/*` — those routes authenticate API keys, and a browser session is not one. Instead `handleLookup` gains an injected authentication gate, so one implementation serves both audiences: the public route passes the API-key gate, and a new session-guarded route passes a session gate. Pages are server components that read the session and hand data to small client components.

**Tech Stack:** Node 26, Next.js 16.3.3 App Router, React 19.2, TypeScript 7.0.2, Tailwind CSS 4.3.3 via `@tailwindcss/postcss`, shadcn 4.19.0 (which builds on `@base-ui/react`), Better Auth 1.7.1, Drizzle 0.45.2, zod 4.4.3, oxlint 1.80.0, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`

**Plan sequence:** Plan 5 of 6. Plans 1–4 are merged and pushed: the parser, the resolution engine, the authenticated API with its job system, and the auth foundation. **This plan covers the design system, the app shell, and `/` and `/keys`.** `/corpus` and `/admin/cache` are **Plan 6** — see "Why this stops at two pages" below.

## Why this stops at two pages

The spec lists four pages in one section, which makes them look like one unit of work. They are not.

`/` and `/keys` are the vertical slice that proves the whole stack: a signed-in person types a filename, the resolution engine answers, and they can mint a key to do the same from a script. Nothing else in the product works until those two do, and between them they force every foundational decision — the design system, the shell, the session-versus-key seam, and the one-time display of a secret.

`/corpus` and `/admin/cache` are both *bulk* surfaces built on top of that foundation, and each carries its own unresolved question: batch runs against a rate-limited provider, and pagination with a JSONB filter across a join. Deciding those inside this plan would mean deciding them badly, and Plan 4 was already at the edge of a reviewable size at six tasks.

## Before you start

Nothing is needed from the user. Every environment variable this plan touches is already set in `.env.local`, and the dev database already holds enough resolved lookups to exercise `/` against real data.

One npm behaviour to expect: **npm 11 blocks package postinstall scripts by default.** Installing Tailwind prints

```
npm warn install-scripts esbuild@0.28.2 (postinstall: node install.js)
```

This is a warning, not a failure — the build works without approving it, which was verified. Do not run `npm install-scripts approve` to make the warning go away unless something actually breaks.

## Global Constraints

- **Node >= 26.** ESM only. No `require`.
- **No `any`.** oxlint sets `typescript/no-explicit-any` to `error`.
- **`unknown` only at a deserialization boundary**, with a comment naming which exception it is.
- **No TypeScript enums, namespaces, or parameter properties** (`erasableSyntaxOnly: true`).
- **`exactOptionalPropertyTypes: true`.** Prefer `field: T | null` over `field?: T`.
- **`noUncheckedIndexedAccess: true`.** `array[i]` is `T | undefined`; narrow before use.
- **2-space indentation, semicolons always.** `readonly` on interface fields and array types, **including component props**.
- **Prefer the async form of any API.** No `*Sync` in a request path.
- **Never log or render a credential.** An API key secret, a session token and a magic-link token never reach a log line, an error body, a rendered page, or a test's stdout. **Never `cat` or print `.env.local`** — an agent leaked a database password from it earlier in this project.
- **Every `catch` that produces a 5xx calls `logFailure`** from `lib/http/log.ts`.
- **No module may call `getAuth()` or `getDb()` at module scope.** Established by review in Plan 4: it turns a missing `DATABASE_URL` into an import-time crash, so tests in importing files *fail* where they must *skip*.
- **Offline tests. No test reaches the network.** No test may call TMDB.
- **Database-backed tests skip without `DATABASE_URL`**, following the pattern in `test/`.
- **Every test that touches the database cleans up in a `finally`**, not after its assertions. A failing test that leaves rows behind is how row-count attribution gets misread — that mistake is documented in `docs/superpowers/notes/2026-08-28-plan-4-followups.md`.
- **Verification gate.** No task is complete until `npm run check` **and** `npm run build` both pass.
- **Commit at the end of each task. Never push.**

---

## Platform facts, measured rather than assumed

Every row was established by installing the real thing in this worktree, building, and then reverting. A wrong guess about any of them would reshape a task.

| Fact | Consequence |
|---|---|
| Tailwind v4 needs exactly two files: `postcss.config.mjs` with `{ plugins: { '@tailwindcss/postcss': {} } }`, and a CSS entry containing `@import "tailwindcss";` | **No `tailwind.config.js`.** v4 is CSS-first; a config file is not created and not needed. |
| Build with Tailwind alone emitted **8,938 bytes** of CSS and generated `max-w-2xl` correctly | The pipeline works with Next 16 unmodified. |
| `tsconfig.json` **already** has `"paths": { "@/*": ["./*"] }` | shadcn's import-alias requirement is already satisfied; do not add or change it. |
| `npx shadcn@4.19.0 init -d -y` runs **non-interactively**, reports "Found Next.js", "Validating Tailwind CSS. Found v4", "Validating import alias" | No prompts to answer. It writes `components.json`, `components/ui/button.tsx`, `lib/utils.ts`, and rewrites the CSS entry and fonts. |
| `npx shadcn@4.19.0 add <names> -y` adds components without prompting | Task 1 adds seven in one command. |
| shadcn 4.19.0 builds on **`@base-ui/react`**, not Radix | Any documentation or memory that says `@radix-ui/*` is out of date for this version. |
| It also installs `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tw-animate-css` — and puts **`shadcn` itself into `dependencies`** | The CLI is a build-time tool; Task 1 moves it to `devDependencies`. |
| The generated components pass **oxlint with zero warnings and `tsc --noEmit` with zero errors** under this project's strict settings | Verified directly. If a generated component fails lint or typecheck, something else is wrong — do not start rewriting shadcn output. |
| A page importing seven of them built clean, CSS **41,004 bytes** | Expect roughly this size; it is not a regression. |
| **`handleLookup` never reads `auth.caller`** — it only branches on `auth.ok` and returns `auth.response` | This is what makes Task 2 small: the gate can be a two-case result with no `Caller` to fabricate. |
| `handleLookup` already accepts a **batch** body, `{ items: [...] }`, capped at 100 | Plan 6's `/corpus` needs no new endpoint. Do not add one here. |
| `categoryDisagreement` is **not a column.** It lives inside `parses.tokens` (JSONB), joined on `(category, normalized_key)` | Relevant to Plan 6's filter, recorded here so it is not rediscovered. The query works; the dev database has exactly 1 such row. |
| `lookups` has no `parsed` column; the parse is in `parses`, keyed `(category, normalized_key)` | `/` renders the envelope's `parsed`, which the handler already assembles. |

---

## Spec coverage, and where this plan diverges

**One divergence, and it is the plan's central decision.**

The spec's UI section says the pages exist and that `/admin` is guarded, but it does not say how a browser reaches the resolution engine. The obvious reading — the pages call `/api/v1/lookup` — **cannot work**, and Plan 4's whole-branch review is the reason it matters: it verified route by route that API-key auth and session auth do not mix, in both directions. A session cookie gets 401 from `/api/v1/lookup`, deliberately.

Three ways out were considered:

1. **Have the page mint or hold an API key on the user's behalf.** Rejected: it puts a long-lived credential in a browser context to solve a problem that is not about credentials.
2. **Duplicate the handler behind a session guard.** Rejected: two copies of the lookup path is how they drift, and the batch handling, deadline logic and job enqueueing are not trivial enough to copy.
3. **Inject the gate.** Chosen. `handleLookup` and `handlePoll` never read the caller, so an injected two-case gate is enough. One implementation, two entry points, and the "they do not mix" property is preserved because each route names exactly one gate.

**Spec requirements this plan completes:** Tailwind with a small number of shadcn primitives (line 581); `/` as a lookup form showing parsed tokens, the match, confidence, people and a cached-versus-fetched badge (line 583); `/keys` creating and revoking tokens with the secret shown once (line 588); and `app/api/keys/route.ts` with session auth (line 90).

**Left to Plan 6:** `/corpus` (line 585) and `/admin/cache` (line 589), plus success criterion 7's `/admin/cache` in particular. Plan 4 already proved the admin boundary on `/admin` and `/api/v1/admin/whoami`, so Plan 6 inherits the mechanism.

---

## File Structure

| Path | Responsibility |
|---|---|
| `postcss.config.mjs` | the Tailwind v4 plugin, and nothing else |
| `app/globals.css` | `@import "tailwindcss";` plus shadcn's generated theme layer |
| `components.json` | shadcn's own config, written by its CLI |
| `components/ui/*.tsx` | generated primitives — **not hand-edited** |
| `lib/utils.ts` | shadcn's `cn()` helper, generated |
| `app/layout.tsx` | **modified** — imports the stylesheet, renders the shell |
| `components/app-shell.tsx` | header, nav, and the signed-in user's identity |
| `components/sign-out-button.tsx` | the `'use client'` half of signing out |
| `lib/http/gate.ts` | `Gate`, `apiKeyGate`, `sessionGate` — the seam |
| `lib/http/lookupHandler.ts` | **modified** — takes a `gate` option, defaulting to `apiKeyGate` |
| `app/api/ui/lookup/route.ts` | session-gated lookup, for the browser |
| `app/page.tsx` | **modified** — the lookup form's server half |
| `components/lookup-form.tsx` | the form and its result rendering |
| `lib/keys/manage.ts` | `listKeys`, `createKey`, `revokeKey` — owner-scoped |
| `app/api/keys/route.ts` | `GET` and `POST`, session-gated |
| `app/api/keys/[id]/route.ts` | `DELETE`, session-gated revoke |
| `app/keys/page.tsx` | the keys page's server half |
| `components/keys-manager.tsx` | the client half, including the once-only secret |
| `test/http/gate.test.ts`, `test/http/uiLookup.test.ts`, `test/keys/manage.test.ts`, `test/http/keysRoutes.test.ts` | the tests |

Not created here: `/corpus`, `/admin/cache`. Those are Plan 6.

---

### Task 1: The design system and the app shell

**Files:**
- Create: `postcss.config.mjs`, `app/globals.css` (via the CLI), `components.json` (via the CLI), `components/ui/*.tsx` (via the CLI), `lib/utils.ts` (via the CLI), `components/app-shell.tsx`, `components/sign-out-button.tsx`
- Modify: `app/layout.tsx`, `package.json`
- Test: `test/ui/shell.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (`lib/auth/session.ts`), `authClient` (`lib/auth/client.ts`).
- Produces:
  - `AppShell` — a server component taking `{ readonly children: ReactNode }`, rendering the header and nav
  - `SignOutButton` — the `'use client'` sign-out control
  - the `components/ui/*` primitives and `cn()` for every later task

**On not hand-editing generated components.** `components/ui/*.tsx` are shadcn's output. They passed oxlint and `tsc` unmodified — verified. If one seems to need changing, wrap it or compose around it; editing it means the next `shadcn add` either clobbers your change or silently diverges from upstream.

**Why the shell is a server component.** It shows who is signed in, which is session state and therefore server state. Only the sign-out control needs to be a client component, so only that is one. This is the same split Plan 4 used for the sign-in page, and for the same reason.

- [ ] **Step 1: Install Tailwind and write the PostCSS config**

```bash
npm install -D tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3
```

`postcss.config.mjs`:

```js
// Tailwind v4 is CSS-first: the plugin is the whole configuration, and there
// is deliberately no tailwind.config.js. Utilities come from `@import
// "tailwindcss"` in app/globals.css.
const config = { plugins: { '@tailwindcss/postcss': {} } };

export default config;
```

Expect the `npm warn install-scripts esbuild` line. It is not a failure.

- [ ] **Step 2: Create the stylesheet and import it**

`app/globals.css`:

```css
@import "tailwindcss";
```

Add to the top of `app/layout.tsx`:

```ts
import './globals.css';
```

- [ ] **Step 3: Confirm Tailwind alone builds before adding shadcn**

```bash
npm run build
find .next -name "*.css" | head -1
```

Expected: a clean build, and a CSS chunk of roughly 9 KB. Confirming this first means that if Step 4 breaks something, you know which half did it.

- [ ] **Step 4: Initialise shadcn and add the primitives**

```bash
npx --yes shadcn@4.19.0 init -d -y
npx --yes shadcn@4.19.0 add input select textarea table badge card label -y
```

Expected output includes `Found Next.js`, `Validating Tailwind CSS. Found v4.`, `Validating import alias.`, then `components/ui/button.tsx` and `lib/utils.ts` from `init`, and seven more files from `add`. It rewrites `app/globals.css` with a theme layer — that is expected; keep its version.

It puts `shadcn` in `dependencies`. Move it:

```bash
npm uninstall shadcn && npm install -D shadcn@4.19.0
```

`shadcn` is a build-time CLI; shipping it as a runtime dependency is simply wrong, and it drags a large tree into the deployment.

- [ ] **Step 5: Confirm the theme tokens the shell relies on actually exist**

`init` rewrites `app/globals.css` with a theme layer. Later steps use `bg-background`, `text-foreground` and `text-muted-foreground`, which come from that layer rather than from Tailwind's own utilities. **I did not verify those exact token names when measuring this plan** — the install was verified, the token names were not. Check them:

```bash
grep -nE '\-\-background|\-\-foreground|\-\-muted-foreground' app/globals.css | head
```

If all three appear, use the class names as written in Steps 8–9. If the generated theme names them differently, **use whatever it generated** and say so in your report — do not add the missing variables by hand, and do not fall back to hard-coded colours. A class that does not resolve produces an unstyled page that still builds, which is exactly the kind of failure nothing else here would catch.

- [ ] **Step 6: Verify the generated code against our settings**

```bash
npx oxlint components/ lib/utils.ts
npx tsc --noEmit
npm run build
```

Expected: **zero** oxlint warnings, **zero** type errors, a clean build. All three were verified before this plan was written. If any fails, stop and report — do not begin editing `components/ui/*`.

- [ ] **Step 7: Write the failing shell test**

`test/ui/shell.test.ts`. There is no React renderer in this project and this task does not add one, so the test covers what is checkable: that the shell module exports what later tasks import, and that the stylesheet and PostCSS wiring exist and say the right thing. The rendering is covered by `npm run build`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AppShell } from '../../components/app-shell';
import { SignOutButton } from '../../components/sign-out-button';

test('the shell and its sign-out control are components', () => {
  assert.equal(typeof AppShell, 'function');
  assert.equal(typeof SignOutButton, 'function');
});

test('the stylesheet imports tailwind', async () => {
  const css = await readFile(new URL('../../app/globals.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@import "tailwindcss"'), 'globals.css must import tailwindcss');
});

test('the layout imports the stylesheet', async () => {
  // Without this import the whole app renders unstyled, and nothing else in
  // the suite would notice.
  const layout = await readFile(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
  assert.ok(layout.includes("./globals.css"), 'layout.tsx must import ./globals.css');
});

test('postcss loads the tailwind v4 plugin and no config file exists', async () => {
  const postcss = await readFile(new URL('../../postcss.config.mjs', import.meta.url), 'utf8');
  assert.ok(postcss.includes('@tailwindcss/postcss'));
  // v4 is CSS-first. A tailwind.config.js here would be silently ignored,
  // which is worse than absent: someone would edit it and expect an effect.
  // Asserted via the error code rather than assert.rejects with a bare string,
  // which node reads as the message parameter and so checks nothing.
  const present = await readFile(new URL('../../tailwind.config.js', import.meta.url), 'utf8')
    .then(() => true)
    .catch(() => false);
  assert.equal(present, false, 'there must be no tailwind.config.js');
});
```

- [ ] **Step 8: Run it and confirm it fails**

```bash
npm run test -- test/ui/shell.test.ts
```

Expected: FAIL — cannot resolve `../../components/app-shell`.

- [ ] **Step 9: Write the sign-out control**

`components/sign-out-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { signOut } from '../lib/auth/client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const [leaving, setLeaving] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={leaving}
      onClick={() => {
        setLeaving(true);
        // The redirect is deliberate rather than a router refresh: signing out
        // invalidates the session the current page was rendered against, and
        // re-rendering it would show a stale identity until the next fetch.
        void signOut().finally(() => { window.location.href = '/sign-in'; });
      }}
    >
      {leaving ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
```

- [ ] **Step 10: Write the shell**

`components/app-shell.tsx`:

```tsx
import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getCurrentUser } from '../lib/auth/session';
import { SignOutButton } from './sign-out-button';

/**
 * The header every signed-in page sits under.
 *
 * A server component because it displays session state. Only the sign-out
 * control is a client component, which is the same split the sign-in page
 * uses: the boundary carries rendered values, never credentials.
 *
 * It does not guard anything. Pages guard themselves -- a layout does not
 * re-run on client-side navigation -- so a shell that refused to render would
 * give a false sense of protection.
 */
export async function AppShell({ children }: { readonly children: ReactNode }) {
  const user = await getCurrentUser(await headers());

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="font-semibold">media-name-parser</Link>
            {/* The Keys link is added in Task 5, not here. `typedRoutes: true`
                types `Link href` against the routes that exist, so linking to
                /keys before app/keys/page.tsx exists is a TS2322 error, not a
                dead link. */}
            {user?.isAdmin === true ? (
              <Link href="/admin" className="text-muted-foreground hover:text-foreground">Admin</Link>
            ) : null}
          </nav>
          {user === null ? (
            <Link href="/sign-in" className="text-sm underline">Sign in</Link>
          ) : (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">{user.email}</span>
              <SignOutButton />
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
```

The admin link appears only for an admin — not as security, which lives in the route, but because a link that always 403s is a bug report waiting to happen.

**There is deliberately no Keys link yet.** `next.config.ts` sets `typedRoutes: true`, so `Link href` is typed against the routes that actually exist. `href="/keys"` before `app/keys/page.tsx` exists is a compile error — measured: `error TS2322: Type '"/keys"' is not assignable to type 'UrlObject | RouteImpl<"/keys">'`. Task 5 adds the link along with the route. Do not work around this by widening the type or using an `UrlObject`; the check is doing its job.

- [ ] **Step 11: Wire the shell into the root layout**

Modify `app/layout.tsx` so the body renders `<AppShell>{children}</AppShell>`. Keep the existing `metadata` export and the `readonly children: ReactNode` prop type — `import type { ReactNode } from 'react'`, matching the file's existing convention, **not** `React.ReactNode`.

- [ ] **Step 12: Run the tests and build**

```bash
npm run check
npm run build
```

Expected: the four new tests pass, the whole suite still passes with 0 skipped, and the build lists the existing routes. Then confirm the shell actually renders — start the dev server in the background, fetch `/`, and check the header is present:

```bash
npm run dev > /tmp/task1-dev.log 2>&1 &
# poll until ready, then:
curl -sS http://localhost:3000/ | grep -c 'media-name-parser'
```

Stop the server afterwards and confirm no `next dev` process remains. If `next dev` creates `AGENTS.md` or `CLAUDE.md` at the repo root, delete them — they are Next 16 dev-time artifacts, neither has ever been tracked here, and they must not be committed or gitignored.

- [ ] **Step 13: Commit**

```bash
npm run check && npm run build
git add postcss.config.mjs app/globals.css components.json components/ lib/utils.ts \
        app/layout.tsx package.json package-lock.json test/ui/shell.test.ts
git commit -m "Add Tailwind v4, shadcn primitives, and the app shell

Tailwind v4 is CSS-first: a PostCSS plugin and an @import, and
deliberately no tailwind.config.js -- a config file here would be
silently ignored, which is worse than absent because someone would
edit it and expect an effect. A test asserts it does not exist.

The shadcn CLI ran non-interactively and its output passes oxlint and
tsc unmodified under this project's strict settings, so the generated
components are left exactly as generated. Editing them means the next
`shadcn add` either clobbers the change or diverges silently.

The CLI installs itself into dependencies; it is a build-time tool, so
it is moved to devDependencies rather than shipped.

The shell is a server component because it displays session state, with
only the sign-out control on the client -- the same split the sign-in
page uses. It guards nothing: pages guard themselves, because a layout
does not re-run on client-side navigation, and a shell that refused to
render would give a false sense of protection."
```

---
### Task 2: One lookup path, two audiences

**Files:**
- Create: `lib/http/gate.ts`, `app/api/ui/lookup/route.ts`
- Modify: `lib/http/lookupHandler.ts`
- Test: `test/http/gate.test.ts`, `test/http/uiLookup.test.ts`

**Interfaces:**
- Consumes: `authenticate` (`lib/http/authenticate.ts`), `requireUser` (`lib/auth/session.ts`), `handleLookup`/`handlePoll` (`lib/http/lookupHandler.ts`), `buildTmdbDeps` (`lib/http/envelope.ts`).
- Produces:
  - `type GateResult = { readonly ok: true } | { readonly ok: false; readonly response: Response }`
  - `type Gate = (request: Request) => Promise<GateResult>`
  - `apiKeyGate: Gate` — wraps `authenticate`, the default
  - `sessionGate: Gate` — wraps `requireUser`
  - `LookupHandlerOptions` gains `readonly gate?: Gate`
  - `PollHandlerOptions` — new, with the same `gate`
  - `POST /api/ui/lookup` — session-gated, same envelope as `/api/v1/lookup`

**Why a gate and not a second handler.** The browser cannot use `/api/v1/lookup`: that route authenticates API keys, and Plan 4's whole-branch review verified route by route that a session cookie gets 401 there — deliberately. Copying the handler behind a session guard would mean two copies of batching, deadline handling and job enqueueing, which is how they drift. `handleLookup` was measured and **never reads `auth.caller`** — only `auth.ok` and `auth.response` — so a two-case gate carries everything it needs and there is no `Caller` to fabricate for a session.

**The property this must preserve.** Each route names exactly one gate. That is what keeps "API keys and sessions do not mix" true, and Task 2's tests assert it in both directions: a session cookie is refused by `/api/v1/lookup`, and an API key is refused by `/api/ui/lookup`.

**No rate limit on the session path, and that is a decision.** `authenticate` charges the per-key rate limit; `requireUser` charges nothing. A signed-in person clicking a form does not need throttling. The batch body is the exposure — `handleLookup` accepts up to 100 items — and Plan 6's `/corpus` is where that gets addressed, because that is the page that sends batches. Recorded so it is a choice rather than an oversight.

- [ ] **Step 1: Write the failing gate test**

`test/http/gate.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { apiKeyGate, sessionGate } from '../../lib/http/gate';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function req(headers: Headers): Request {
  return new Request('http://localhost:3000/api/ui/lookup', { method: 'POST', headers });
}

test('apiKeyGate refuses a request with no bearer token', opts, async () => {
  const result = await apiKeyGate(req(new Headers()));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.response.status, 401);
});

test('apiKeyGate refuses a session cookie', opts, async () => {
  // The whole point of two gates: a cookie is not a key.
  const email = 'gate-cookie@example.test';
  try {
    const result = await apiKeyGate(req(await signIn(email)));
    assert.equal(result.ok, false);
  } finally {
    await deleteUser(email);
  }
});

test('sessionGate refuses a request with no cookie', opts, async () => {
  const result = await sessionGate(req(new Headers()));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.response.status, 401);
});

test('sessionGate admits a signed-in user', opts, async () => {
  const email = 'gate-session@example.test';
  try {
    const result = await sessionGate(req(await signIn(email)));
    assert.equal(result.ok, true);
  } finally {
    await deleteUser(email);
  }
});

test('sessionGate refuses a bearer token', opts, async () => {
  // And the other direction: a key is not a cookie.
  const headers = new Headers({ authorization: 'Bearer mnp_deadbeef_notarealkey' });
  const result = await sessionGate(req(headers));
  assert.equal(result.ok, false);
});

test('a gate result carries no caller', () => {
  // Deliberate: handleLookup never reads one, so the gate does not invent one.
  // If a future handler needs the caller, widen the type on purpose rather
  // than stuffing a synthetic Caller through here.
  const shape: Awaited<ReturnType<typeof sessionGate>> = { ok: true };
  assert.deepEqual(Object.keys(shape), ['ok']);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/http/gate.test.ts
```

Expected: FAIL — cannot resolve `../../lib/http/gate`.

- [ ] **Step 3: Write `lib/http/gate.ts`**

```ts
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
 * does not need throttling. The batch body is the exposure, and the page that
 * sends batches is where that belongs.
 */
export const sessionGate: Gate = async (request) => {
  const guard = await requireUser(request.headers);
  return guard.ok ? { ok: true } : { ok: false, response: guard.response };
};
```

- [ ] **Step 4: Run the gate tests**

```bash
npm run test -- test/http/gate.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Thread the gate through the handlers**

In `lib/http/lookupHandler.ts`:

1. Import `apiKeyGate` and `type Gate` from `./gate`. **Remove the `authenticate` import** — the gate owns that now, and leaving it would let a later edit reintroduce a hardcoded call.
2. Add to `LookupHandlerOptions`, with a docstring saying why it is injectable:

```ts
  /**
   * Who may run this lookup. Defaults to an API key, which is what
   * `/api/v1/lookup` serves. The browser route passes `sessionGate`.
   */
  readonly gate?: Gate;
```

3. In `handleLookup`, replace the two `authenticate` lines with:

```ts
  const gate = options.gate ?? apiKeyGate;
  const pass = await gate(request);
  if (!pass.ok) return pass.response;
```

4. Give `handlePoll` the same treatment. It currently takes `(request, context)`; add a third parameter `options: PollHandlerOptions = {}` and export that interface with the same `gate` field. The public route keeps calling it with two arguments, so the default must be `apiKeyGate`.

Change nothing else in the file. The validation, batching, deadline and enqueue logic stay exactly as they are.

- [ ] **Step 6: Write the browser route**

`app/api/ui/lookup/route.ts`:

```ts
import { handleLookup } from '../../../../lib/http/lookupHandler';
import { buildTmdbDeps } from '../../../../lib/http/envelope';
import { sessionGate } from '../../../../lib/http/gate';

/**
 * The lookup the browser calls.
 *
 * Identical to `/api/v1/lookup` in every respect but the gate, and it returns
 * the same envelope, so the page and any API consumer read the same shape.
 * It lives under `/api/ui/` rather than `/api/v1/` because `/api/v1` is the
 * documented key-authenticated surface and this is not part of it.
 */
export async function POST(request: Request): Promise<Response> {
  return handleLookup(request, buildTmdbDeps, { gate: sessionGate });
}
```

- [ ] **Step 7: Write the crossover test**

`test/http/uiLookup.test.ts`. This is the regression guard for the property Plan 4 established, so write it even though it feels like re-testing:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../../lib/db/client';
import { POST as uiLookup } from '../../app/api/ui/lookup/route';
import { POST as apiLookup } from '../../app/api/v1/lookup/route';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

function body(headers: Headers, name: string): Request {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return new Request('http://localhost:3000/api/ui/lookup', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ category: 'movies', name }),
  });
}

test('the browser route refuses an anonymous request', opts, async () => {
  const response = await uiLookup(body(new Headers(), 'Whatever.2010.1080p.mkv'));
  assert.equal(response.status, 401);
});

test('the browser route refuses a real api key', opts, async () => {
  // A *minted* key, not a made-up string. An unminted token is refused by
  // either gate -- no cookie, or unknown key -- so a fake token leaves this
  // test green even when the route is wired to apiKeyGate, which is precisely
  // the crossover it is named for. A review caught that by mutation and
  // measured the difference: with a real key the wrongly wired route returns
  // 202 where the correct one returns 401.
  const email = 'ui-realkey@example.test';
  try {
    const userId = await withTransaction(async (tx) => (await ensureUser(tx, email)).id);
    const minted = await mintApiKey();
    await withTransaction((tx) => tx.execute(sql`
      INSERT INTO api_keys (user_id, label, token_hash, prefix)
      VALUES (${userId}, 'uiLookup crossover test', ${minted.tokenHash}, ${minted.prefix})`));

    const bearer = new Headers({ authorization: `Bearer ${minted.token}` });

    // First prove the key is real, by using it where it is supposed to work.
    // Without this, a 401 below could just mean the token was bogus.
    const onKeyRoute = await apiLookup(body(bearer, CACHED_NAME));
    assert.ok(
      [200, 202].includes(onKeyRoute.status),
      `the minted key should work on /api/v1/lookup, got ${onKeyRoute.status}`,
    );

    // Now the assertion that matters: the same working key is refused here.
    const onUiRoute = await uiLookup(body(bearer, CACHED_NAME));
    assert.equal(onUiRoute.status, 401, 'a valid api key must not reach the session route');
  } finally {
    // api_keys.user_id cascades, so removing the user removes the key.
    await deleteUser(email);
  }
});

test('the public route still refuses a session cookie', opts, async () => {
  // The other direction, and the property Plan 4 verified route by route.
  const email = 'ui-cross@example.test';
  try {
    const response = await apiLookup(body(await signIn(email), 'Whatever.2010.1080p.mkv'));
    assert.equal(response.status, 401);
  } finally {
    await deleteUser(email);
  }
});

test('a signed-in user gets an envelope from the browser route', opts, async () => {
  // Uses a name already cached in the dev database so the test makes no
  // network call. `cached` proves it came from the cache rather than TMDB.
  const email = 'ui-ok@example.test';
  try {
    const response = await uiLookup(body(await signIn(email), 'Interstellar (2014)'));
    assert.ok([200, 202].includes(response.status), `unexpected ${response.status}`);
    const envelope = await response.json() as {
      lookupId: string; state: string; cached: boolean; confidence: number | null;
    };
    assert.equal(typeof envelope.lookupId, 'string');
    assert.ok(['resolved', 'unresolved', 'pending'].includes(envelope.state));
  } finally {
    await deleteUser(email);
  }
});
```

**If the last test makes a network call**, the name you chose is not in the dev cache. Pick one that is — query `SELECT name FROM lookups WHERE state = 'resolved' LIMIT 5` and use one of those verbatim. Do not weaken the assertion; the point is that a cached name needs no provider.

- [ ] **Step 8: Run everything**

```bash
npm run check
npm run build
```

Expected: the whole suite passing with 0 skipped, and `/api/ui/lookup` in the route list. Every pre-existing lookup test must still pass — they call `handleLookup` with two arguments and so exercise the `apiKeyGate` default, which is the regression check that the refactor changed no behaviour.

- [ ] **Step 9: Commit**

```bash
git add lib/http/gate.ts lib/http/lookupHandler.ts app/api/ui/lookup/route.ts \
        test/http/gate.test.ts test/http/uiLookup.test.ts
git commit -m "Serve one lookup path to two audiences through a gate

The browser cannot call /api/v1/lookup: that route authenticates API
keys and a session cookie gets 401 there, deliberately. Copying the
handler behind a session guard would mean two copies of batching,
deadline handling and job enqueueing, which is how they drift.

handleLookup never reads auth.caller -- only ok and response -- so the
gate is a two-case result with no synthetic Caller to invent for a
session, which would have implied an API key where none exists.

Each route names exactly one gate, and the tests assert the crossover
in both directions: a cookie is refused by /api/v1/lookup and a key is
refused by /api/ui/lookup. The existing lookup tests still call
handleLookup with two arguments, so they exercise the apiKeyGate
default and prove the refactor changed no behaviour.

No rate limit on the session path: a person clicking a form does not
need throttling. The batch body is the exposure, and the page that
sends batches is where that belongs."
```

---
### Task 3: The lookup page

**Files:**
- Modify: `app/page.tsx`
- Create: `components/lookup-form.tsx`
- Test: `test/ui/lookupForm.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (`lib/auth/session.ts`), `type LookupEnvelope` (`lib/http/envelope.ts`), `POST /api/ui/lookup` (Task 2), the `components/ui/*` primitives (Task 1).
- Produces: `LookupForm` — a client component taking no props.

**One import rule that matters here.** The form needs `LookupEnvelope`'s shape, and that type lives in `lib/http/envelope.ts`, which also imports the TMDB client and the database. Import it as **`import type { LookupEnvelope } from '../lib/http/envelope';`** — with `verbatimModuleSyntax` a type-only import is fully erased, so no server code reaches the browser bundle. A value import of the same module would drag the TMDB client and Drizzle into the client bundle, and it would build.

**What the page renders**, from the spec: the parsed tokens, the match, confidence, the people, and a cached-versus-fetched badge. The envelope supplies all five — `parsed`, `media`, `confidence`, `media.people`, and `cached`.

**On a `202`.** The handler returns `202` with the parse intact when it runs out of deadline, and the job finishes in the background. The form must show that state honestly — "still working, come back" — rather than presenting a partial answer as final or an error. There is no polling in this task; `GET /api/v1/lookup/{id}` exists behind the key gate, and giving the browser a poll route is Plan 6's business if the page turns out to need it.

- [ ] **Step 1: Write the failing test**

`test/ui/lookupForm.test.ts`. No renderer, so this covers the module surface and the one thing that would silently break the browser bundle:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LookupForm } from '../../components/lookup-form';

test('the form is a component', () => {
  assert.equal(typeof LookupForm, 'function');
});

test('the form imports the envelope type only as a type', async () => {
  // lib/http/envelope.ts pulls in the TMDB client and Drizzle. A value import
  // here would put both in the browser bundle -- and it would still build,
  // which is why this is asserted rather than left to review.
  const source = await readFile(new URL('../../components/lookup-form.tsx', import.meta.url), 'utf8');
  const envelopeImports = source
    .split('\n')
    .filter((line) => line.includes("lib/http/envelope"));
  assert.ok(envelopeImports.length > 0, 'expected the form to import the envelope type');
  for (const line of envelopeImports) {
    assert.ok(line.includes('import type'), `must be a type-only import: ${line}`);
  }
});

test('the form is a client component', async () => {
  const source = await readFile(new URL('../../components/lookup-form.tsx', import.meta.url), 'utf8');
  assert.ok(source.startsWith("'use client'"), "must begin with 'use client'");
});

test('the page is a server component that does not import the client bundle entry', async () => {
  const source = await readFile(new URL('../../app/page.tsx', import.meta.url), 'utf8');
  assert.ok(!source.includes("'use client'"), 'the page must stay a server component');
  assert.ok(source.includes('LookupForm'), 'the page must render the form');
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/ui/lookupForm.test.ts
```

Expected: FAIL — cannot resolve `../../components/lookup-form`.

- [ ] **Step 3: Write the form**

`components/lookup-form.tsx`:

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
// Type-only: lib/http/envelope.ts imports the TMDB client and the database,
// and a value import would put both in the browser bundle.
import type { LookupEnvelope } from '../lib/http/envelope';

const CATEGORIES = ['tv', 'movies', 'books', 'xxx'] as const;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'looking' }
  | { readonly kind: 'done'; readonly envelope: LookupEnvelope }
  | { readonly kind: 'error'; readonly message: string };

export function LookupForm() {
  const [category, setCategory] = useState<string>('movies');
  const [name, setName] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ kind: 'looking' });
    try {
      const response = await fetch('/api/ui/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, name }),
      });
      if (response.status === 401) {
        setState({ kind: 'error', message: 'Your session expired. Sign in again.' });
        return;
      }
      if (!response.ok && response.status !== 202) {
        // RFC 9457 problem responses carry `detail`; it never contains a
        // credential, because lib/http/problem.ts is written not to.
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        setState({ kind: 'error', message: problem?.detail ?? `Request failed (${response.status})` });
        return;
      }
      setState({ kind: 'done', envelope: await response.json() as LookupEnvelope });
    } catch {
      setState({ kind: 'error', message: 'The request could not be sent.' });
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            name="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div className="min-w-64 flex-1 space-y-1">
          <Label htmlFor="name">Filename</Label>
          <Input
            id="name"
            name="name"
            required
            placeholder="Interstellar.2014.1080p.BluRay.x264-GROUP.mkv"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={state.kind === 'looking'}>
          {state.kind === 'looking' ? 'Looking up…' : 'Look up'}
        </Button>
      </form>

      {state.kind === 'error' ? <p role="alert" className="text-sm text-red-600">{state.message}</p> : null}
      {state.kind === 'done' ? <Result envelope={state.envelope} /> : null}
    </div>
  );
}

function Result({ envelope }: { readonly envelope: LookupEnvelope }) {
  const media = envelope.media;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={envelope.state === 'resolved' ? 'default' : 'secondary'}>{envelope.state}</Badge>
        {/* The spec asks for this badge by name: a reader must be able to tell
            a cache hit from a provider call without reading the logs. */}
        <Badge variant="outline">{envelope.cached ? 'cached' : 'fetched'}</Badge>
        {envelope.partial ? <Badge variant="outline">still working</Badge> : null}
        {envelope.confidence === null
          ? null
          : <Badge variant="outline">confidence {envelope.confidence.toFixed(3)}</Badge>}
      </div>

      {envelope.refusal === null ? null : (
        <p className="text-sm text-muted-foreground">Not parsed: {envelope.refusal}</p>
      )}

      {envelope.partial ? (
        <p className="text-sm text-muted-foreground">
          This is taking longer than the request allows. The parse below is final; the match is
          still being fetched and will be in the cache shortly.
        </p>
      ) : null}

      {media === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>
              {media.title}{media.year === null ? '' : ` (${media.year})`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{media.kind}</p>
            {media.parents.length === 0 ? null : (
              <p className="text-muted-foreground">
                in {media.parents.map((parent) => parent.title).join(' » ')}
              </p>
            )}
            {media.overview === null ? null : <p>{media.overview}</p>}
            {media.people.length === 0 ? null : (
              <ul className="space-y-1">
                {media.people.map((person) => (
                  <li key={`${person.role}:${person.name}:${person.characterName ?? ''}`}>
                    <span className="font-medium">{person.name}</span>
                    <span className="text-muted-foreground">
                      {' '}— {person.role}
                      {person.characterName === null ? '' : ` as ${person.characterName}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {envelope.parsed === null ? null : (
        <Card>
          <CardHeader><CardTitle className="text-base">Parsed tokens</CardTitle></CardHeader>
          <CardContent>
            {/* Rendered generically from the JSON rather than field by field:
                the envelope types this as opaque JSON because a refused lookup
                stores a refusal record here instead of a parse. */}
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
              {Object.entries(envelope.parsed).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="font-mono break-all">
                    {typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the page**

`app/page.tsx`, replacing the current stub entirely:

```tsx
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../lib/auth/session';
import { LookupForm } from '../components/lookup-form';

// Checks for itself rather than trusting the shell: a layout does not re-run
// on client-side navigation. `redirect()` throws control flow, so it stays
// outside any try.
export default async function HomePage() {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Look up a filename</h1>
        <p className="text-sm text-muted-foreground">
          Paste a release name or a library path. The parse is derived here; the match comes from
          the cache when it can.
        </p>
      </div>
      <LookupForm />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and build**

```bash
npm run check
npm run build
```

Expected: 4 new tests passing, the suite green with 0 skipped, and `/` now listed as **`ƒ` (Dynamic)** rather than `○ (Static)` — it reads headers, so Next cannot prerender it. If it is still static, the page is not reading the session.

- [ ] **Step 6: Exercise it against the running app**

```bash
npm run dev > /tmp/task3-dev.log 2>&1 &
# poll until ready, then:
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:3000/
```

Signed out, `/` must redirect toward `/sign-in`. Then confirm the form renders for a signed-in user by any means you can automate — the magic-link sink from Plan 4 makes a session cookie obtainable without a browser (`test/helpers/signIn.ts` shows the flow), and `curl -b` will carry it. Report the status codes you observe. Stop the dev server afterwards and confirm none remains. Delete any `AGENTS.md`/`CLAUDE.md` that `next dev` regenerates.

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx components/lookup-form.tsx test/ui/lookupForm.test.ts
git commit -m "Add the lookup page

The envelope type is imported type-only on purpose:
lib/http/envelope.ts pulls in the TMDB client and Drizzle, and a value
import would put both in the browser bundle -- and would still build.
A test asserts the import stays type-only, because review is a weaker
guard than a failing suite.

The result shows what the spec asks for by name: parsed tokens, the
match, confidence, people, and a cached-versus-fetched badge, so a
reader can tell a cache hit from a provider call without the logs.

A 202 is rendered as 'still working' rather than as an answer or an
error, because that is what it means: the parse is final and the match
is still being fetched. The tokens are rendered generically from the
JSON, since a refused lookup stores a refusal record where a parse
would otherwise be.

The page checks the session itself rather than trusting the shell, for
the same reason the admin page does: a layout does not re-run on
client-side navigation."
```

---
### Task 4: The keys API

**Files:**
- Create: `lib/keys/manage.ts`, `app/api/keys/route.ts`, `app/api/keys/[id]/route.ts`
- Test: `test/keys/manage.test.ts`, `test/http/keysRoutes.test.ts`

**Interfaces:**
- Consumes: `Tx`/`withTransaction` (`lib/db/client.ts`), `mintApiKey`/`verifyApiKey` (`lib/auth/apiKey.ts`), `requireUser` (`lib/auth/session.ts`), `problem` helpers (`lib/http/problem.ts`), `logFailure` (`lib/http/log.ts`).
- Produces:
  - `interface KeyRow { readonly id: string; readonly label: string; readonly prefix: string; readonly rateLimitPerMin: number; readonly lastUsedAt: string | null; readonly revokedAt: string | null; readonly createdAt: string }`
  - `listKeys(tx: Tx, userId: string): Promise<readonly KeyRow[]>`
  - `createKey(tx: Tx, userId: string, label: string): Promise<{ readonly row: KeyRow; readonly token: string }>`
  - `revokeKey(tx: Tx, userId: string, keyId: string): Promise<boolean>`
  - `GET`/`POST` on `/api/keys`, `DELETE` on `/api/keys/[id]`

**Why these routes call `requireUser` and not `sessionGate`.** Task 2's gate deliberately discards the caller, because `handleLookup` never needs it. These routes do: every query is scoped to the owner. So they call `requireUser` directly and use `guard.user.id`. That is the gate's design working as intended, not an inconsistency — a route that needs the user asks for the user.

**Owner scoping is the security property of this task.** `revokeKey` and `listKeys` both filter on `user_id`. A revoke that only matched on `id` would let any signed-in user revoke anyone's key, and it would pass a test that only ever used one user. **The tests use two users on purpose.**

**Revoke sets `revoked_at`; it does not delete.** `verifyApiKey` already excludes revoked rows in SQL, so a revoked key stops working immediately, and the row remains as a record that the key existed. A missing or unowned key gets the same `404` as a nonexistent one, so the response does not reveal whether someone else's key id is real.

**The secret is returned exactly once**, in the `POST` response, and never stored — only its hash is. `listKeys` returns the `prefix`, which is stored in the clear so a UI can say which key is which. Nothing in this task may log, echo or persist the token.

- [ ] **Step 1: Write the failing manager test**

`test/keys/manage.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import { ensureUser } from '../../lib/auth/users';
import { verifyApiKey } from '../../lib/auth/apiKey';
import { listKeys, createKey, revokeKey } from '../../lib/keys/manage';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

const OWNER = 'keys-owner@example.test';
const OTHER = 'keys-other@example.test';

after(async () => { if (hasDb) await closeDb(); });

async function cleanup(): Promise<void> {
  const db = getDb();
  for (const email of [OWNER, OTHER]) {
    await db.execute(sql`DELETE FROM "user" WHERE email = ${email}`);
  }
}

async function idFor(email: string): Promise<string> {
  return withTransaction(async (tx) => (await ensureUser(tx, email)).id);
}

test('a new user has no keys', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    assert.deepEqual(await withTransaction((tx) => listKeys(tx, id)), []);
  } finally {
    await cleanup();
  }
});

test('createKey returns a working token and a row without the hash', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const made = await withTransaction((tx) => createKey(tx, id, 'laptop'));
    assert.ok(made.token.startsWith('mnp_'), 'the token should carry the greppable marker');
    assert.equal(made.row.label, 'laptop');
    assert.ok(made.row.prefix.length > 0);
    // The row must not carry the secret or its hash in any field.
    const serialised = JSON.stringify(made.row);
    assert.equal(serialised.includes(made.token), false, 'the row echoed the token');
    assert.ok(!('tokenHash' in made.row), 'the row must not expose the hash');

    const caller = await withTransaction((tx) => verifyApiKey(tx, made.token));
    assert.ok(caller !== null, 'the minted token should authenticate');
    assert.equal(caller.userId, id);
  } finally {
    await cleanup();
  }
});

test('listKeys shows only the caller own keys', opts, async () => {
  // Two users, deliberately: a query that forgot `user_id` would pass with one.
  await cleanup();
  try {
    const owner = await idFor(OWNER);
    const other = await idFor(OTHER);
    await withTransaction((tx) => createKey(tx, owner, 'mine'));
    await withTransaction((tx) => createKey(tx, other, 'theirs'));

    const mine = await withTransaction((tx) => listKeys(tx, owner));
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.label, 'mine');
  } finally {
    await cleanup();
  }
});

test('revokeKey stops the token working', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const made = await withTransaction((tx) => createKey(tx, id, 'doomed'));
    assert.ok(await withTransaction((tx) => verifyApiKey(tx, made.token)) !== null);

    assert.equal(await withTransaction((tx) => revokeKey(tx, id, made.row.id)), true);
    assert.equal(await withTransaction((tx) => verifyApiKey(tx, made.token)), null);

    // The row survives as a record, marked revoked.
    const rows = await withTransaction((tx) => listKeys(tx, id));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]?.revokedAt !== null, 'the row should be marked revoked, not deleted');
  } finally {
    await cleanup();
  }
});

test('one user cannot revoke another user key', opts, async () => {
  // The security property of this task, as an assertion.
  await cleanup();
  try {
    const owner = await idFor(OWNER);
    const other = await idFor(OTHER);
    const made = await withTransaction((tx) => createKey(tx, owner, 'mine'));

    assert.equal(await withTransaction((tx) => revokeKey(tx, other, made.row.id)), false);
    // And it still works, which is the part that matters.
    assert.ok(await withTransaction((tx) => verifyApiKey(tx, made.token)) !== null);
  } finally {
    await cleanup();
  }
});

test('revoking twice is not an error the second time', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const made = await withTransaction((tx) => createKey(tx, id, 'twice'));
    assert.equal(await withTransaction((tx) => revokeKey(tx, id, made.row.id)), true);
    // Already revoked: reports false rather than throwing, so a double-click
    // in the UI is not an error page.
    assert.equal(await withTransaction((tx) => revokeKey(tx, id, made.row.id)), false);
  } finally {
    await cleanup();
  }
});

test('revoking an unknown id reports false', opts, async () => {
  await cleanup();
  try {
    const id = await idFor(OWNER);
    const absent = '00000000-0000-0000-0000-000000000000';
    assert.equal(await withTransaction((tx) => revokeKey(tx, id, absent)), false);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/keys/manage.test.ts
```

Expected: FAIL — cannot resolve `../../lib/keys/manage`.

- [ ] **Step 3: Write `lib/keys/manage.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { mintApiKey } from '../auth/apiKey';

/**
 * A key as its owner may see it.
 *
 * No `tokenHash` field, and no secret: the hash is an authentication detail
 * and the secret is shown exactly once, at creation. `prefix` is stored in the
 * clear precisely so a UI can name a key without holding its secret.
 */
export interface KeyRow {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

function toRow(row: Record<string, unknown>): KeyRow {
  // `unknown` here is the deserialization exception: these are database
  // columns being narrowed on the way out, not application state.
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    label: String(row.label),
    prefix: String(row.prefix),
    rateLimitPerMin: Number(row.rate_limit_per_min),
    lastUsedAt: text(row.last_used_at),
    revokedAt: text(row.revoked_at),
    createdAt: String(row.created_at),
  };
}

const COLUMNS = sql`id, label, prefix, rate_limit_per_min, last_used_at, revoked_at, created_at`;

/** Every query in this module filters on `user_id`. That is the point. */
export async function listKeys(tx: Tx, userId: string): Promise<readonly KeyRow[]> {
  const result = await tx.execute(sql`
    SELECT ${COLUMNS} FROM api_keys WHERE user_id = ${userId} ORDER BY created_at DESC`);
  return result.rows.map(toRow);
}

export async function createKey(
  tx: Tx,
  userId: string,
  label: string,
): Promise<{ readonly row: KeyRow; readonly token: string }> {
  const minted = await mintApiKey();
  const result = await tx.execute(sql`
    INSERT INTO api_keys (user_id, label, token_hash, prefix)
    VALUES (${userId}, ${label}, ${minted.tokenHash}, ${minted.prefix})
    RETURNING ${COLUMNS}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the inserted api key row was not returned');
  // The token travels back to the caller once, here, and is never stored.
  return { row: toRow(row), token: minted.token };
}

/**
 * Marks a key revoked, scoped to its owner.
 *
 * Returns false when the key does not exist, is not this user's, or was
 * already revoked -- three cases the caller cannot distinguish, deliberately:
 * telling someone their guess at another user's key id was a real id is a
 * disclosure with no upside.
 *
 * The row is kept rather than deleted. `verifyApiKey` excludes revoked rows in
 * SQL, so the key stops working at once, and the record that it existed
 * survives.
 */
export async function revokeKey(tx: Tx, userId: string, keyId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE api_keys SET revoked_at = now()
     WHERE id = ${keyId}::uuid AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id`);
  return result.rows.length > 0;
}
```

- [ ] **Step 4: Run the manager tests**

```bash
npm run test -- test/keys/manage.test.ts
```

Expected: 7 passing. If `one user cannot revoke another user key` fails, the `user_id` filter is missing — that is the defect the test exists for.

- [ ] **Step 5: Write the failing route test**

`test/http/keysRoutes.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../../lib/db/client';
import { GET as listRoute, POST as createRoute } from '../../app/api/keys/route';
import { DELETE as revokeRoute } from '../../app/api/keys/[id]/route';
import { signIn, deleteUser } from '../helpers/signIn';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

const A = 'keysroute-a@example.test';
const B = 'keysroute-b@example.test';

after(async () => { if (hasDb) await closeDb(); });

async function cleanup(): Promise<void> {
  for (const email of [A, B]) await deleteUser(email);
}

function post(headers: Headers, label: string): Request {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return new Request('http://localhost:3000/api/keys', {
    method: 'POST', headers: h, body: JSON.stringify({ label }),
  });
}

test('an anonymous request cannot list or create keys', opts, async () => {
  const listed = await listRoute(new Request('http://localhost:3000/api/keys'));
  assert.equal(listed.status, 401);
  const created = await createRoute(post(new Headers(), 'nope'));
  assert.equal(created.status, 401);
});

test('creating a key returns the secret exactly once', opts, async () => {
  await cleanup();
  try {
    const headers = await signIn(A);
    const created = await createRoute(post(headers, 'laptop'));
    assert.equal(created.status, 201);
    const payload = await created.json() as { token: string; key: { id: string; prefix: string } };
    assert.ok(payload.token.startsWith('mnp_'));

    // The list must never carry it again, nor the hash.
    const listed = await listRoute(new Request('http://localhost:3000/api/keys', { headers }));
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.equal(text.includes(payload.token), false, 'the list echoed the secret');
    assert.equal(text.toLowerCase().includes('token_hash'), false);
    assert.equal(text.toLowerCase().includes('tokenhash'), false);
    assert.ok(text.includes(payload.key.prefix), 'the list should name the key by prefix');
  } finally {
    await cleanup();
  }
});

test('a label is required', opts, async () => {
  await cleanup();
  try {
    const headers = new Headers(await signIn(A));
    headers.set('content-type', 'application/json');
    const response = await createRoute(new Request('http://localhost:3000/api/keys', {
      method: 'POST', headers, body: JSON.stringify({}),
    }));
    assert.equal(response.status, 400);
  } finally {
    await cleanup();
  }
});

test('a user cannot revoke another user key through the route', opts, async () => {
  await cleanup();
  try {
    const headersA = await signIn(A);
    const created = await createRoute(post(headersA, 'mine'));
    const payload = await created.json() as { key: { id: string } };

    const headersB = await signIn(B);
    const response = await revokeRoute(
      new Request(`http://localhost:3000/api/keys/${payload.key.id}`, { method: 'DELETE', headers: headersB }),
      { params: Promise.resolve({ id: payload.key.id }) },
    );
    // Same answer as a key that does not exist: no disclosure either way.
    assert.equal(response.status, 404);
  } finally {
    await cleanup();
  }
});

test('an owner can revoke their own key', opts, async () => {
  await cleanup();
  try {
    const headers = await signIn(A);
    const created = await createRoute(post(headers, 'doomed'));
    const payload = await created.json() as { key: { id: string } };

    const response = await revokeRoute(
      new Request(`http://localhost:3000/api/keys/${payload.key.id}`, { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: payload.key.id }) },
    );
    assert.equal(response.status, 204);

    const listed = await listRoute(new Request('http://localhost:3000/api/keys', { headers }));
    const body = await listed.json() as { keys: readonly { revokedAt: string | null }[] };
    assert.ok(body.keys[0]?.revokedAt !== null);
  } finally {
    await cleanup();
  }
});

test('a malformed key id does not produce a 500', opts, async () => {
  // `id`::uuid on a non-uuid throws in Postgres; the route must catch it.
  await cleanup();
  try {
    const headers = await signIn(A);
    const response = await revokeRoute(
      new Request('http://localhost:3000/api/keys/not-a-uuid', { method: 'DELETE', headers }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    assert.ok([400, 404].includes(response.status), `got ${response.status}`);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 6: Write the routes**

`app/api/keys/route.ts`:

```ts
import { z } from 'zod';
import { withTransaction } from '../../../lib/db/client';
import { requireUser } from '../../../lib/auth/session';
import { badRequest, unavailable } from '../../../lib/http/problem';
import { logFailure } from '../../../lib/http/log';
import { createKey, listKeys } from '../../../lib/keys/manage';

/**
 * A user's own API keys.
 *
 * `requireUser` rather than Task 2's gate: every query here is scoped to the
 * owner, so this route needs the user the gate deliberately discards.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireUser(request.headers);
  if (!guard.ok) return guard.response;
  try {
    const keys = await withTransaction((tx) => listKeys(tx, guard.user.id));
    return Response.json({ keys });
  } catch (error) {
    logFailure('listKeys', error);
    return unavailable('the keys could not be read');
  }
}

const createBody = z.object({ label: z.string().min(1, 'label must not be empty').max(120) });

export async function POST(request: Request): Promise<Response> {
  const guard = await requireUser(request.headers);
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('the body must be JSON');
  }
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'invalid body');
  }

  try {
    const made = await withTransaction((tx) => createKey(tx, guard.user.id, parsed.data.label));
    // The only time the secret is ever sent. It is not stored and cannot be
    // shown again.
    return Response.json({ key: made.row, token: made.token }, { status: 201 });
  } catch (error) {
    logFailure('createKey', error);
    return unavailable('the key could not be created');
  }
}
```

`app/api/keys/[id]/route.ts`:

```ts
import { withTransaction } from '../../../../lib/db/client';
import { requireUser } from '../../../../lib/auth/session';
import { notFound, unavailable } from '../../../../lib/http/problem';
import { logFailure } from '../../../../lib/http/log';
import { revokeKey } from '../../../../lib/keys/manage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const guard = await requireUser(request.headers);
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  // Checked before it reaches SQL: `${id}::uuid` on a non-uuid raises a
  // database error, and a 503 is the wrong answer to a malformed id.
  if (!UUID.test(id)) return notFound('no such key');

  try {
    const revoked = await withTransaction((tx) => revokeKey(tx, guard.user.id, id));
    // Absent, someone else's, or already revoked all answer the same way.
    if (!revoked) return notFound('no such key');
    return new Response(null, { status: 204 });
  } catch (error) {
    logFailure('revokeKey', error);
    return unavailable('the key could not be revoked');
  }
}
```

- [ ] **Step 7: Run everything**

```bash
npm run check
npm run build
```

Expected: 13 new tests across the two files, the suite green with 0 skipped, and `/api/keys` plus `/api/keys/[id]` in the route list.

- [ ] **Step 8: Commit**

```bash
git add lib/keys/manage.ts app/api/keys/route.ts app/api/keys/\[id\]/route.ts \
        test/keys/manage.test.ts test/http/keysRoutes.test.ts
git commit -m "Add the keys API, scoped to the owner

Every query filters on user_id. A revoke matching only on id would let
any signed-in user revoke anyone's key, and it would pass a test that
used one user -- so the tests use two, and one of them asserts the
other user's key still works afterwards.

These routes call requireUser rather than Task 2's gate, because they
need the user the gate deliberately discards. A route that needs the
caller asks for the caller.

Revoke marks revoked_at rather than deleting: verifyApiKey already
excludes revoked rows in SQL so the key dies immediately, and the
record that it existed survives. Absent, unowned and already-revoked
all answer 404, because telling someone their guess at another user's
key id was real is a disclosure with no upside. A malformed id is
rejected before it reaches ::uuid, where it would have raised a
database error and turned into a 503.

The secret is returned exactly once, at creation, and the list route is
asserted never to echo it or the hash."
```

---
### Task 5: The keys page

**Files:**
- Create: `app/keys/page.tsx`, `components/keys-manager.tsx`
- Modify: `components/app-shell.tsx` (add the Keys link, which only typechecks once this task's route exists)
- Test: `test/ui/keysManager.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser` (`lib/auth/session.ts`), `type KeyRow` (`lib/keys/manage.ts`), the routes from Task 4, the `components/ui/*` primitives.
- Produces: `KeysManager` — a client component taking `{ readonly initialKeys: readonly KeyRow[] }`.

**The one-time secret is this page's whole reason for existing.** The spec says "the secret is shown once". That is a UI contract, and getting it wrong is a support problem rather than a crash: a user who closes the panel without copying has lost the key and must mint another. So the panel says so before they can lose it, offers a copy button, and stays until dismissed deliberately. It is never re-rendered from state after dismissal, and it is never written anywhere else.

**Why the page passes `initialKeys` in.** The server component already has a session, so it can list the keys during render and the page arrives populated instead of empty-then-flashing. The client component keeps its own copy afterwards, because it mutates the list as keys are created and revoked.

**`KeyRow` is imported type-only.** `lib/keys/manage.ts` imports Drizzle; the same rule as Task 3 applies, and the test asserts it.

- [ ] **Step 1: Write the failing test**

`test/ui/keysManager.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KeysManager } from '../../components/keys-manager';

const source = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

test('the manager is a client component', async () => {
  assert.equal(typeof KeysManager, 'function');
  assert.ok((await source('components/keys-manager.tsx')).startsWith("'use client'"));
});

test('the manager imports KeyRow type-only', async () => {
  // lib/keys/manage.ts imports Drizzle; a value import would ship it.
  const text = await source('components/keys-manager.tsx');
  for (const line of text.split('\n').filter((l) => l.includes('lib/keys/manage'))) {
    assert.ok(line.includes('import type'), `must be type-only: ${line}`);
  }
});

test('the secret is never persisted anywhere', async () => {
  // The token lives in component state and nowhere else. A localStorage or
  // sessionStorage write would outlive the page and turn a one-time secret
  // into a stored credential.
  const text = await source('components/keys-manager.tsx');
  for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie']) {
    assert.equal(text.includes(forbidden), false, `must not use ${forbidden}`);
  }
});

test('the page is a server component that lists keys for the render', async () => {
  const text = await source('app/keys/page.tsx');
  assert.ok(!text.includes("'use client'"), 'the page must stay a server component');
  assert.ok(text.includes('listKeys'), 'the page should populate the first render');
  assert.ok(text.includes('KeysManager'));
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm run test -- test/ui/keysManager.test.ts
```

Expected: FAIL — cannot resolve `../../components/keys-manager`.

- [ ] **Step 3: Write the manager**

`components/keys-manager.tsx`:

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
// Type-only: lib/keys/manage.ts imports Drizzle.
import type { KeyRow } from '../lib/keys/manage';

function when(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

export function KeysManager({ initialKeys }: { readonly initialKeys: readonly KeyRow[] }) {
  const [keys, setKeys] = useState<readonly KeyRow[]>(initialKeys);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one and only copy of the secret, held in memory for as long as the
  // panel is open and never written anywhere else.
  const [fresh, setFresh] = useState<{ readonly prefix: string; readonly token: string } | null>(null);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        setError(problem?.detail ?? `Could not create the key (${response.status})`);
        return;
      }
      const payload = await response.json() as { key: KeyRow; token: string };
      setKeys([payload.key, ...keys]);
      setFresh({ prefix: payload.key.prefix, token: payload.token });
      setLabel('');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    const response = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
    if (response.status !== 204) {
      setError('Could not revoke that key.');
      return;
    }
    setKeys(keys.map((key) => (key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key)));
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1">
          <Label htmlFor="label">Label</Label>
          <Input
            id="label"
            name="label"
            required
            maxLength={120}
            placeholder="laptop, CI, sonarr…"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create key'}</Button>
      </form>

      {error === null ? null : <p role="alert" className="text-sm text-red-600">{error}</p>}

      {fresh === null ? null : (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-base">Copy this key now — it is shown once</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Only a hash is stored, so this cannot be shown again. If you lose it, revoke the key
              and create another.
            </p>
            <code className="block break-all rounded bg-muted p-3 font-mono text-sm">{fresh.token}</code>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => { void navigator.clipboard?.writeText(fresh.token); }}
              >
                Copy
              </Button>
              {/* Dismissal drops the only copy, so it is an explicit action. */}
              <Button type="button" size="sm" variant="outline" onClick={() => setFresh(null)}>
                I have copied it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Label</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">No keys yet.</TableCell>
            </TableRow>
          ) : keys.map((key) => (
            <TableRow key={key.id}>
              <TableCell>{key.label}</TableCell>
              <TableCell className="font-mono text-xs">
                mnp_{key.prefix}…
                {key.revokedAt === null ? null : <Badge variant="outline" className="ml-2">revoked</Badge>}
              </TableCell>
              <TableCell>{when(key.createdAt)}</TableCell>
              <TableCell>{when(key.lastUsedAt)}</TableCell>
              <TableCell className="text-right">
                {key.revokedAt === null ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => { void revoke(key.id); }}>
                    Revoke
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 4: Write the page**

`app/keys/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/auth/session';
import { withTransaction } from '../../lib/db/client';
import { listKeys } from '../../lib/keys/manage';
import { KeysManager } from '../../components/keys-manager';

// Guards itself, like every other page: a layout does not re-run on
// client-side navigation. `redirect()` throws control flow, so it stays
// outside any try.
export default async function KeysPage() {
  const user = await getCurrentUser(await headers());
  if (user === null) redirect('/sign-in');

  // Listed during the render so the page arrives populated rather than
  // empty-then-flashing. The client keeps its own copy afterwards, because it
  // mutates the list as keys come and go.
  const keys = await withTransaction((tx) => listKeys(tx, user.id));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Send a key as <code className="font-mono">Authorization: Bearer …</code> to{' '}
          <code className="font-mono">/api/v1/lookup</code>. The secret is shown once, when you
          create it.
        </p>
      </div>
      <KeysManager initialKeys={keys} />
    </div>
  );
}
```

- [ ] **Step 5: Add the Keys link to the shell**

Task 1 deliberately left it out: with `typedRoutes: true`, `Link href="/keys"` is a compile error until `app/keys/page.tsx` exists. It exists now, so add it to `components/app-shell.tsx` beside the existing links, replacing the comment Task 1 left in its place:

```tsx
            <Link href="/keys" className="text-muted-foreground hover:text-foreground">Keys</Link>
```

`npm run typecheck` is the proof it is legal now; it would have failed in Task 1.

- [ ] **Step 6: Run everything**

```bash
npm run check
npm run build
```

Expected: 4 new tests passing, the suite green with 0 skipped, and `/keys` listed as `ƒ` (Dynamic).

- [ ] **Step 7: Exercise the round trip**

Without a browser, drive the routes with a session cookie obtained the way `test/helpers/signIn.ts` does, and confirm the whole cycle: create a key, use it against `/api/v1/lookup` with `Authorization: Bearer`, revoke it, and confirm the same key is then refused. This is the spec's success criterion 6 — "a user can register, mint an API token, and use it against `/v1/lookup`" — end to end. Report each status code. Redirect the secret to a variable, never to a log or your report.

- [ ] **Step 8: Commit**

```bash
git add app/keys/page.tsx components/keys-manager.tsx test/ui/keysManager.test.ts
git commit -m "Add the keys page

The one-time secret is the reason this page exists. Only a hash is
stored, so a user who dismisses the panel without copying has lost the
key -- the panel says that before they can, offers a copy button, and
takes an explicit dismissal. A test asserts the token never reaches
localStorage, sessionStorage or a cookie, because any of those would
turn a one-time secret into a stored credential.

The page lists keys during the render so it arrives populated instead
of empty-then-flashing; the client keeps its own copy because it
mutates the list as keys are created and revoked.

KeyRow is imported type-only: lib/keys/manage.ts imports Drizzle, and a
value import would ship it to the browser and still build."
```

---

## Done when

- `npm run check` and `npm run build` both pass, with 0 skipped tests.
- A signed-out visitor to `/` or `/keys` lands on `/sign-in`.
- A signed-in user can look a filename up on `/` and see parsed tokens, the match, confidence, people, and a cached-versus-fetched badge.
- A `202` is presented as unfinished work, not as an answer and not as an error.
- A signed-in user can create a key, is shown the secret exactly once, uses it against `/api/v1/lookup`, and revokes it — the spec's success criterion 6, end to end.
- `/api/ui/lookup` refuses an API key; `/api/v1/lookup` refuses a session cookie. Both directions are asserted.
- No key secret, session token or magic-link token appears in any log line, response body, rendered page or test output.
- The dev database is left as it was found: every test cleans up in a `finally`.

## Deliberately not in this plan

- **`/corpus` and `/admin/cache`** — Plan 6. Each is a bulk surface with its own unresolved question: batch runs against a rate-limited provider, and pagination with a JSONB filter across a join. `handleLookup` already takes a batch body capped at 100, and `categoryDisagreement` lives in `parses.tokens` joined on `(category, normalized_key)` — both measured, both recorded in the facts table so Plan 6 starts from them.
- **A rate limit on the session path.** The key path charges one; a person clicking a form does not need it. The batch body is the real exposure and belongs with the page that sends batches.
- **Polling from the browser.** `GET /api/v1/lookup/{id}` exists behind the key gate. Whether the UI needs a session-gated equivalent depends on how often `202` actually shows up, which is a question `/` will answer.
- **Editing `components/ui/*`.** They are generated, they pass lint and typecheck unmodified, and hand-editing them makes the next `shadcn add` either clobber the change or diverge silently.
- **Dark mode, responsive polish, and empty-state design.** The shell is deliberately plain. Making it good is worth a pass of its own, once there are four pages to be consistent across.
- **A sign-out route.** `authClient.signOut()` plus a redirect is enough; a route would add a surface for no gain.
- **Fixing the test-suite row leakage** documented in `docs/superpowers/notes/2026-08-28-plan-4-followups.md` (`api_keys` at 304 rows for 4 users, growing ~10 per run). Every test in *this* plan cleans up in a `finally`, but the older files are not this plan's to reopen. It remains the best candidate for a short debt pass.
