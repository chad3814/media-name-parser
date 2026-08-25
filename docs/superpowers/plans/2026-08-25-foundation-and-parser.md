# Foundation and Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Next.js/Neon project with the complete database schema, and build a tv/movies filename parser whose accuracy is measured against the committed 5,951-line corpus.

**Architecture:** The parser is a pure pipeline of four independently testable modules — normalize, tokens, boundary, markers — assembled by `video.ts` into a discriminated union. Nothing in `lib/parse/` touches the database, the network, or the clock, so every test is a table of strings. The schema lands in this plan (not the next) so that Plan 2 has tables to write to on day one.

**Tech Stack:** Node 26, Next.js 16.3.3 (App Router), TypeScript 7.0.2, Drizzle ORM 0.45.2 + drizzle-kit 0.31.10, `@neondatabase/serverless` 1.1.0, Better Auth 1.7.1, zod 4.4.3, oxlint 1.80.0, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`

**Plan sequence:** This is plan 1 of 3. Plan 2 covers resolution and the API (TMDB client, confidence, pipeline, cache, endpoints, sweeper). Plan 3 covers auth and UI. Do not implement Plan 2 or 3 material here; several tasks below create tables and types that Plan 2 consumes, and those are called out in each task's Interfaces block.

## Global Constraints

- **Node >= 26.** `package.json` sets `"engines": { "node": ">=26" }` and `.nvmrc` contains `26`.
- **ESM only.** `"type": "module"` in `package.json`. No `require`.
- **No `any`.** oxlint sets `typescript/no-explicit-any` to `error`.
- **`unknown` only at a deserialization boundary.** Project policy is to avoid it; parse untrusted input with a zod schema and use the inferred type. Two narrow exceptions are permitted, because forbidding them forces worse code: the immediate argument of a zod `.parse()` call, and a zod schema field whose value is compared structurally rather than read (`test/golden.test.ts` holds the only instance in this plan). Every use must carry a comment naming which exception it is.
- **No TypeScript enums, namespaces, or parameter properties.** `erasableSyntaxOnly: true` forbids them. Use `const` objects plus union types, or Drizzle's `pgEnum` (a runtime value, which is fine).
- **`exactOptionalPropertyTypes: true`.** Prefer `field: T | null` over `field?: T` throughout. Every interface in this plan uses explicit `| null`.
- **`noUncheckedIndexedAccess: true`.** `array[i]` has type `T | undefined`. Every index access must be narrowed before use.
- **2-space indentation, semicolons always**, including where optional.
- **`readonly` on interface fields and array types** for all parser data structures. They are values, not state.
- **Verification gate.** No task is complete until `npm run check` passes (`lint && typecheck && test`). Plan-final tasks additionally require `npm run build`.
- **Commit discipline.** Commit at the end of each task, and never push. Commits are signed automatically via the existing ssh config; a signing prompt may appear.
- **Corpus is read-only.** `fixtures/corpus/*.raw.txt` is committed input data. Never edit, reformat, deduplicate, or sort it. Tests read it; nothing writes it.

---

## File Structure

Created by this plan:

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.oxlintrc.json`, `.nvmrc` | toolchain |
| `next.config.ts`, `app/layout.tsx`, `app/page.tsx` | minimal Next.js app so the build has something to build |
| `drizzle.config.ts` | drizzle-kit configuration |
| `lib/db/schema.ts` | every table, in spec order |
| `lib/db/client.ts` | the Neon connection, one export |
| `lib/parse/types.ts` | `ParsedVideo` and its parts — the contract Plan 2 consumes |
| `lib/parse/normalize.ts` | input splitting, key derivation, match folding |
| `lib/parse/tokens.ts` | the closed vocabulary and its classifier |
| `lib/parse/boundary.ts` | the backwards walk: title end and release group |
| `lib/parse/markers.ts` | season/episode/date/disc marker detection |
| `lib/parse/video.ts` | assembles the above into a `ParsedVideo` |
| `test/parse/*.test.ts` | one test file per parser module |
| `test/corpus.test.ts` | parse-rate regression gate over the raw corpora |
| `test/golden.test.ts` | exact-expectation table test |
| `scripts/corpus-report.ts` | prints per-file parse rates; regenerates the baseline |
| `scripts/golden-generate.ts` | proposes golden entries from a stratified sample |
| `fixtures/corpus/baseline.json` | committed parse-rate floor |
| `fixtures/corpus/*.golden.jsonl` | reviewed exact expectations |

Deliberately **not** created here: anything under `app/api/`, `lib/providers/`, `lib/resolve/`, `lib/cache/`, `lib/auth/`, `lib/jobs/`. Those belong to Plans 2 and 3.

---

### Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `.nvmrc`, `tsconfig.json`, `.oxlintrc.json`, `next.config.ts`, `app/layout.tsx`, `app/page.tsx`, `.env.example`
- Modify: `.gitignore` (append `.next/`, `.env*.local`, `node_modules/`, `drizzle/meta/_journal.json` is NOT ignored)
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `npm run check` and `npm run build` scripts every later task depends on. No exported code.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "media-name-parser",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "oxlint",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\"",
    "check": "npm run lint && npm run typecheck && npm run test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "corpus": "node --import tsx scripts/corpus-report.ts"
  },
  "dependencies": {
    "@neondatabase/serverless": "^1.1.0",
    "better-auth": "^1.7.1",
    "drizzle-orm": "^0.45.2",
    "next": "^16.3.3",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "drizzle-kit": "^0.31.10",
    "oxlint": "^1.80.0",
    "tsx": "^4.20.0",
    "typescript": "^7.0.2"
  }
}
```

If `npm install` reports that a listed version does not exist, install the
nearest published version and record what you used in the commit message.
Do not silently downgrade a major version.

- [ ] **Step 2: Create `.nvmrc`, `tsconfig.json`, `.oxlintrc.json`**

`.nvmrc`:

```
26
```

`tsconfig.json` — note the differences from a Node-only config: `bundler`
resolution and `jsx: preserve` are required by Next.js, and imports are
therefore extensionless (no `allowImportingTsExtensions`).

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023", "dom", "dom.iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "types": ["node", "react"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "incremental": true,
    "resolveJsonModule": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "warn", "perf": "warn" },
  "rules": {
    "typescript/no-explicit-any": "error",
    "eslint/no-console": "off"
  },
  "ignorePatterns": ["**/.next/**", "**/node_modules/**", "**/drizzle/**"]
}
```

- [ ] **Step 3: Create the minimal Next.js app and `.env.example`**

`next.config.ts`:

```ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  typedRoutes: true,
};

export default config;
```

`app/layout.tsx`:

```tsx
import type { ReactNode } from 'react';

export const metadata = {
  title: 'media-name-parser',
  description: 'Filename to media identity lookup',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`:

```tsx
export default function Home() {
  return <main>media-name-parser</main>;
}
```

`.env.example`:

```
DATABASE_URL=
DATABASE_URL_UNPOOLED=
TMDB_API_KEY=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
CRON_SECRET=
LOOKUP_DEADLINE_MS=8000
STALE_AFTER_HOURS=12
CONFIDENCE_FLOOR=0.75
JOB_MAX_ATTEMPTS=6
```

- [ ] **Step 4: Append to `.gitignore`**

```
# Next.js
.next/
next-env.d.ts

# Local env
.env*.local
```

- [ ] **Step 5: Write a smoke test that proves the test runner works**

`test/smoke.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the corpus fixtures are present and non-empty', () => {
  const files = [
    'fixtures/corpus/movies.releases.raw.txt',
    'fixtures/corpus/movies.library.raw.txt',
    'fixtures/corpus/tv.releases.raw.txt',
    'fixtures/corpus/tv.library.raw.txt',
    'fixtures/corpus/tv.sport.raw.txt',
  ];
  let total = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length > 0, `${file} is empty`);
    total += lines.length;
  }
  assert.equal(total, 5951);
});
```

- [ ] **Step 6: Install and verify the whole toolchain**

```bash
npm install
npm run check
npm run build
```

Expected: `check` passes with 1 passing test; `build` completes and emits
`.next/`. If `tsc` complains about `next-env.d.ts` missing, run `npm run build`
once first — Next.js generates it.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .nvmrc tsconfig.json .oxlintrc.json \
        next.config.ts app .env.example .gitignore test/smoke.test.ts
git commit -m "Scaffold Next.js app with oxlint, tsc, and node:test"
```

---

### Task 2: Database schema and migrations

**Files:**
- Create: `lib/db/schema.ts`, `lib/db/client.ts`, `drizzle.config.ts`
- Test: `test/db/schema.test.ts`

**Interfaces:**
- Consumes: Task 1's toolchain.
- Produces, all consumed by Plan 2:
  - `lib/db/schema.ts` exports the tables `user`, `session`, `account`, `verification`, `apiKeys`, `rateLimitWindows`, `media`, `movieDetails`, `seriesDetails`, `seasonDetails`, `episodeDetails`, `bookDetails`, `sceneDetails`, `people`, `mediaPeople`, `parses`, `lookups`, `lookupJobs`, `providerCalls`, and the enums `categoryEnum`, `mediaKindEnum`, `providerEnum`, `personRoleEnum`, `lookupStateEnum`, `jobStateEnum`.

  - `lib/db/client.ts` exports `db` (a `NeonHttpDatabase<typeof schema>`) and `type Db = typeof db`.

**Why Better Auth's tables are hand-written here rather than CLI-generated.**
`@better-auth/cli generate` needs a configured `auth.ts`, which is Plan 3's
work. Writing the four tables by hand keeps the whole schema in one migration
and lets `api_keys.user_id` be a real foreign key from day one, and the
conformance test in Step 1 removes the risk that hand-writing them drifts from
what the library expects.

- [ ] **Step 1: Write the failing test**

This test asserts the schema's shape without needing a database, which keeps
it in the default suite. Connectivity is covered by Task 2's migration step
and by Plan 2's integration tests.

`test/db/schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getAuthTables } from 'better-auth/db';
import { admin } from 'better-auth/plugins';
import * as schema from '../../lib/db/schema';

test('every table named in the spec exists', () => {
  const expected = [
    'user', 'session', 'account', 'verification',
    'apiKeys', 'rateLimitWindows',
    'media', 'movieDetails', 'seriesDetails', 'seasonDetails', 'episodeDetails',
    'bookDetails', 'sceneDetails',
    'people', 'mediaPeople',
    'parses', 'lookups', 'lookupJobs', 'providerCalls',
  ];
  for (const name of expected) {
    assert.ok(name in schema, `schema is missing ${name}`);
  }
});

test('media has the natural key that makes upserts idempotent', () => {
  const config = getTableConfig(schema.media);
  const unique = config.uniqueConstraints.map((c) => c.columns.map((col) => col.name).sort().join(','));
  assert.ok(
    unique.includes('provider,provider_ref'),
    `expected a unique (provider, provider_ref); found ${JSON.stringify(unique)}`,
  );
});

test('lookups is unique on the literal input it was given', () => {
  const config = getTableConfig(schema.lookups);
  const unique = config.uniqueConstraints.map((c) => c.columns.map((col) => col.name).sort().join(','));
  assert.ok(unique.includes('category,name'), `found ${JSON.stringify(unique)}`);
});

test('the Better Auth tables match what the library expects', () => {
  // Better Auth owns these four tables' shape. Hand-writing them is a
  // deliberate trade (one migration, a real FK from api_keys), and this test
  // is what pays for it: a version bump that adds or renames a field fails
  // here rather than at runtime.
  const expected = getAuthTables({ plugins: [admin()] });
  // `unknown` here is the structural-comparison exception from Global
  // Constraints: these values only ever reach getTableConfig.
  const ours: Readonly<Record<string, unknown>> = {
    user: schema.user,
    session: schema.session,
    account: schema.account,
    verification: schema.verification,
  };
  const toSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  for (const [key, definition] of Object.entries(expected)) {
    const table = ours[key];
    assert.notEqual(table, undefined, `Better Auth expects a '${key}' table the schema does not define`);
    if (table === undefined) continue;
    const config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
    const columns = new Set(config.columns.map((c) => c.name));
    assert.ok(columns.has('id'), `${key} has no id column`);
    for (const [field, spec] of Object.entries(definition.fields)) {
      const column = toSnake(field);
      assert.ok(
        columns.has(column),
        `${key}.${field} (expected column '${column}', type ${String(spec.type)}) is missing`,
      );
    }
  }
});

test('user.role is text, not an enum, so the admin plugin can use it', () => {
  const config = getTableConfig(schema.user);
  const role = config.columns.find((c) => c.name === 'role');
  assert.notEqual(role, undefined, 'user has no role column');
  assert.equal(role?.getSQLType(), 'text');
});

test('api_keys.user_id matches Better Auth\'s text id type', () => {
  const config = getTableConfig(schema.apiKeys);
  const userId = config.columns.find((c) => c.name === 'user_id');
  assert.equal(userId?.getSQLType(), 'text');
});

test('parses is keyed on category and normalized_key together', () => {
  const config = getTableConfig(schema.parses);
  const pk = config.primaryKeys[0];
  assert.ok(pk !== undefined, 'parses has no composite primary key');
  const cols = pk.columns.map((c) => c.name).sort().join(',');
  assert.equal(cols, 'category,normalized_key');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run test -- --test-name-pattern="table named in the spec"
```

Expected: FAIL — cannot resolve `../../lib/db/schema`.

- [ ] **Step 3: Write `lib/db/schema.ts`**

```ts
import {
  boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, real,
  text, timestamp, uniqueIndex, unique, uuid,
} from 'drizzle-orm/pg-core';

export const categoryEnum = pgEnum('category', ['tv', 'movies', 'books', 'xxx']);
export const mediaKindEnum = pgEnum('media_kind', [
  'movie', 'series', 'season', 'episode', 'book', 'scene',
]);
export const providerEnum = pgEnum('provider', ['tmdb', 'ibdb', 'tpdb']);
export const personRoleEnum = pgEnum('person_role', [
  'performer', 'director', 'producer', 'writer', 'author', 'illustrator', 'narrator',
]);
export const lookupStateEnum = pgEnum('lookup_state', ['resolved', 'unresolved', 'pending']);
export const jobStateEnum = pgEnum('job_state', ['pending', 'running', 'abandoned']);

// --- identity (Better Auth core plus the admin plugin) ----------------------
//
// Shapes and names are dictated by Better Auth, not chosen: singular table
// names, `text` primary keys because it generates its own string ids, a
// BOOLEAN `emailVerified`, and a `session` with both an `id` and a unique
// `token`. `role` is text rather than an enum because the admin plugin treats
// it as a string and supports comma-separated multiple roles.
// `test/db/schema.test.ts` checks all four against `getAuthTables()`.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('session_token_idx').on(t.token),
  index('session_user_idx').on(t.userId),
]);

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('account_user_idx').on(t.userId)]);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('verification_identifier_idx').on(t.identifier)]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  prefix: text('prefix').notNull(),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(60),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('api_keys_token_hash_idx').on(t.tokenHash), index('api_keys_user_idx').on(t.userId)]);

export const rateLimitWindows = pgTable('rate_limit_windows', {
  apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id, { onDelete: 'cascade' }),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.apiKeyId, t.windowStart] })]);

// --- media -----------------------------------------------------------------

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: categoryEnum('category').notNull(),
  kind: mediaKindEnum('kind').notNull(),
  parentId: uuid('parent_id'),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  originalTitle: text('original_title'),
  releaseDate: date('release_date'),
  year: integer('year'),
  overview: text('overview'),
  provider: providerEnum('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  raw: jsonb('raw').notNull(),
  rawFetchedAt: timestamp('raw_fetched_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('media_provider_ref_key').on(t.provider, t.providerRef),
  index('media_category_kind_idx').on(t.category, t.kind),
  index('media_parent_idx').on(t.parentId),
  index('media_sort_title_idx').on(t.sortTitle),
]);

export const movieDetails = pgTable('movie_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  runtimeMinutes: integer('runtime_minutes'),
  imdbId: text('imdb_id'),
  tagline: text('tagline'),
  collectionName: text('collection_name'),
});

export const seriesDetails = pgTable('series_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  firstAirDate: date('first_air_date'),
  lastAirDate: date('last_air_date'),
  status: text('status'),
});

export const seasonDetails = pgTable('season_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  seasonNumber: integer('season_number').notNull(),
});

export const episodeDetails = pgTable('episode_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  seasonNumber: integer('season_number').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  airDate: date('air_date'),
});

export const bookDetails = pgTable('book_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  isbn13: text('isbn13'),
  isbn10: text('isbn10'),
  publisher: text('publisher'),
  publishedOn: date('published_on'),
  pageCount: integer('page_count'),
  language: text('language'),
});

export const sceneDetails = pgTable('scene_details', {
  mediaId: uuid('media_id').primaryKey().references(() => media.id, { onDelete: 'cascade' }),
  siteName: text('site_name'),
  durationSeconds: integer('duration_seconds'),
  releasedOn: date('released_on'),
});

export const people = pgTable('people', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: providerEnum('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  name: text('name').notNull(),
  sortName: text('sort_name').notNull(),
  aliases: text('aliases').array().notNull().default([]),
  birthdate: date('birthdate'),
  raw: jsonb('raw').notNull(),
  rawFetchedAt: timestamp('raw_fetched_at', { withTimezone: true }).notNull(),
}, (t) => [
  unique('people_provider_ref_key').on(t.provider, t.providerRef),
  index('people_sort_name_idx').on(t.sortName),
]);

export const mediaPeople = pgTable('media_people', {
  mediaId: uuid('media_id').notNull().references(() => media.id, { onDelete: 'cascade' }),
  personId: uuid('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  role: personRoleEnum('role').notNull(),
  characterName: text('character_name').notNull().default(''),
  billingOrder: integer('billing_order'),
}, (t) => [
  primaryKey({ columns: [t.mediaId, t.personId, t.role, t.characterName] }),
  index('media_people_person_idx').on(t.personId),
]);

// --- cache -----------------------------------------------------------------

export const parses = pgTable('parses', {
  category: categoryEnum('category').notNull(),
  normalizedKey: text('normalized_key').notNull(),
  tokens: jsonb('tokens').notNull(),
  parserVersion: integer('parser_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.category, t.normalizedKey] })]);

export const lookups = pgTable('lookups', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: categoryEnum('category').notNull(),
  name: text('name').notNull(),
  normalizedKey: text('normalized_key').notNull(),
  mediaId: uuid('media_id').references(() => media.id, { onDelete: 'set null' }),
  confidence: real('confidence'),
  pinned: boolean('pinned').notNull().default(false),
  state: lookupStateEnum('state').notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('lookups_category_name_key').on(t.category, t.name),
  index('lookups_parse_idx').on(t.category, t.normalizedKey),
  index('lookups_state_idx').on(t.state, t.lastAttemptAt),
]);

export const lookupJobs = pgTable('lookup_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  lookupId: uuid('lookup_id').notNull().references(() => lookups.id, { onDelete: 'cascade' }),
  state: jobStateEnum('state').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('lookup_jobs_lookup_idx').on(t.lookupId),
  index('lookup_jobs_due_idx').on(t.state, t.nextAttemptAt),
]);

export const providerCalls = pgTable('provider_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: providerEnum('provider').notNull(),
  endpoint: text('endpoint').notNull(),
  status: integer('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  lookupId: uuid('lookup_id').references(() => lookups.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('provider_calls_created_idx').on(t.createdAt)]);
```

`media.parentId` is declared without a `.references()` call because
Drizzle cannot express a self-reference inline without a circular type. Add
the constraint in the generated SQL in Step 5.

- [ ] **Step 4: Write `lib/db/client.ts` and `drizzle.config.ts`**

`lib/db/client.ts`:

```ts
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error('DATABASE_URL is not set');
}

export const db = drizzle(neon(url), { schema });
export type Db = typeof db;
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 5: Generate the migration and add the self-reference**

```bash
npm run db:generate
```

Then append to the newly generated file in `drizzle/`:

```sql
ALTER TABLE "media"
  ADD CONSTRAINT "media_parent_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "media"("id") ON DELETE CASCADE;
```

Also append the composite foreign key from `lookups` to `parses`, which
Drizzle does not infer because the columns are declared separately:

```sql
ALTER TABLE "lookups"
  ADD CONSTRAINT "lookups_parse_fk"
  FOREIGN KEY ("category", "normalized_key")
  REFERENCES "parses"("category", "normalized_key") ON DELETE RESTRICT;
```

- [ ] **Step 6: Apply the migration to a scratch Neon branch and verify**

```bash
# Requires DATABASE_URL_UNPOOLED for a branch you can safely destroy.
npm run db:migrate
psql "$DATABASE_URL_UNPOOLED" -c "\d media" -c "\d lookups" -c "\d parses"
```

Expected: `media` shows `media_provider_ref_key` and `media_parent_id_fk`;
`lookups` shows `lookups_category_name_key` and `lookups_parse_fk`; `parses`
shows a composite primary key on `(category, normalized_key)`.

- [ ] **Step 7: Verify and commit**

```bash
npm run check
git add lib/db drizzle drizzle.config.ts test/db package.json
git commit -m "Add the full schema for all four categories

Detail tables for books and scenes ship now though nothing populates
them yet, so those slices add no migration to a shared table.

The four Better Auth tables are hand-written rather than generated,
because the CLI needs an auth.ts that does not exist until plan 3.
A conformance test against getAuthTables() is what makes that safe."
```

---
### Task 3: Input splitting and key normalization

**Files:**
- Create: `lib/parse/normalize.ts`
- Test: `test/parse/normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MEDIA_EXTENSIONS: ReadonlySet<string>`, `SIDECAR_EXTENSIONS: ReadonlySet<string>`
  - `interface SplitInput { readonly stem: string; readonly extension: string | null; readonly ancestors: readonly string[]; readonly isMedia: boolean }` — `ancestors` is ordered nearest-first
  - `splitInput(input: string): SplitInput`
  - `normalizeKey(input: string): string` — used by Plan 2 as the `parses` and `lookups` key
  - `foldForMatch(text: string): string` — used by Plan 2's confidence scorer

- [ ] **Step 1: Write the failing test**

Every input below is a verbatim line from `fixtures/corpus/`.

`test/parse/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInput, normalizeKey, foldForMatch } from '../../lib/parse/normalize';

test('splitInput separates stem, extension, and ancestors nearest-first', () => {
  const got = splitInput('Movies/Interstellar (2014)/00136.m2ts');
  assert.equal(got.stem, '00136');
  assert.equal(got.extension, 'm2ts');
  assert.deepEqual(got.ancestors, ['Interstellar (2014)', 'Movies']);
  assert.equal(got.isMedia, true);
});

test('splitInput handles a bare release name with no directories', () => {
  const got = splitInput('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  assert.equal(got.stem, 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.equal(got.extension, 'nzb');
  assert.deepEqual(got.ancestors, []);
  assert.equal(got.isMedia, true);
});

test('a dotfile is not an extension and is not media', () => {
  const got = splitInput('TV Shows/Moon Knight/.plexmatch');
  assert.equal(got.stem, '.plexmatch');
  assert.equal(got.extension, null);
  assert.equal(got.isMedia, false);
});

test('a sidecar file is recognised but is not media', () => {
  const got = splitInput('TV Shows/Moon Knight/Season 1/Moon Knight - S01E01.srt');
  assert.equal(got.extension, 'srt');
  assert.equal(got.isMedia, false);
});

test('iso, m2ts and nzb all count as media', () => {
  for (const ext of ['iso', 'm2ts', 'nzb', 'mkv', 'mp4']) {
    assert.equal(splitInput(`Something.2020.${ext}`).isMedia, true, ext);
  }
});

test('the two real spellings of Outbreak 1995 share one normalized key', () => {
  const dotted = normalizeKey('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const spaced = normalizeKey('Outbreak 1995 1080p BluRay REMUX AVC DTS-HD-MA 5 1-UnKn0wn.nzb');
  assert.equal(dotted, spaced);
  assert.equal(dotted, 'outbreak 1995 1080p bluray remux avc dts hd ma 5 1 unkn0wn');
});

test('normalizeKey strips bracketing so a bracketed year matches a bare one', () => {
  assert.equal(
    normalizeKey('Cold.Storage.[2026].[1080p.BluRay.x265.SDR.DDP.Atmos.7.1.English-DarQ.HONE].nzb'),
    'cold storage 2026 1080p bluray x265 sdr ddp atmos 7 1 english darq hone',
  );
});

test('normalizeKey keeps directory structure so two shows never collide', () => {
  const a = normalizeKey('TV Shows/Ghosts (US)/Season 5/Ghosts (US) - S05E12 - The List WEBRip-1080p.mkv');
  const b = normalizeKey('TV Shows/Ghosts (2019)/Season 5/Ghosts (2019) - S05E12 - The List WEBRip-1080p.mkv');
  assert.notEqual(a, b);
  assert.equal(a, 'tv shows/ghosts us/season 5/ghosts us s05e12 the list webrip 1080p');
});

test('foldForMatch removes diacritics, apostrophes and stray punctuation', () => {
  assert.equal(foldForMatch('90 Day Fiancé'), '90 day fiance');
  assert.equal(foldForMatch('What If…!'), 'what if');
  assert.equal(foldForMatch("The Hitchhiker's Guide to the Galaxy"), 'the hitchhikers guide to the galaxy');
  assert.equal(foldForMatch('Marvel’s Agents of S.H.I.E.L.D'), 'marvels agents of s h i e l d');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run test -- --test-name-pattern="splitInput separates"
```

Expected: FAIL — cannot resolve `../../lib/parse/normalize`.

- [ ] **Step 3: Write the implementation**

`lib/parse/normalize.ts`:

```ts
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'mkv', 'mp4', 'avi', 'wmv', 'mov', 'm4v', 'mpg', 'mpeg', 'flv', 'ts',
  'webm', 'iso', 'm2ts', 'nzb',
]);

/**
 * Recognised in order to refuse. A subtitle or a Plex sidecar is not a
 * lookup failure — refusing it is the correct answer — so these are named
 * rather than left to fall through as unknown.
 */
export const SIDECAR_EXTENSIONS: ReadonlySet<string> = new Set([
  'nfo', 'srt', 'sub', 'idx', 'ass', 'ssa', 'vtt', 'txt', 'jpg', 'jpeg',
  'png', 'webp', 'plexmatch', 'md5', 'sfv', 'par2',
]);

export interface SplitInput {
  readonly stem: string;
  readonly extension: string | null;
  /** Nearest directory first, so `ancestors[0]` is the containing folder. */
  readonly ancestors: readonly string[];
  readonly isMedia: boolean;
}

export function splitInput(input: string): SplitInput {
  const segments = input.split('/').filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? '';
  const ancestors = segments.slice(0, -1).reverse();
  const dot = basename.lastIndexOf('.');
  // A dot at index 0 is a dotfile, not an extension.
  if (dot <= 0) {
    return { stem: basename, extension: null, ancestors, isMedia: false };
  }
  const extension = basename.slice(dot + 1).toLowerCase();
  return {
    stem: basename.slice(0, dot),
    extension,
    ancestors,
    isMedia: MEDIA_EXTENSIONS.has(extension),
  };
}

const BRACKETS = /[[\](){}]/g;
const SEPARATORS = /[._\s-]+/g;

function normalizeSegment(segment: string): string {
  return segment
    .normalize('NFC')
    .toLowerCase()
    .replace(BRACKETS, ' ')
    .replace(SEPARATORS, ' ')
    .trim();
}

/**
 * The cache key. Directory structure is preserved (normalized per segment,
 * rejoined with `/`) because two different shows can own the same basename;
 * within a segment, separators and bracketing are flattened so that a dotted
 * and a space-separated spelling of one release collapse to the same key.
 */
export function normalizeKey(input: string): string {
  const split = splitInput(input);
  const ordered = [...split.ancestors].reverse();
  return [...ordered, split.stem]
    .map(normalizeSegment)
    .filter((part) => part.length > 0)
    .join('/');
}

const DIACRITICS = /\p{Diacritic}/gu;
const APOSTROPHES = /['‘’`]/g;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/**
 * For comparing a parsed title against a provider's. Diacritics are folded
 * and apostrophes dropped so that `90 Day Fiance` matches `90 Day Fiancé`.
 * Never use this for a stored title — it is lossy on purpose.
 */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(APOSTROPHES, '')
    .toLowerCase()
    .replace(NON_ALNUM, ' ')
    .trim();
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- --test-name-pattern="normalize|splitInput|foldForMatch|Outbreak|bracketing|directory structure|dotfile|sidecar|iso, m2ts"
```

Expected: all PASS. If the Outbreak assertion fails, print both keys and
compare character by character — the two corpus lines differ only in
separators, so any difference is a bug in `normalizeSegment`.

- [ ] **Step 5: Verify and commit**

```bash
npm run check
git add lib/parse/normalize.ts test/parse/normalize.test.ts
git commit -m "Add input splitting and cache-key normalization

The Outbreak 1995 pair is a real corpus duplicate, one dotted and one
space-separated, so sibling adoption has a natural test rather than a
synthetic one."
```

---

### Task 4: Token vocabulary and tokenizer

**Files:**
- Create: `lib/parse/tokens.ts`
- Test: `test/parse/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TokenClass = 'resolution' | 'source' | 'videoCodec' | 'audioCodec' | 'hdr' | 'language' | 'edition' | 'streaming' | 'threeD' | 'ancillary'`
  - `tokenize(text: string): readonly string[]`
  - `classifyToken(token: string): TokenClass | null`
  - `isJunk(token: string): boolean`
  - `splitGroupSuffix(token: string): { readonly head: string; readonly group: string } | null`
  - `expandCompound(token: string): readonly string[]`

**Why the tokenizer is not a plain `split`.** Three corpus facts make a naive
split on `.` wrong. `DTS-HD.MA.5.1` must not yield bare `5` and `1`, because a
bare digit would then have to be junk — and that would eat the `3` in
`Super.Mario.Bros.3`. `H.264` must survive as one token. And
`Marvel's Agents of S.H.I.E.L.D` in scene form is a run of single letters that
is a word, not eleven separators.

- [ ] **Step 1: Write the failing test**

`test/parse/tokens.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, classifyToken, isJunk, splitGroupSuffix, expandCompound } from '../../lib/parse/tokens';

test('an audio channel layout stays one token', () => {
  assert.deepEqual(
    tokenize('DTS-HD.MA.5.1'),
    ['DTS-HD', 'MA', '5.1'],
  );
});

test('a channel layout fused to a group suffix stays one token', () => {
  const got = tokenize('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.deepEqual(
    got,
    ['Outbreak', '1995', '1080p', 'BluRay', 'REMUX', 'AVC', 'DTS-HD-MA', '5.1-UnKn0wn'],
  );
});

test('a bare digit that is part of a title is left alone', () => {
  const got = tokenize('The.Adventures.of.Super.Mario.Bros.3.FULLSCREEN.DISC3.NTSC.USA.DVD5-AndreMor');
  assert.ok(got.includes('3'), `expected a standalone '3' in ${JSON.stringify(got)}`);
  assert.equal(isJunk('3'), false);
});

test('a codec written with a dot stays one token', () => {
  assert.deepEqual(tokenize('AAC2.0.H.264'), ['AAC2.0', 'H.264']);
});

test('an acronym run of single letters is rejoined', () => {
  assert.deepEqual(
    tokenize('Marvels.Agents.of.S.H.I.E.L.D.S01E01'),
    ['Marvels', 'Agents', 'of', 'S.H.I.E.L.D', 'S01E01'],
  );
});

test('every quality class is recognised', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['2160p', 'resolution'], ['1080p', 'resolution'], ['480p', 'resolution'],
    ['BluRay', 'source'], ['Blu-ray', 'source'], ['WEB-DL', 'source'],
    ['WEBDL', 'source'], ['WEBRip', 'source'], ['HDTV', 'source'],
    ['DVD9', 'source'], ['REMUX', 'source'], ['Satfeed', 'source'],
    ['UHD', 'source'],
    ['x265', 'videoCodec'], ['H.264', 'videoCodec'], ['HEVC', 'videoCodec'],
    ['AVC', 'videoCodec'],
    ['DTS-HD', 'audioCodec'], ['TrueHD7.1', 'audioCodec'], ['Atmos', 'audioCodec'],
    ['DDP', 'audioCodec'], ['DD+Atmos', 'audioCodec'], ['AAC2.0', 'audioCodec'],
    ['5.1', 'audioCodec'], ['MA', 'audioCodec'],
    ['HDR10+', 'hdr'], ['DoVi', 'hdr'], ['DV', 'hdr'], ['SDR', 'hdr'], ['10bit', 'hdr'],
    ['MULTi', 'language'], ['NORDiC', 'language'], ['VFI', 'language'],
    ['MultiSubs', 'language'], ['DUAL', 'language'], ['German', 'language'],
    ['REPACK', 'edition'], ['Unrated', 'edition'], ['FULLSCREEN', 'edition'],
    ['WIDESCREEN', 'edition'], ['Proper', 'edition'], ['forced', 'edition'],
    ['NF', 'streaming'], ['AMZN', 'streaming'], ['MAX', 'streaming'],
    ['DSNP', 'streaming'], ['OSN', 'streaming'], ['RTLP', 'streaming'],
    ['3D', 'threeD'], ['Half-SBS', 'threeD'], ['RBG', 'threeD'],
    ['NTSC', 'ancillary'], ['USA', 'ancillary'], ['HYBRID', 'ancillary'],
    ['60fps', 'ancillary'],
  ];
  for (const [token, expected] of cases) {
    assert.equal(classifyToken(token), expected, `${token} classified wrongly`);
  }
});

test('a title word is not junk', () => {
  for (const token of ['Outbreak', 'Interstellar', 'Wick', 'Prodigy', 'Ghosts', '3', 'Jedi']) {
    assert.equal(isJunk(token), false, `${token} was treated as junk`);
  }
});

test('splitGroupSuffix finds the group hiding behind a junk token', () => {
  assert.deepEqual(splitGroupSuffix('5.1-UnKn0wn'), { head: '5.1', group: 'UnKn0wn' });
  assert.deepEqual(splitGroupSuffix('5.1-FraMeSToR'), { head: '5.1', group: 'FraMeSToR' });
  assert.deepEqual(splitGroupSuffix('DUAL-LACTATO'), { head: 'DUAL', group: 'LACTATO' });
  assert.deepEqual(splitGroupSuffix('Atmos-3L'), { head: 'Atmos', group: '3L' });
  assert.deepEqual(splitGroupSuffix('English-DarQ'), { head: 'English', group: 'DarQ' });
});

test('splitGroupSuffix refuses a hyphenated token that is entirely vocabulary', () => {
  // WEB-DL and DTS-HD are single source/codec names, not group suffixes.
  assert.equal(splitGroupSuffix('WEB-DL'), null);
  assert.equal(splitGroupSuffix('DTS-HD'), null);
  assert.equal(splitGroupSuffix('Blu-ray'), null);
  assert.equal(splitGroupSuffix('Half-SBS'), null);
});

test('a Sonarr Source-Resolution pair is vocabulary, not a group suffix', () => {
  for (const token of ['Bluray-2160p', 'HDTV-720p', 'WEBDL-1080p', 'WEBRip-1080p']) {
    assert.equal(classifyToken(token), 'source', `${token} should classify as a source`);
    assert.equal(splitGroupSuffix(token), null, `${token} is not a group suffix`);
  }
});

test('expandCompound splits a junk pair and leaves everything else alone', () => {
  assert.deepEqual(expandCompound('Bluray-2160p'), ['Bluray', '2160p']);
  assert.deepEqual(expandCompound('HDTV-720p'), ['HDTV', '720p']);
  assert.deepEqual(expandCompound('5.1-UnKn0wn'), ['5.1-UnKn0wn']);
  assert.deepEqual(expandCompound('Wick-Chapter'), ['Wick-Chapter']);
  assert.deepEqual(expandCompound('Outbreak'), ['Outbreak']);
});

test('splitGroupSuffix refuses a hyphen inside a title', () => {
  // 'Wick' is not vocabulary, so 'Wick-Chapter' is a title fragment.
  assert.equal(splitGroupSuffix('Wick-Chapter'), null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run test -- --test-name-pattern="audio channel layout stays one token"
```

Expected: FAIL — cannot resolve `../../lib/parse/tokens`.

- [ ] **Step 3: Write the implementation**

`lib/parse/tokens.ts`:

```ts
export type TokenClass =
  | 'resolution'
  | 'source'
  | 'videoCodec'
  | 'audioCodec'
  | 'hdr'
  | 'language'
  | 'edition'
  | 'streaming'
  | 'threeD'
  | 'ancillary';

const SOURCE = new Set([
  'WEB-DL', 'WEBDL', 'WEB', 'WEBRIP', 'WEB-RIP', 'SITERIP', 'BLURAY', 'BLU-RAY',
  'BDRIP', 'BRRIP', 'DVDRIP', 'HDTV', 'AHDTV', 'SDTV', 'PDTV', 'DVD', 'DVD5',
  'DVD9', 'DVDR', 'REMUX', 'SATFEED', 'LIVESTREAM', 'UHD', 'HDDVD', 'VHS',
  'SCREENER', 'CAM', 'TS', 'COMPLETE',
]);

const VIDEO_CODEC = new Set([
  'X264', 'X265', 'H264', 'H265', 'H.264', 'H.265', 'HEVC', 'AVC', 'AV1',
  'XVID', 'DIVX', 'VP9', 'MPEG2',
]);

const AUDIO_CODEC = new Set([
  'AAC', 'AC3', 'EAC3', 'DD', 'DDP', 'DD+', 'DTS', 'DTS-HD', 'DTS-HD-MA',
  'DTSHD', 'DTS-X', 'DTSX', 'TRUEHD', 'ATMOS', 'FLAC', 'OPUS', 'MP3', 'LPCM',
  'PCM', 'MA', 'AAC2', 'DDP2',
]);

const HDR = new Set([
  'HDR', 'HDR10', 'HDR10+', 'DV', 'DOVI', 'SDR', '10BIT', '8BIT', '10BITS', 'HLG',
]);

const LANGUAGE = new Set([
  'MULTI', 'DUAL', 'DUAL-AUDIO', 'NORDIC', 'VFI', 'VFF', 'VOSTFR', 'MULTISUBS',
  'MULTIAUDIOS', 'SUBBED', 'DUBBED', 'DUB', 'ENGLISH', 'FRENCH', 'GERMAN',
  'SPANISH', 'ITALIAN', 'RUSSIAN', 'DUTCH', 'JAPANESE', 'POLISH', 'CZECH',
  'ARABIC', 'PT-BR', 'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JPN',
]);

const EDITION = new Set([
  'REPACK', 'PROPER', 'INTERNAL', 'UNRATED', 'UNCUT', 'UNCENSORED', 'EXTENDED',
  'REMASTERED', 'REMASTER', 'DIRECTORS', 'DIRECTORSCUT', 'SPECIAL', 'EDITION',
  'EDITIONS', 'FULLSCREEN', 'WIDESCREEN', 'FORCED', 'LIMITED', 'THEATRICAL',
  'SPEC', 'IMAX',
]);

const STREAMING = new Set([
  'NF', 'AMZN', 'MAX', 'HMAX', 'DSNP', 'OSN', 'PCOK', 'RTLP', 'TNAP', 'YT',
  'ATVP', 'HULU', 'STAN', 'CRAV', 'IP', 'CR', 'RED', 'ROKU', 'PMTP', 'SHO',
]);

const THREE_D = new Set([
  '3D', 'SBS', 'HALF-SBS', 'HALF-OU', 'OU', 'RBG', 'MVC', 'ANAGLYPH',
]);

const ANCILLARY = new Set([
  'NTSC', 'PAL', 'USA', 'HYBRID', 'DEF', 'HQ', 'LQ', 'SD', 'HD', 'FHD',
  'RERIP', 'READNFO', 'DL',
]);

const RESOLUTION = /^\d{3,4}[pi]$/i;
const FRAMERATE = /^\d{2,3}fps$/i;
// Must require the dot: a lone digit is never vocabulary, or the `3` in
// `Super.Mario.Bros.3` would be eaten as a channel count.
const CHANNELS = /^[1-9]\.[0-9]$/;
const CHANNEL_SUFFIX = /[.]?[1-9]\.[0-9]$/;
const TRAILING_DIGITS = /\d+$/;

function canonical(token: string): string {
  return token.toUpperCase();
}

export function classifyToken(token: string): TokenClass | null {
  if (token.length === 0) return null;
  const upper = canonical(token);
  if (RESOLUTION.test(token)) return 'resolution';
  // Sonarr writes quality as `Source-Resolution`: `Bluray-2160p`, `HDTV-720p`,
  // `WEBDL-1080p`. When every hyphen part is vocabulary the whole token is
  // too, and it takes the class of its first part. A token with a
  // non-vocabulary part is left alone, so `Wick-Chapter` and `5.1-UnKn0wn`
  // fall through.
  if (token.includes('-') && !SOURCE.has(upper) && !AUDIO_CODEC.has(upper) && !THREE_D.has(upper)) {
    const parts = token.split('-');
    if (parts.length > 1 && parts.every((part) => part.length > 0 && classifyToken(part) !== null)) {
      const first = parts[0];
      if (first !== undefined) return classifyToken(first);
    }
  }
  if (FRAMERATE.test(token)) return 'ancillary';
  if (SOURCE.has(upper)) return 'source';
  if (VIDEO_CODEC.has(upper)) return 'videoCodec';
  if (AUDIO_CODEC.has(upper)) return 'audioCodec';
  if (HDR.has(upper)) return 'hdr';
  if (LANGUAGE.has(upper)) return 'language';
  if (EDITION.has(upper)) return 'edition';
  if (STREAMING.has(upper)) return 'streaming';
  if (THREE_D.has(upper)) return 'threeD';
  if (ANCILLARY.has(upper)) return 'ancillary';
  // `5.1`, `7.1`, `2.0` standing alone.
  if (CHANNELS.test(token)) return 'audioCodec';
  // `TrueHD7.1`, `AAC2.0`, `DDP2`: a vocabulary word wearing a channel layout
  // or trailing digits.
  const base = upper.replace(CHANNEL_SUFFIX, '').replace(TRAILING_DIGITS, '');
  if (base.length > 1 && AUDIO_CODEC.has(base)) return 'audioCodec';
  // `DD+Atmos`: two names joined by a plus.
  for (const part of upper.split('+')) {
    if (part.length > 1 && AUDIO_CODEC.has(part)) return 'audioCodec';
  }
  return null;
}

/**
 * A junk compound split into its parts, so that `Bluray-2160p` contributes
 * both a source and a resolution. Anything else is returned unchanged.
 */
export function expandCompound(token: string): readonly string[] {
  if (!token.includes('-')) return [token];
  const parts = token.split('-');
  if (parts.length < 2) return [token];
  if (!parts.every((part) => part.length > 0 && classifyToken(part) !== null)) return [token];
  return parts;
}

export function isJunk(token: string): boolean {
  return classifyToken(token) !== null;
}

/**
 * A group name hiding after a hyphen on an otherwise-junk token, as in
 * `5.1-UnKn0wn` or `DUAL-LACTATO`. Returns null in three cases: the whole
 * token is one vocabulary word (`WEB-DL`); the left side is not vocabulary,
 * so the hyphen is inside a title (`Wick-Chapter`); or the right side is also
 * vocabulary, so this is a Sonarr quality pair and not a group at all
 * (`Bluray-2160p`).
 */
export function splitGroupSuffix(token: string): { readonly head: string; readonly group: string } | null {
  if (isJunk(token)) return null;
  const hyphen = token.indexOf('-');
  if (hyphen <= 0 || hyphen === token.length - 1) return null;
  const head = token.slice(0, hyphen);
  const group = token.slice(hyphen + 1);
  if (!isJunk(head)) return null;
  if (isJunk(group)) return null;
  return { head, group };
}

const SEPARATOR = /[._\s]+/;

function isSingleLetter(part: string): boolean {
  return part.length === 1 && /\p{L}/u.test(part);
}

function endsWithDigit(part: string): boolean {
  return /\d$/.test(part);
}

/** A part that begins with exactly one digit, e.g. `1`, `1-FraMeSToR`, `0`. */
function beginsWithLoneDigit(part: string): boolean {
  return /^\d(?!\d)/.test(part);
}

export function tokenize(text: string): readonly string[] {
  const raw = text.split(SEPARATOR).filter((part) => part.length > 0);

  // Pass 1: rejoin runs of three or more single letters into one acronym.
  const acronyms: string[] = [];
  for (let i = 0; i < raw.length; ) {
    let run = 0;
    while (i + run < raw.length && isSingleLetter(raw[i + run] ?? '')) run += 1;
    if (run >= 3) {
      acronyms.push(raw.slice(i, i + run).join('.'));
      i += run;
      continue;
    }
    const part = raw[i];
    if (part !== undefined) acronyms.push(part);
    i += 1;
  }

  // Pass 2: rejoin `H` + `264` into `H.264`.
  const codecs: string[] = [];
  for (let i = 0; i < acronyms.length; i += 1) {
    const part = acronyms[i];
    const next = acronyms[i + 1];
    if (part !== undefined && next !== undefined && isSingleLetter(part) && /^\d{3}$/.test(next)) {
      codecs.push(`${part}.${next}`);
      i += 1;
      continue;
    }
    if (part !== undefined) codecs.push(part);
  }

  // Pass 3: rejoin a digit-terminated part with a following lone digit, so
  // `MA` `5` `1` becomes `MA` `5.1` and `AAC2` `0` becomes `AAC2.0`.
  const merged: string[] = [];
  for (let i = 0; i < codecs.length; i += 1) {
    const part = codecs[i];
    const next = codecs[i + 1];
    if (
      part !== undefined && next !== undefined &&
      endsWithDigit(part) && beginsWithLoneDigit(next) &&
      part.length <= 12
    ) {
      merged.push(`${part}.${next}`);
      i += 1;
      continue;
    }
    if (part !== undefined) merged.push(part);
  }

  return merged;
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/parse/tokens.test.ts
```

Expected: all PASS. If `tokenize` on `DTS-HD.MA.5.1` yields `5` and `1`
separately, pass 3's `beginsWithLoneDigit` is rejecting `1` — check the
negative lookahead. If a lone `3` comes back as junk, `CHANNELS` has been
loosened to allow a bare digit; it must require the dot, because pass 3 has
already fused every genuine channel count into `5.1` shape by the time
classification runs.

- [ ] **Step 5: Verify and commit**

```bash
npm run check
git add lib/parse/tokens.ts test/parse/tokens.test.ts
git commit -m "Add the token vocabulary and a context-aware tokenizer

Splitting on dots naively would make bare digits junk, which eats the
3 in Super.Mario.Bros.3. Channel layouts are fused during tokenization
instead, so a lone digit is never vocabulary."
```

---
### Task 5: Marker detection

**Files:**
- Create: `lib/parse/markers.ts`
- Test: `test/parse/markers.test.ts`

**Interfaces:**
- Consumes: nothing. Markers are found on the raw stem string, before
  tokenization, so that a season-slot date like `S2026.08.25` is read as one
  thing rather than three tokens.
- Produces:
  - `type Marker` — the discriminated union below, every variant carrying
    `start` and `end` character offsets into the stem
  - `findMarker(stem: string): Marker | null`
  - `PARSER_VERSION: number` (starts at `1`) — Plan 2 writes this to
    `parses.parser_version`

```ts
type Marker =
  | { readonly kind: 'episode'; readonly season: number; readonly episodes: readonly number[];
      readonly yearSeason: boolean; readonly start: number; readonly end: number }
  | { readonly kind: 'season'; readonly season: number; readonly yearSeason: boolean;
      readonly start: number; readonly end: number }
  | { readonly kind: 'disc'; readonly season: number | null; readonly disc: number;
      readonly start: number; readonly end: number }
  | { readonly kind: 'date'; readonly date: string; readonly start: number; readonly end: number }
  | { readonly kind: 'absolute'; readonly episode: number; readonly start: number; readonly end: number };
```

- [ ] **Step 1: Write the failing test**

Every stem below is a verbatim corpus line with its extension removed.

`test/parse/markers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMarker } from '../../lib/parse/markers';

test('a plain SxxExx marker', () => {
  const got = findMarker('The.Great.British.Sewing.Bee.S12E07.1080p.HDTV.H264-FTP');
  assert.deepEqual(got, {
    kind: 'episode', season: 12, episodes: [7], yearSeason: false, start: 29, end: 35,
  });
});

test('a hyphenated episode range expands to every episode it covers', () => {
  const got = findMarker('Star Trek - Prodigy - S02E01-E02 - Into the Breach Bluray-1080p Remux');
  assert.equal(got?.kind, 'episode');
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [1, 2]);
  assert.equal(got?.kind === 'episode' ? got.season : null, 2);
});

test('a repeated-E multi-episode marker expands too', () => {
  const got = findMarker('Show.Name.S02E04E05.1080p.WEB-DL');
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [4, 5]);
});

test('season zero is a special, not a missing season', () => {
  const got = findMarker("The Hitchhiker's Guide to the Galaxy - S00E22 - Recorded at the End of the Universe Bluray-1080p");
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 0);
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [22]);
});

test('a four-digit season is a year-season, not season 2013', () => {
  const got = findMarker('Koln.50667.S2013E015.German.1080p.RTLP.WEB-DL.AAC2.0.H.264-GLOTZE');
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 2013);
  assert.equal(got?.kind === 'episode' ? got.yearSeason : null, true);
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [15]);
});

test('a date sitting in the season slot is a date marker', () => {
  const got = findMarker('Millionaire.Hot.Seat.AU.S2026.08.25.1080p.WEBDL.h264-P147YPU5');
  assert.equal(got?.kind, 'date');
  assert.equal(got?.kind === 'date' ? got.date : null, '2026-08-25');
});

test('a season plus disc is a disc, never an episode', () => {
  const got = findMarker('The.Adventures.of.Jimmy.Neutron.Boy.Genius.FULLSCREEN.S03D03.NTSC.USA.DVD9-AndreMor');
  assert.equal(got?.kind, 'disc');
  assert.equal(got?.kind === 'disc' ? got.season : null, 3);
  assert.equal(got?.kind === 'disc' ? got.disc : null, 3);
});

test('a bare DISC with no season is still a disc', () => {
  const got = findMarker('The.Adventures.of.Super.Mario.Bros.3.FULLSCREEN.DISC3.NTSC.USA.DVD5-AndreMor');
  assert.equal(got?.kind, 'disc');
  assert.equal(got?.kind === 'disc' ? got.season : null, null);
  assert.equal(got?.kind === 'disc' ? got.disc : null, 3);
});

test('an ISO date in a library name', () => {
  const got = findMarker('Wheel of Fortune - 2026-03-23 - Hawaiian Vacation 1 HDTV-720p');
  assert.equal(got?.kind, 'date');
  assert.equal(got?.kind === 'date' ? got.date : null, '2026-03-23');
});

test('a dotted date in a scene name', () => {
  const got = findMarker('WWE.Monday.Night.RAW.2026.08.24.Satfeed.720p.HDTV.H264-Star');
  assert.equal(got?.kind, 'date');
  assert.equal(got?.kind === 'date' ? got.date : null, '2026-08-24');
});

test('a lowercase sxxexx marker', () => {
  const got = findMarker('the.block.au.s22e15.HDTV.H264-RBB');
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 22);
});

test('a bare season marker with no episode', () => {
  const got = findMarker('Some.Show.S04.1080p.WEB-DL-GRP');
  assert.equal(got?.kind, 'season');
  assert.equal(got?.kind === 'season' ? got.season : null, 4);
});

test('an NxNN marker', () => {
  const got = findMarker('Some.Show.2x04.HDTV-GRP');
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 2);
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [4]);
});

test('a roman numeral after the word Episode is not a marker', () => {
  // This is a movie sitting in a tv list. Reading `Episode.VI` as an episode
  // marker would send it to the wrong TMDB namespace.
  const got = findMarker('Star.Wars.Episode.VI.Return.of.the.Jedi.1983.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD7.1.Atmos-3L.DUAL-LACTATO');
  assert.equal(got, null);
});

test('a roman numeral in a movie title is not a marker either', () => {
  const got = findMarker('Mortal.Kombat.II.2026.UHD.BluRay.1080p.DD+Atmos.5.1.DoVi.HDR10+.x265-SM737');
  assert.equal(got, null);
});

test('a movie with a year and no markers has no marker', () => {
  const got = findMarker('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.equal(got, null);
});

test('an audio channel layout is never mistaken for an NxNN marker', () => {
  const got = findMarker('Aliens.1986.Special.Edition.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1.DUAL-BiOMA');
  assert.equal(got, null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run test -- test/parse/markers.test.ts
```

Expected: FAIL — cannot resolve `../../lib/parse/markers`.

- [ ] **Step 3: Write the implementation**

`lib/parse/markers.ts`:

```ts
export const PARSER_VERSION = 1;

export type Marker =
  | {
      readonly kind: 'episode';
      readonly season: number;
      readonly episodes: readonly number[];
      readonly yearSeason: boolean;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'season';
      readonly season: number;
      readonly yearSeason: boolean;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'disc';
      readonly season: number | null;
      readonly disc: number;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'date'; readonly date: string; readonly start: number; readonly end: number }
  | { readonly kind: 'absolute'; readonly episode: number; readonly start: number; readonly end: number };

const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

function isYearSeason(season: number): boolean {
  return season >= YEAR_MIN && season <= YEAR_MAX;
}

function range(from: number, to: number): readonly number[] {
  if (to < from) return [from];
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/**
 * Ordered because the patterns overlap. `S2026.08.25` must be read as a date
 * before the bare-season rule claims `S2026`; `S03D03` must be read as a disc
 * before the bare-season rule claims `S03`; and the range form `S02E01-E02`
 * must be tried before the single-episode form, which would otherwise match
 * its prefix and silently drop the second episode.
 */
const SEASON_DATE = /(?:^|[^A-Za-z0-9])S((?:19|20)\d{2})[._\s-](\d{2})[._\s-](\d{2})(?![0-9])/i;
const EPISODE_RANGE = /(?:^|[^A-Za-z0-9])S(\d{1,4})[._\s]?E(\d{1,3})[._\s]?-[._\s]?E(\d{1,3})(?![0-9])/i;
const EPISODE_REPEAT = /(?:^|[^A-Za-z0-9])S(\d{1,4})[._\s]?E(\d{1,3})(?:[._\s-]?E(\d{1,3}))+(?![0-9])/i;
const EPISODE_SINGLE = /(?:^|[^A-Za-z0-9])S(\d{1,4})[._\s]?E(\d{1,3})(?![0-9])/i;
const SEASON_DISC = /(?:^|[^A-Za-z0-9])S(\d{1,3})D(\d{1,2})(?![0-9])/i;
const BARE_DISC = /(?:^|[^A-Za-z0-9])DISC[._\s]?(\d{1,2})(?![0-9])/i;
const NUMERIC_SXE = /(?:^|[^A-Za-z0-9.])(\d{1,2})x(\d{2})(?![0-9])/i;
const WORDY = /(?:^|[^A-Za-z0-9])Season[._\s]+(\d{1,3})(?:[._\s]+Episode[._\s]+(\d{1,3}))?(?![0-9])/i;
const ISO_DATE = /(?:^|[^0-9])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![0-9])/;
const DOTTED_DATE = /(?:^|[^0-9])((?:19|20)\d{2})[._\s](\d{2})[._\s](\d{2})(?![0-9])/;
const BARE_SEASON = /(?:^|[^A-Za-z0-9])S(\d{1,3})(?![0-9EDed])/i;

/** The offset of the match's meaningful start, skipping the leading delimiter. */
function bounds(match: RegExpExecArray): { readonly start: number; readonly end: number } {
  const raw = match[0];
  const lead = /^[^A-Za-z0-9]/.test(raw) ? 1 : 0;
  return { start: match.index + lead, end: match.index + raw.length };
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function findMarker(stem: string): Marker | null {
  const seasonDate = SEASON_DATE.exec(stem);
  if (seasonDate !== null) {
    const year = num(seasonDate[1]);
    const month = num(seasonDate[2]);
    const day = num(seasonDate[3]);
    if (year !== null && month !== null && day !== null) {
      return { kind: 'date', date: `${year}-${pad(month)}-${pad(day)}`, ...bounds(seasonDate) };
    }
  }

  const rangeMatch = EPISODE_RANGE.exec(stem);
  if (rangeMatch !== null) {
    const season = num(rangeMatch[1]);
    const from = num(rangeMatch[2]);
    const to = num(rangeMatch[3]);
    if (season !== null && from !== null && to !== null) {
      return {
        kind: 'episode', season, episodes: range(from, to),
        yearSeason: isYearSeason(season), ...bounds(rangeMatch),
      };
    }
  }

  const repeat = EPISODE_REPEAT.exec(stem);
  if (repeat !== null) {
    const season = num(repeat[1]);
    if (season !== null) {
      // The global form is needed because a repeated group only captures its
      // last iteration; re-scan the matched text for every E number.
      const episodes = [...repeat[0].matchAll(/E(\d{1,3})/gi)]
        .map((m) => num(m[1]))
        .filter((n): n is number => n !== null);
      if (episodes.length > 1) {
        return {
          kind: 'episode', season, episodes,
          yearSeason: isYearSeason(season), ...bounds(repeat),
        };
      }
    }
  }

  const single = EPISODE_SINGLE.exec(stem);
  if (single !== null) {
    const season = num(single[1]);
    const episode = num(single[2]);
    if (season !== null && episode !== null) {
      return {
        kind: 'episode', season, episodes: [episode],
        yearSeason: isYearSeason(season), ...bounds(single),
      };
    }
  }

  const seasonDisc = SEASON_DISC.exec(stem);
  if (seasonDisc !== null) {
    const season = num(seasonDisc[1]);
    const disc = num(seasonDisc[2]);
    if (season !== null && disc !== null) {
      return { kind: 'disc', season, disc, ...bounds(seasonDisc) };
    }
  }

  const bareDisc = BARE_DISC.exec(stem);
  if (bareDisc !== null) {
    const disc = num(bareDisc[1]);
    if (disc !== null) return { kind: 'disc', season: null, disc, ...bounds(bareDisc) };
  }

  const numeric = NUMERIC_SXE.exec(stem);
  if (numeric !== null) {
    const season = num(numeric[1]);
    const episode = num(numeric[2]);
    if (season !== null && episode !== null) {
      return {
        kind: 'episode', season, episodes: [episode],
        yearSeason: false, ...bounds(numeric),
      };
    }
  }

  const wordy = WORDY.exec(stem);
  if (wordy !== null) {
    const season = num(wordy[1]);
    const episode = num(wordy[2]);
    if (season !== null && episode !== null) {
      return {
        kind: 'episode', season, episodes: [episode],
        yearSeason: false, ...bounds(wordy),
      };
    }
    if (season !== null) {
      return { kind: 'season', season, yearSeason: false, ...bounds(wordy) };
    }
  }

  for (const pattern of [ISO_DATE, DOTTED_DATE]) {
    const match = pattern.exec(stem);
    if (match === null) continue;
    const year = num(match[1]);
    const month = num(match[2]);
    const day = num(match[3]);
    if (year === null || month === null || day === null) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return { kind: 'date', date: `${year}-${pad(month)}-${pad(day)}`, ...bounds(match) };
  }

  const bareSeason = BARE_SEASON.exec(stem);
  if (bareSeason !== null) {
    const season = num(bareSeason[1]);
    if (season !== null) {
      return { kind: 'season', season, yearSeason: false, ...bounds(bareSeason) };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/parse/markers.test.ts
```

Expected: all PASS. Diagnostics for the likely failures:

- If the `Aliens...DTS-HD.MA.5.1.DUAL-BiOMA` case returns a marker, `NUMERIC_SXE`
  is matching inside a channel layout. Its leading class excludes `.` for
  exactly this reason — confirm that exclusion survived.
- If `Star.Wars.Episode.VI...` returns a marker, `WORDY` is matching `Episode`
  without requiring `Season` first. It must not: the pattern is anchored on
  `Season`.
- If the offsets in the first test are off by one, `bounds` is not skipping the
  leading delimiter — the regexes consume one character before `S`, and the
  marker's `start` must point at the `S`.

- [ ] **Step 5: Commit**

```bash
npm run check
git add lib/parse/markers.ts test/parse/markers.test.ts
git commit -m "Add marker detection with corpus-driven ordering

Pattern order is load-bearing: S2026.08.25 must read as a date before
the bare-season rule claims S2026, S03D03 as a disc before it claims
S03, and S02E01-E02 as a range before the single form drops E02."
```

---

### Task 6: Title boundary and release group

**Files:**
- Create: `lib/parse/boundary.ts`
- Test: `test/parse/boundary.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `isJunk`, `splitGroupSuffix` from `lib/parse/tokens`.
- Produces:
  - `interface Boundary { readonly titleTokens: readonly string[]; readonly junkTokens: readonly string[]; readonly group: string | null; readonly year: number | null }`
  - `findBoundary(tokens: readonly string[]): Boundary`

**The rule, and why it is not "split on the last hyphen."** Walk backwards
from the end while each token is junk, treating `A-B` as junk when `A` is
junk and collecting `B` as a group candidate. One trailing non-vocabulary
token is admitted as a candidate too, since a bare group name (`HONE`) is
common. The group is then the **leftmost** candidate, plus any bare
non-vocabulary tokens that follow it, stopping at the first junk-hyphenated
token — because such a token starts a new tag.

That rule is what distinguishes the two cases the corpus insists on:

- `...HEVC.HYBRID.REMUX-FraMeSToR.DUAL-LACTATO` → candidates `FraMeSToR`
  (leftmost) then `LACTATO`. The token after `FraMeSToR` is `DUAL-LACTATO`,
  which is junk-hyphenated, so appending stops. Group is `FraMeSToR`.
- `...Atmos.7.1.English-DarQ.HONE` → candidates `DarQ` (leftmost) then the
  bare `HONE`. `HONE` is not junk-hyphenated, so it is appended. Group is
  `DarQ.HONE`.

- [ ] **Step 1: Write the failing test**

`test/parse/boundary.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../lib/parse/tokens';
import { findBoundary } from '../../lib/parse/boundary';

function boundaryOf(stem: string) {
  return findBoundary(tokenize(stem));
}

test('a plain scene movie name', () => {
  const got = boundaryOf('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.deepEqual(got.titleTokens, ['Outbreak']);
  assert.equal(got.year, 1995);
  assert.equal(got.group, 'UnKn0wn');
});

test('the real group wins over a trailing DUAL re-release tag', () => {
  const got = boundaryOf('Die.Hard.1988.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR.DUAL-LACTATO');
  assert.deepEqual(got.titleTokens, ['Die', 'Hard']);
  assert.equal(got.year, 1988);
  assert.equal(got.group, 'FraMeSToR');
});

test('a bare trailing group name is appended to the hyphenated one', () => {
  const got = boundaryOf('Cold.Storage.2026.1080p.BluRay.x265.SDR.DDP.Atmos.7.1.English-DarQ.HONE');
  assert.deepEqual(got.titleTokens, ['Cold', 'Storage']);
  assert.equal(got.year, 2026);
  assert.equal(got.group, 'DarQ.HONE');
});

test('hyphens inside a title survive', () => {
  const got = boundaryOf('John.Wick-Chapter.3-Parabellum.2019.1080p.BluRay.x265.SDR.DDP.Atmos.7.1.English-DarQ.HONE');
  assert.deepEqual(got.titleTokens, ['John', 'Wick-Chapter', '3-Parabellum']);
  assert.equal(got.year, 2019);
  assert.equal(got.group, 'DarQ.HONE');
});

test('a roman numeral stays in the title and the year still resolves', () => {
  const got = boundaryOf('Mortal.Kombat.II.2026.UHD.BluRay.1080p.DD+Atmos.5.1.DoVi.HDR10+.x265-SM737');
  assert.deepEqual(got.titleTokens, ['Mortal', 'Kombat', 'II']);
  assert.equal(got.year, 2026);
  assert.equal(got.group, 'SM737');
});

test('a digit that belongs to the title is not eaten', () => {
  const got = boundaryOf('The.Adventures.of.Super.Mario.Bros.3.FULLSCREEN.NTSC.USA.DVD5-AndreMor');
  assert.deepEqual(got.titleTokens, ['The', 'Adventures', 'of', 'Super', 'Mario', 'Bros', '3']);
  assert.equal(got.year, null);
  assert.equal(got.group, 'AndreMor');
});

test('a space-separated name yields the same title and group as its dotted twin', () => {
  const dotted = boundaryOf('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  const spaced = boundaryOf('Outbreak 1995 1080p BluRay REMUX AVC DTS-HD-MA 5 1-UnKn0wn');
  assert.deepEqual(spaced.titleTokens, dotted.titleTokens);
  assert.equal(spaced.group, dotted.group);
  assert.equal(spaced.year, dotted.year);
});

test('a library name with a Sonarr quality suffix and no group', () => {
  const got = boundaryOf('Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux');
  // The marker is stripped before findBoundary in video.ts; here the whole
  // string is passed, so the title run simply ends at the first junk token.
  assert.equal(got.group, null);
  assert.equal(got.year, null);
});

test('a name that is entirely title has no group and no junk', () => {
  const got = boundaryOf('Interstellar');
  assert.deepEqual(got.titleTokens, ['Interstellar']);
  assert.deepEqual(got.junkTokens, []);
  assert.equal(got.group, null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm run test -- test/parse/boundary.test.ts
```

Expected: FAIL — cannot resolve `../../lib/parse/boundary`.

- [ ] **Step 3: Write the implementation**

`lib/parse/boundary.ts`:

```ts
import { isJunk, splitGroupSuffix } from './tokens';

export interface Boundary {
  readonly titleTokens: readonly string[];
  readonly junkTokens: readonly string[];
  readonly group: string | null;
  readonly year: number | null;
}

const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

function asYear(token: string): number | null {
  if (!/^\d{4}$/.test(token)) return null;
  const value = Number.parseInt(token, 10);
  return value >= YEAR_MIN && value <= YEAR_MAX ? value : null;
}

interface Candidate {
  readonly index: number;
  readonly group: string;
}

export function findBoundary(tokens: readonly string[]): Boundary {
  const candidates: Candidate[] = [];
  let cut = tokens.length;

  // One bare trailing non-vocabulary token may be a group name on its own.
  const last = tokens[tokens.length - 1];
  if (last !== undefined && !isJunk(last) && splitGroupSuffix(last) === null && tokens.length > 1) {
    candidates.push({ index: tokens.length - 1, group: last });
    cut = tokens.length - 1;
  }

  // Walk backwards over the closed-vocabulary run. A year encountered inside
  // the run is the title boundary signal, so it is recorded here rather than
  // by a second pass — by the time the walk stops, the year is already behind
  // `titleEnd` and a later scan would look in the wrong place.
  let year: number | null = null;
  let i = cut - 1;
  for (; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token === undefined) break;
    const suffix = splitGroupSuffix(token);
    if (suffix !== null) {
      candidates.push({ index: i, group: suffix.group });
      continue;
    }
    if (isJunk(token)) continue;
    const candidateYear = asYear(token);
    if (candidateYear !== null) {
      // Leftmost year in the junk run wins, so keep overwriting.
      year = candidateYear;
      continue;
    }
    break;
  }
  const titleEnd = i + 1;

  // Leftmost candidate wins; bare non-vocabulary tokens after it are appended,
  // and a junk-hyphenated token stops the append because it starts a new tag.
  let group: string | null = null;
  const leftmost = candidates.reduce<Candidate | null>(
    (best, c) => (best === null || c.index < best.index ? c : best),
    null,
  );
  if (leftmost !== null) {
    const parts = [leftmost.group];
    for (let k = leftmost.index + 1; k < tokens.length; k += 1) {
      const token = tokens[k];
      if (token === undefined) break;
      if (isJunk(token) || splitGroupSuffix(token) !== null) break;
      parts.push(token);
    }
    group = parts.join('.');
  }

  return {
    titleTokens: tokens.slice(0, titleEnd),
    junkTokens: tokens.slice(titleEnd),
    group,
    year,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npm run test -- test/parse/boundary.test.ts
```

Expected: all PASS. Diagnostics:

- If `Die.Hard` yields group `LACTATO`, the `leftmost` reduction is comparing
  the wrong way round, or `candidates` is being read in push order rather than
  by index.
- If `John.Wick-Chapter` loses `Wick-Chapter` from the title, `splitGroupSuffix`
  is accepting a non-vocabulary head — its `isJunk(head)` guard is what keeps
  title hyphens intact.
- If `Super.Mario.Bros.3` loses the `3`, a lone digit is classifying as junk;
  fix `CHANNELS` in `lib/parse/tokens.ts` (see Task 4).

- [ ] **Step 5: Commit**

```bash
npm run check
git add lib/parse/boundary.ts test/parse/boundary.test.ts
git commit -m "Add the backwards walk for title boundary and release group

Group is the leftmost candidate, not the text after the last hyphen:
-FraMeSToR.DUAL-LACTATO names FraMeSToR, and John.Wick-Chapter.3-
Parabellum has hyphens that belong to the title."
```

---
### Task 7: The video parser

**Files:**
- Create: `lib/parse/types.ts`, `lib/parse/video.ts`
- Modify: `lib/parse/tokens.ts` (tokenizer must drop punctuation-only parts — see Step 1)
- Test: `test/parse/video.test.ts`

**Interfaces:**
- Consumes: `splitInput` (Task 3), `tokenize`/`classifyToken` (Task 4),
  `findMarker`/`PARSER_VERSION` (Task 5), `findBoundary` (Task 6).
- Produces, all consumed by Plan 2:
  - `type Category = 'tv' | 'movies' | 'books' | 'xxx'`
  - `interface Quality`, `interface ParseHints`, `type ParsedVideo`, `type ParseResult`
  - `parseVideo(category: Category, input: string): ParseResult`

**One deviation from the spec, recorded deliberately.** The spec lists
`refusal: string | null` as a field on `ParsedVideo`. A parsed value that also
carries a refusal is self-contradictory, so refusal moves to the result
wrapper: `ParseResult` is `{ ok: true, parsed }` or `{ ok: false, refusal }`.
Step 6 of this task amends the spec to match.

- [ ] **Step 1: Make the tokenizer drop punctuation-only parts**

Library names use ` - ` as a field separator, so tokenizing
`Ghosts - S05E12 - The List` currently yields a bare `-` token that no
classifier will ever claim. In `lib/parse/tokens.ts`, change the first line of
`tokenize`:

```ts
  const raw = text.split(SEPARATOR).filter((part) => /[\p{L}\p{N}]/u.test(part));
```

Add this test to `test/parse/tokens.test.ts`:

```ts
test('punctuation-only parts are dropped', () => {
  assert.deepEqual(
    tokenize('Ghosts - S05E12 - The List WEBRip-1080p'),
    ['Ghosts', 'S05E12', 'The', 'List', 'WEBRip-1080p'],
  );
});
```

Run `npm run test -- test/parse/tokens.test.ts` and confirm every test in the
file still passes.

- [ ] **Step 2: Write the failing test**

`test/parse/video.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVideo } from '../../lib/parse/video';

function ok(category: 'tv' | 'movies', input: string) {
  const result = parseVideo(category, input);
  assert.equal(result.ok, true, `refused: ${result.ok ? '' : result.refusal}`);
  if (!result.ok) throw new Error('unreachable');
  return result.parsed;
}

test('a scene movie', () => {
  const got = ok('movies', 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  assert.equal(got.kind, 'movie');
  assert.equal(got.title, 'Outbreak');
  assert.equal(got.year, 1995);
  assert.equal(got.group, 'UnKn0wn');
  assert.equal(got.quality.resolution, '1080p');
  assert.equal(got.quality.source, 'BluRay');
  assert.equal(got.categoryDisagreement, false);
});

test('a contradictory UHD source at 1080p keeps the explicit resolution', () => {
  const got = ok('movies', 'Mortal.Kombat.II.2026.UHD.BluRay.1080p.DD+Atmos.5.1.DoVi.HDR10+.x265-SM737.nzb');
  assert.equal(got.title, 'Mortal Kombat II');
  assert.equal(got.quality.resolution, '1080p');
});

test('a movie whose title and year come only from the parent directory', () => {
  const got = ok('movies', 'Movies/Interstellar (2014)/00136.m2ts');
  assert.equal(got.kind, 'movie');
  assert.equal(got.title, 'Interstellar');
  assert.equal(got.year, 2014);
  assert.deepEqual(got.hints.fromDirectories, ['Interstellar (2014)']);
});

test('a library episode with a Sonarr quality suffix', () => {
  const got = ok('tv', 'TV Shows/Moon Knight/Season 1/Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux.mkv');
  assert.equal(got.kind, 'episode');
  assert.equal(got.title, 'Moon Knight');
  if (got.kind !== 'episode') throw new Error('unreachable');
  assert.equal(got.seasonNumber, 1);
  assert.deepEqual(got.episodeNumbers, [3]);
  assert.equal(got.episodeTitle, 'The Friendly Type');
  assert.equal(got.quality.resolution, '2160p');
});

test('a series title containing the field separator survives', () => {
  const got = ok('tv', 'TV Shows/Star Trek - Prodigy/Season 2/Star Trek - Prodigy - S02E01-E02 - Into the Breach Bluray-1080p Remux.mkv');
  assert.equal(got.title, 'Star Trek Prodigy');
  if (got.kind !== 'episode') throw new Error('unreachable');
  assert.deepEqual(got.episodeNumbers, [1, 2]);
  assert.equal(got.episodeTitle, 'Into the Breach');
});

test('a directory disambiguator is captured, not swallowed into the title', () => {
  const got = ok('tv', 'TV Shows/Ghosts (US)/Season 5/Ghosts (US) - S05E12 - The List WEBRip-1080p.mkv');
  assert.equal(got.title, 'Ghosts');
  assert.equal(got.hints.disambiguator, 'US');
});

test('the other Ghosts is distinguished by its year disambiguator', () => {
  const got = ok('tv', 'TV Shows/Ghosts (2019)/Season 1/Ghosts (2019) - S01E01 - Pilot WEBDL-1080p.mkv');
  assert.equal(got.title, 'Ghosts');
  assert.equal(got.hints.disambiguator, '2019');
});

test('a special is season zero', () => {
  const got = ok('tv', "TV Shows/The Hitchhiker's Guide to the Galaxy/Specials/The Hitchhiker's Guide to the Galaxy - S00E22 - Recorded at the End of the Universe Bluray-1080p.mkv");
  if (got.kind !== 'episode') throw new Error('unreachable');
  assert.equal(got.seasonNumber, 0);
  assert.deepEqual(got.episodeNumbers, [22]);
});

test('a date-based episode takes its season from the directory', () => {
  const got = ok('tv', 'TV Shows/Wheel of Fortune/Season 43/Wheel of Fortune - 2026-03-23 - Hawaiian Vacation 1 HDTV-720p.mkv');
  assert.equal(got.title, 'Wheel of Fortune');
  if (got.kind !== 'episode') throw new Error('unreachable');
  assert.equal(got.airDate, '2026-03-23');
  assert.equal(got.seasonNumber, 43);
});

test('a year-season is flagged rather than treated as season 2013', () => {
  const got = ok('tv', 'Koln.50667.S2013E015.German.1080p.RTLP.WEB-DL.AAC2.0.H.264-GLOTZE.nzb');
  if (got.kind !== 'episode') throw new Error('unreachable');
  assert.equal(got.seasonNumber, 2013);
  assert.equal(got.yearSeason, true);
  assert.equal(got.title, 'Koln 50667');
});

test('a DVD disc is a season with a disc hint, never an episode', () => {
  const got = ok('tv', 'The.Adventures.of.Jimmy.Neutron.Boy.Genius.FULLSCREEN.S03D03.NTSC.USA.DVD9-AndreMor.nzb');
  assert.equal(got.kind, 'season');
  if (got.kind !== 'season') throw new Error('unreachable');
  assert.equal(got.seasonNumber, 3);
  assert.equal(got.hints.discNumber, 3);
});

test('the caller category wins: a movie list entry with an episode marker', () => {
  // Declared movies, tokens look episodic. The parser reports the
  // disagreement but still yields a movie for the movie namespace.
  const got = ok('movies', 'Some.Show.S02E04.1080p.WEB-DL-GRP.nzb');
  assert.equal(got.kind, 'movie');
  assert.equal(got.categoryDisagreement, true);
});

test('the caller category wins the other way too', () => {
  const got = ok('tv', 'Star.Wars.Episode.VI.Return.of.the.Jedi.1983.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD7.1.Atmos-3L.DUAL-LACTATO.nzb');
  assert.equal(got.kind, 'series');
  assert.equal(got.title, 'Star Wars Episode VI Return of the Jedi');
  assert.equal(got.categoryDisagreement, true);
  assert.equal(got.group, '3L');
});

test('a Plex sidecar is refused, not parsed', () => {
  const result = parseVideo('tv', 'TV Shows/Moon Knight/.plexmatch');
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.refusal, /not a media file/);
});

test('a subtitle is refused', () => {
  const result = parseVideo('tv', 'TV Shows/Moon Knight/Season 1/Moon Knight - S01E01.srt');
  assert.equal(result.ok, false);
});

test('a name with no title left after junk removal is refused', () => {
  const result = parseVideo('movies', '1080p.BluRay.x264-GRP.mkv');
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.refusal, /no title/);
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
npm run test -- test/parse/video.test.ts
```

Expected: FAIL — cannot resolve `../../lib/parse/video`.

- [ ] **Step 4: Write `lib/parse/types.ts`**

```ts
export type Category = 'tv' | 'movies' | 'books' | 'xxx';

export const CATEGORIES: readonly Category[] = ['tv', 'movies', 'books', 'xxx'];

export interface Quality {
  readonly resolution: string | null;
  readonly source: string | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly hdr: readonly string[];
  readonly threeD: readonly string[];
}

export interface ParseHints {
  /** Ancestor directory names that contributed, nearest first. */
  readonly fromDirectories: readonly string[];
  /** A parenthesised year or region taken from a directory, e.g. `US`, `2019`. */
  readonly disambiguator: string | null;
  readonly discNumber: number | null;
}

interface ParsedCommon {
  readonly title: string;
  readonly year: number | null;
  readonly quality: Quality;
  readonly edition: readonly string[];
  readonly language: readonly string[];
  readonly group: string | null;
  readonly hints: ParseHints;
  readonly categoryDisagreement: boolean;
}

export type ParsedVideo =
  | (ParsedCommon & { readonly kind: 'movie' })
  | (ParsedCommon & { readonly kind: 'series' })
  | (ParsedCommon & {
      readonly kind: 'season';
      readonly seasonNumber: number;
      readonly yearSeason: boolean;
    })
  | (ParsedCommon & {
      readonly kind: 'episode';
      readonly seasonNumber: number | null;
      readonly episodeNumbers: readonly number[];
      readonly yearSeason: boolean;
      readonly airDate: string | null;
      readonly episodeTitle: string | null;
    });

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedVideo }
  | { readonly ok: false; readonly refusal: string };
```

- [ ] **Step 5: Write `lib/parse/video.ts`**

```ts
import { splitInput, SIDECAR_EXTENSIONS } from './normalize';
import { tokenize, classifyToken, expandCompound } from './tokens';
import { findMarker, type Marker } from './markers';
import { findBoundary } from './boundary';
import type { Category, ParseHints, ParsedVideo, ParseResult, Quality } from './types';

const EMPTY_QUALITY: Quality = {
  resolution: null, source: null, videoCodec: null, audioCodec: null,
  hdr: [], threeD: [],
};

const SEASON_DIR = /^(?:season[._\s]*(\d{1,3})|s(\d{1,3}))$/i;
const SPECIALS_DIR = /^specials?$/i;
// Trailing separators are allowed because a library basename reads
// `Ghosts (US) - S05E12 - ...`, so the head handed here ends `Ghosts (US) - `.
const DISAMBIGUATOR = /\(([^)]+)\)[\s._\-–—]*$/;

function extractQuality(tokens: readonly string[]): Quality {
  let resolution: string | null = null;
  let source: string | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  const hdr: string[] = [];
  const threeD: string[] = [];
  // `Bluray-2160p` must contribute both halves, so compounds are expanded.
  for (const token of tokens.flatMap((t) => [...expandCompound(t)])) {
    switch (classifyToken(token)) {
      case 'resolution': resolution ??= token; break;
      // `UHD` classifies as a source; an explicit `1080p` elsewhere still wins
      // because `resolution` is set only from the resolution class.
      case 'source': source ??= token; break;
      case 'videoCodec': videoCodec ??= token; break;
      case 'audioCodec': audioCodec ??= token; break;
      case 'hdr': hdr.push(token); break;
      case 'threeD': threeD.push(token); break;
      default: break;
    }
  }
  return { resolution, source, videoCodec, audioCodec, hdr, threeD };
}

function collect(tokens: readonly string[], want: 'edition' | 'language'): readonly string[] {
  return tokens
    .flatMap((token) => [...expandCompound(token)])
    .filter((token) => classifyToken(token) === want);
}

function titleFrom(tokens: readonly string[]): string {
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

interface DirectoryHints {
  readonly title: string | null;
  readonly year: number | null;
  readonly disambiguator: string | null;
  readonly season: number | null;
  readonly used: readonly string[];
}

function readDirectories(ancestors: readonly string[]): DirectoryHints {
  let season: number | null = null;
  const used: string[] = [];
  for (const ancestor of ancestors) {
    if (SPECIALS_DIR.test(ancestor)) {
      season ??= 0;
      used.push(ancestor);
      continue;
    }
    const seasonMatch = SEASON_DIR.exec(ancestor);
    if (seasonMatch !== null) {
      const digits = seasonMatch[1] ?? seasonMatch[2];
      if (digits !== undefined) season ??= Number.parseInt(digits, 10);
      used.push(ancestor);
      continue;
    }
    // The first ancestor that is neither a season nor a specials directory is
    // the title-bearing one. Anything above it is a library root.
    const disambiguatorMatch = DISAMBIGUATOR.exec(ancestor);
    const disambiguator = disambiguatorMatch?.[1] ?? null;
    const withoutParens = ancestor.replace(DISAMBIGUATOR, '').trim();
    const boundary = findBoundary(tokenize(withoutParens));
    const title = titleFrom(boundary.titleTokens);
    const yearFromParens =
      disambiguator !== null && /^\d{4}$/.test(disambiguator)
        ? Number.parseInt(disambiguator, 10)
        : null;
    used.push(ancestor);
    return {
      title: title.length > 0 ? title : null,
      year: boundary.year ?? yearFromParens,
      disambiguator,
      season,
      used,
    };
  }
  return { title: null, year: null, disambiguator: null, season, used };
}

function markerSuggestsSeries(marker: Marker | null): boolean {
  return marker !== null && marker.kind !== 'absolute';
}

export function parseVideo(category: Category, input: string): ParseResult {
  const split = splitInput(input);
  if (!split.isMedia) {
    const which = split.extension === null
      ? 'no extension'
      : SIDECAR_EXTENSIONS.has(split.extension)
        ? `sidecar .${split.extension}`
        : `unknown extension .${split.extension}`;
    return { ok: false, refusal: `not a media file (${which})` };
  }

  const marker = findMarker(split.stem);
  const head = marker === null ? split.stem : split.stem.slice(0, marker.start);
  const tail = marker === null ? '' : split.stem.slice(marker.end);

  const headDisambiguator = DISAMBIGUATOR.exec(head.trim())?.[1] ?? null;
  const headClean = head.replace(DISAMBIGUATOR, ' ');

  const headBoundary = findBoundary(tokenize(headClean));
  const tailTokens = tokenize(tail);
  const tailBoundary = findBoundary(tailTokens);

  const dirs = readDirectories(split.ancestors);

  // The basename's own title, or the directory's when the basename has none.
  // A stem with no letters is not a title: `Movies/Interstellar (2014)/00136.m2ts`
  // is a raw Blu-ray stream whose only identity lives in its parent directory.
  const rawBasenameTitle = titleFrom(headBoundary.titleTokens);
  const basenameTitle = /\p{L}/u.test(rawBasenameTitle) ? rawBasenameTitle : '';
  const usedDirectories = basenameTitle.length > 0 ? [] : dirs.used;
  const title = basenameTitle.length > 0 ? basenameTitle : dirs.title ?? '';
  if (title.length === 0) {
    return { ok: false, refusal: 'no title found in the filename or its directories' };
  }

  // Only genuine junk, and each token once. Including the whole tail would
  // both double-count it and let an episode title called "The Special" register
  // as an edition.
  const junk = [...headBoundary.junkTokens, ...tailBoundary.junkTokens];
  const quality = junk.length > 0 ? extractQuality(junk) : EMPTY_QUALITY;
  const group = tailBoundary.group ?? headBoundary.group;
  const year = headBoundary.year ?? (basenameTitle.length > 0 ? null : dirs.year);

  const hints: ParseHints = {
    fromDirectories: usedDirectories,
    disambiguator: headDisambiguator ?? dirs.disambiguator,
    discNumber: marker !== null && marker.kind === 'disc' ? marker.disc : null,
  };

  const common = {
    title,
    year,
    quality,
    edition: collect(junk, 'edition'),
    language: collect(junk, 'language'),
    group,
    hints,
    categoryDisagreement:
      category === 'movies'
        ? markerSuggestsSeries(marker)
        : category === 'tv' && marker === null && year !== null,
  } as const;

  // The declared category fixes the shape. A `movies` lookup is always a
  // movie, even when the tokens look episodic, because the provider namespace
  // is chosen by the caller (see the spec's Non-goals on cross-category
  // fallback).
  if (category === 'movies') {
    return { ok: true, parsed: { ...common, kind: 'movie' } };
  }

  if (marker === null) {
    return { ok: true, parsed: { ...common, kind: 'series' } };
  }

  const episodeTitle = titleFrom(tailBoundary.titleTokens);

  switch (marker.kind) {
    case 'episode':
      return {
        ok: true,
        parsed: {
          ...common, kind: 'episode',
          seasonNumber: marker.season,
          episodeNumbers: marker.episodes,
          yearSeason: marker.yearSeason,
          airDate: null,
          episodeTitle: episodeTitle.length > 0 ? episodeTitle : null,
        },
      };
    case 'date':
      return {
        ok: true,
        parsed: {
          ...common, kind: 'episode',
          seasonNumber: dirs.season,
          episodeNumbers: [],
          yearSeason: false,
          airDate: marker.date,
          episodeTitle: episodeTitle.length > 0 ? episodeTitle : null,
        },
      };
    case 'season':
      return {
        ok: true,
        parsed: { ...common, kind: 'season', seasonNumber: marker.season, yearSeason: marker.yearSeason },
      };
    case 'disc':
      // A disc is a slice of a season. No provider models discs, so resolving
      // one to an episode would be a confident wrong answer.
      return {
        ok: true,
        parsed: {
          ...common, kind: 'season',
          seasonNumber: marker.season ?? dirs.season ?? 1,
          yearSeason: false,
        },
      };
    case 'absolute':
      return {
        ok: true,
        parsed: {
          ...common, kind: 'episode',
          seasonNumber: dirs.season,
          episodeNumbers: [marker.episode],
          yearSeason: false,
          airDate: null,
          episodeTitle: episodeTitle.length > 0 ? episodeTitle : null,
        },
      };
    default:
      return { ok: false, refusal: 'unrecognised marker' };
  }
}
```

- [ ] **Step 6: Amend the spec to match the refusal contract**

In `docs/superpowers/specs/2026-08-25-media-name-parser-core-design.md`, in the
Parsing section, replace the sentence listing the fields carried by each
variant so that `refusal: string | null` is described as living on the
`ParseResult` wrapper rather than on `ParsedVideo`. Keep everything else.

- [ ] **Step 7: Run the tests and iterate**

```bash
npm run test -- test/parse/video.test.ts
```

Expected: all PASS. This is the task most likely to need iteration; work
through failures one test at a time rather than editing broadly. Known
sensitivities:

- `Star Trek - Prodigy` yields the title `Star Trek Prodigy` (separator dropped,
  not preserved) — that is intentional, since the title is later folded for
  matching anyway.
- If the `Wheel of Fortune` case has `seasonNumber: null`, `readDirectories` is
  returning before it reaches the `Season 43` ancestor. Ancestors are
  nearest-first, so `Season 43` comes *before* `Wheel of Fortune`; the season
  branch must `continue`, not return.
- If `Interstellar` comes back with `fromDirectories: []`, the guard is keying
  off the wrong emptiness check — directories are recorded only when the
  basename contributed no title.

- [ ] **Step 8: Verify and commit**

```bash
npm run check
git add lib/parse test/parse docs/superpowers/specs
git commit -m "Assemble the tv/movies parser

The declared category fixes the output shape; a mismatch with the
tokens is reported via categoryDisagreement rather than overriding the
caller, because SxxExx markers occur in xxx and litrpg releases too."
```

---

### Task 8: Corpus rate harness

**Files:**
- Create: `scripts/corpus-report.ts`, `test/corpus.test.ts`, `fixtures/corpus/baseline.json`
- Test: `test/corpus.test.ts` (the harness is the test)

**Interfaces:**
- Consumes: `parseVideo` (Task 7).
- Produces: `scripts/corpus-report.ts` exports `measure(file: string, category: Category): CorpusRate` where
  `interface CorpusRate { readonly file: string; readonly total: number; readonly parsed: number; readonly refused: number; readonly failed: number; readonly rate: number }`.
  `failed` counts lines that parsed to an empty title, `threw` counts lines
  that raised. `rate` is `(parsed + refused) / total` — an intentional refusal
  is a success, because refusing a `.srt` is the right answer. `threw` is kept
  separate from `failed` because a throw must always be zero, whereas a
  handful of empty titles is a quality number to improve over time.

**Note on the second metric.** The spec calls for a resolve rate alongside the
parse rate. Resolution needs the TMDB client, which is Plan 2, so this task
establishes the parse rate only and the baseline file carries a `resolveRate`
key set to `null`. Plan 2 fills it in. This is called out here so the gap is
visible rather than forgotten.

- [ ] **Step 1: Write the harness**

`scripts/corpus-report.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { parseVideo } from '../lib/parse/video';
import type { Category } from '../lib/parse/types';

export interface CorpusRate {
  readonly file: string;
  readonly total: number;
  readonly parsed: number;
  readonly refused: number;
  /** Parsed, but with an empty title. A parser bug, not an honest refusal. */
  readonly failed: number;
  /** Threw. Always unacceptable — the parser must never throw on any input. */
  readonly threw: number;
  readonly rate: number;
}

export interface CorpusFile {
  readonly file: string;
  readonly category: Category;
}

export const CORPUS: readonly CorpusFile[] = [
  { file: 'fixtures/corpus/movies.releases.raw.txt', category: 'movies' },
  { file: 'fixtures/corpus/movies.library.raw.txt', category: 'movies' },
  { file: 'fixtures/corpus/tv.releases.raw.txt', category: 'tv' },
  { file: 'fixtures/corpus/tv.library.raw.txt', category: 'tv' },
  { file: 'fixtures/corpus/tv.sport.raw.txt', category: 'tv' },
];

export function readLines(file: string): readonly string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
}

export function measure(file: string, category: Category): CorpusRate {
  const lines = readLines(file);
  let parsed = 0;
  let refused = 0;
  let failed = 0;
  let threw = 0;
  for (const line of lines) {
    try {
      const result = parseVideo(category, line);
      if (result.ok) {
        if (result.parsed.title.length > 0) parsed += 1;
        else failed += 1;
      } else {
        refused += 1;
      }
    } catch {
      threw += 1;
    }
  }
  const total = lines.length;
  return {
    file, total, parsed, refused, failed, threw,
    rate: total === 0 ? 0 : (parsed + refused) / total,
  };
}

function main(): void {
  const write = process.argv.includes('--write');
  const rates = CORPUS.map(({ file, category }) => measure(file, category));
  for (const r of rates) {
    const pct = (r.rate * 100).toFixed(2);
    console.log(
      `${r.file.padEnd(42)} total=${String(r.total).padStart(5)} ` +
      `parsed=${String(r.parsed).padStart(5)} refused=${String(r.refused).padStart(4)} ` +
      `failed=${String(r.failed).padStart(4)} threw=${String(r.threw).padStart(4)} rate=${pct}%`,
    );
  }
  if (write) {
    const baseline = {
      parseRate: Object.fromEntries(rates.map((r) => [r.file, Number(r.rate.toFixed(4))])),
      resolveRate: null,
    };
    writeFileSync('fixtures/corpus/baseline.json', `${JSON.stringify(baseline, null, 2)}\n`);
    console.log('\nwrote fixtures/corpus/baseline.json');
  }
}

if (process.argv[1]?.endsWith('corpus-report.ts') === true) {
  main();
}
```

- [ ] **Step 2: Run the report and read the numbers before writing a baseline**

```bash
npm run corpus
```

Do **not** write the baseline yet. Read the output. If any file's rate is
below 80%, sample twenty failing lines and decide whether the parser has a
real gap worth fixing now:

```bash
node --import tsx -e "
import { parseVideo } from './lib/parse/video.ts';
import { readLines } from './scripts/corpus-report.ts';
const lines = readLines('fixtures/corpus/tv.releases.raw.txt');
let shown = 0;
for (const line of lines) {
  const r = parseVideo('tv', line);
  if (!r.ok || r.parsed.title.length === 0) { console.log(line); if (++shown >= 20) break; }
}
"
```

Fix genuine parser gaps by adding a focused test to the relevant
`test/parse/*.test.ts` file and then the code — never by loosening the
harness. `tv.sport.raw.txt` is the one file expected to parse well but resolve
badly, and resolution is not measured here, so a low rate there is a real
parser gap, not the sports problem.

- [ ] **Step 3: Write the regression test**

`test/corpus.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CORPUS, measure } from '../scripts/corpus-report';

const baselineSchema = z.object({
  parseRate: z.record(z.string(), z.number()),
  resolveRate: z.record(z.string(), z.number()).nullable(),
});

test('no corpus file regresses below its recorded parse rate', () => {
  const baseline = baselineSchema.parse(
    JSON.parse(readFileSync('fixtures/corpus/baseline.json', 'utf8')),
  );
  for (const { file, category } of CORPUS) {
    const floor = baseline.parseRate[file];
    assert.notEqual(floor, undefined, `${file} has no recorded baseline`);
    if (floor === undefined) continue;
    const actual = measure(file, category);
    assert.ok(
      actual.rate >= floor - 0.0001,
      `${file} regressed: ${(actual.rate * 100).toFixed(2)}% < ${(floor * 100).toFixed(2)}% ` +
      `(parsed=${actual.parsed} refused=${actual.refused} failed=${actual.failed})`,
    );
  }
});

test('the parser never throws on any corpus line', () => {
  for (const { file, category } of CORPUS) {
    const actual = measure(file, category);
    assert.ok(actual.total > 0, `${file} is empty`);
    assert.equal(actual.threw, 0, `${file}: parser threw on ${actual.threw} line(s)`);
  }
});
```

- [ ] **Step 4: Record the baseline and confirm the gate works**

```bash
node --import tsx scripts/corpus-report.ts --write
cat fixtures/corpus/baseline.json
npm run test -- test/corpus.test.ts
```

Expected: PASS. Then prove the gate bites: temporarily add `return { ok: false,
refusal: 'x' };` as the first line of `parseVideo`, re-run, confirm the test
FAILS with a regression message naming a file, then revert.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/corpus-report.ts test/corpus.test.ts fixtures/corpus/baseline.json package.json
git commit -m "Add the corpus parse-rate harness and regression gate

An intentional refusal counts as success: refusing a .srt is the right
answer, and folding it into the failure count would reward a parser
that guessed instead."
```

---

### Task 9: Golden corpus

**Files:**
- Create: `scripts/golden-generate.ts`, `test/golden.test.ts`,
  `fixtures/corpus/movies.golden.jsonl`, `fixtures/corpus/tv.golden.jsonl`
- Test: `test/golden.test.ts`

**Interfaces:**
- Consumes: `parseVideo` (Task 7), `CORPUS`/`readLines` (Task 8).
- Produces: nothing consumed by later plans. This task's output is the
  regression baseline that protects Tasks 3–7 from future edits.

**Sampling, not exhaustion.** `tv.library.raw.txt` alone is 3,343 lines across
70 series, and hand-reviewing all of it would be a week of work for very
little marginal signal. The generator stratifies instead: for each corpus file
it groups lines by a *shape signature* — marker kind, whether directories
contributed, extension, whether a group was found, whether a disambiguator was
found — and emits up to three examples per distinct signature. Every naming
convention in the corpus gets exact expectations; near-duplicates do not.

- [ ] **Step 1: Write the generator**

`scripts/golden-generate.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { parseVideo } from '../lib/parse/video';
import { splitInput } from '../lib/parse/normalize';
import { findMarker } from '../lib/parse/markers';
import type { Category } from '../lib/parse/types';
import { readLines } from './corpus-report';

const PER_SIGNATURE = 3;

function signature(category: Category, line: string): string {
  const split = splitInput(line);
  const marker = findMarker(split.stem);
  const result = parseVideo(category, line);
  const parts = [
    marker === null ? 'none' : marker.kind,
    marker !== null && 'yearSeason' in marker && marker.yearSeason ? 'yearSeason' : '-',
    split.ancestors.length > 0 ? 'path' : 'flat',
    split.extension ?? 'noext',
    result.ok ? (result.parsed.group === null ? 'nogroup' : 'group') : 'refused',
    result.ok && result.parsed.hints.disambiguator !== null ? 'disamb' : '-',
    result.ok && result.parsed.hints.fromDirectories.length > 0 ? 'dirtitle' : '-',
  ];
  return parts.join('|');
}

function sample(file: string, category: Category): readonly string[] {
  const seen = new Map<string, number>();
  const picked: string[] = [];
  for (const line of readLines(file)) {
    const key = signature(category, line);
    const count = seen.get(key) ?? 0;
    if (count >= PER_SIGNATURE) continue;
    seen.set(key, count + 1);
    picked.push(line);
  }
  return picked;
}

function entry(category: Category, line: string): string {
  const result = parseVideo(category, line);
  const record = result.ok
    ? { name: line, category, expected: result.parsed }
    : { name: line, category, expected: null, expectedRefusal: result.refusal };
  return JSON.stringify(record);
}

function main(): void {
  const groups: readonly { readonly out: string; readonly files: readonly { readonly file: string; readonly category: Category }[] }[] = [
    {
      out: 'fixtures/corpus/movies.golden.jsonl',
      files: [
        { file: 'fixtures/corpus/movies.releases.raw.txt', category: 'movies' },
        { file: 'fixtures/corpus/movies.library.raw.txt', category: 'movies' },
      ],
    },
    {
      out: 'fixtures/corpus/tv.golden.jsonl',
      files: [
        { file: 'fixtures/corpus/tv.releases.raw.txt', category: 'tv' },
        { file: 'fixtures/corpus/tv.library.raw.txt', category: 'tv' },
        { file: 'fixtures/corpus/tv.sport.raw.txt', category: 'tv' },
      ],
    },
  ];
  for (const group of groups) {
    const lines: string[] = [];
    for (const { file, category } of group.files) {
      for (const line of sample(file, category)) lines.push(entry(category, line));
    }
    writeFileSync(group.out, `${lines.join('\n')}\n`);
    console.log(`${group.out}: ${lines.length} entries`);
  }
}

main();
```

- [ ] **Step 2: Generate the proposals and review every line**

```bash
node --import tsx scripts/golden-generate.ts
wc -l fixtures/corpus/*.golden.jsonl
```

Expect on the order of 100–300 entries per file. Now **read them**. This is
the one step in the plan that is judgement, not mechanism: the generator wrote
down what the parser currently believes, and committing that unreviewed would
freeze today's bugs into the baseline forever.

For each entry, check the title is the real title, the year is right, the
season and episode numbers match the name, and a refusal is genuinely
correct. Where the parser is wrong, **edit the expectation to the right
answer** and leave it failing — then fix the parser in Task 3–7's files with a
focused unit test, exactly as in Task 8 Step 2. Do not edit an expectation to
match a wrong parse.

Reformat the file for review if it helps (`jq . < file.jsonl`), but commit it
as one JSON object per line.

- [ ] **Step 3: Write the table test**

`test/golden.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseVideo } from '../lib/parse/video';

const entrySchema = z.object({
  name: z.string(),
  category: z.enum(['tv', 'movies', 'books', 'xxx']),
  expected: z.record(z.string(), z.unknown()).nullable(),
  expectedRefusal: z.string().optional(),
});

const FILES = [
  'fixtures/corpus/movies.golden.jsonl',
  'fixtures/corpus/tv.golden.jsonl',
];

for (const file of FILES) {
  test(`golden expectations hold for ${file}`, () => {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.ok(lines.length > 0, `${file} is empty`);
    const failures: string[] = [];
    for (const line of lines) {
      const entry = entrySchema.parse(JSON.parse(line));
      const result = parseVideo(entry.category, entry.name);
      if (entry.expected === null) {
        if (result.ok) failures.push(`${entry.name}\n  expected refusal, got a parse`);
        continue;
      }
      if (!result.ok) {
        failures.push(`${entry.name}\n  expected a parse, got refusal: ${result.refusal}`);
        continue;
      }
      const actual = JSON.parse(JSON.stringify(result.parsed)) as unknown;
      try {
        assert.deepEqual(actual, entry.expected);
      } catch {
        failures.push(
          `${entry.name}\n  expected ${JSON.stringify(entry.expected)}\n  actual   ${JSON.stringify(actual)}`,
        );
      }
    }
    assert.equal(failures.length, 0, `${failures.length} golden mismatches:\n\n${failures.join('\n\n')}`);
  });
}
```

The `z.record(z.string(), z.unknown())` on `expected` is the one place
`unknown` is permitted: the value is compared structurally against a freshly
serialized parse, never read field by field, so giving it a shape here would
duplicate `ParsedVideo` for no benefit.

- [ ] **Step 4: Run it and confirm it passes**

```bash
npm run test -- test/golden.test.ts
```

Expected: PASS, after Step 2's review-and-fix loop has converged. A failure
message names the input, the expectation, and the actual parse.

- [ ] **Step 5: Re-record the baseline, since the parser changed during review**

```bash
node --import tsx scripts/corpus-report.ts --write
git diff fixtures/corpus/baseline.json
```

The rates should be equal or higher than Task 8's. If any rate went *down*,
a fix during Step 2 regressed another shape — find it before committing.

- [ ] **Step 6: Full verification and commit**

```bash
npm run check
npm run build
git add scripts/golden-generate.ts test/golden.test.ts \
        fixtures/corpus/movies.golden.jsonl fixtures/corpus/tv.golden.jsonl \
        fixtures/corpus/baseline.json lib test
git commit -m "Add the reviewed golden corpus and its table test

Entries are a stratified sample by shape signature rather than the
whole corpus: every naming convention gets an exact expectation, and
near-duplicates do not earn one."
```

---

## Definition of done for this plan

- [ ] `npm run check` and `npm run build` both pass from a clean checkout.
- [ ] Migrations apply to an empty Neon branch, and `media` carries both its
      self-referencing foreign key and the `(provider, provider_ref)` unique.
- [ ] `npm run corpus` prints a parse rate for all five raw files.
- [ ] `fixtures/corpus/baseline.json` is committed and `test/corpus.test.ts`
      fails when the parser regresses.
- [ ] Both golden files are committed, reviewed, and passing.
- [ ] `fixtures/corpus/*.raw.txt` is byte-identical to its committed state.

## Handoff to Plan 2

Plan 2 consumes exactly these exports and nothing else from this plan:

| From | Symbol |
|---|---|
| `lib/parse/types` | `Category`, `ParsedVideo`, `ParseResult`, `Quality`, `ParseHints` |
| `lib/parse/video` | `parseVideo` |
| `lib/parse/normalize` | `normalizeKey`, `foldForMatch`, `splitInput` |
| `lib/parse/markers` | `PARSER_VERSION` |
| `lib/db/schema` | every table and enum |
| `lib/db/client` | `db`, `Db` |

Plan 2 additionally owes this plan one thing: filling `resolveRate` in
`fixtures/corpus/baseline.json`, which Task 8 deliberately left `null`.
