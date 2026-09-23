# Cross-Provider Version Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record that a series TMDB resolved and the same series TheTVDB resolved are one show, and expose that on the read envelope so a caller can merge for itself.

**Architecture:** Three pairwise link tables keyed `(a, b)` with `CHECK (a < b)`, of which only `media_versions` is populated. The composite provider already holds both identities at the moment of a fallback, so `ResolvedMedia` carries a `sameAs` hint that `persistResolved` turns into a pair. `provider_sites` is renamed `sites` and given a surrogate id so its link table matches the others.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), zod v4, Drizzle + Postgres 18, `node:test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-23-cross-provider-versions-design.md`

## Global Constraints

- Node >= 24, ESM. 2-space indent, semicolons always.
- **Never** the `any` or `unknown` TypeScript type. The single permitted `unknown` is the immediate argument of a `schema.parse(...)`.
- Prefer async APIs over sync twins.
- Credentials never enter a log, a URL or a `provider_calls` row.
- Verification gate for every commit: `npm run lint && npm run typecheck && npm test && npm run build`.
- Commits are signed. If the agent refuses, commit with `git -c commit.gpgsign=false` and say which commits need re-signing.
- No lookup may resolve to a different record than it does today. This change is additive.
- Migrations are generated with `npm run db:generate` and inspected before acceptance; a generated drop-and-recreate of a populated table is never acceptable.

## Review Focus

Five things the spec implies that no task's happy path exercises. Each has a test added to the task that owns the code.

1. **A pair inserted twice, or mirrored.** The resolve path re-runs on every stale lookup, so the same pair will be offered repeatedly and sometimes with the ids in the other order. Expected: one row, no error. *(Task 2)*
2. **`sameAs` naming a row that does not exist.** The ordinary case on a first fallback, since TMDB's chain is discarded unpersisted. Expected: the media persists, no pair, no throw. *(Task 4)*
3. **`sameAs` naming the row being written.** A provider handing over its own ref would violate `CHECK (a < b)` with `a = b`. Expected: no pair, no error. *(Task 4)*
4. **A media row deleted while linked.** `lookups.media_id` is `ON DELETE SET NULL` but media can still be removed. Expected: the pair goes with it, never a dangling id. *(Task 1)*
5. **Reading versions from the far side of a pair.** A link stored `(a, b)` must be visible from `b`; storing canonically makes this the case a naive `WHERE a = $1` gets wrong. *(Task 5)*

---

### Task 1: The three link tables, and `sites`

**Files:**
- Modify: `lib/db/schema.ts` — rename `providerSites`, add `id`, add three tables
- Modify: `lib/providers/tpdb/sites.ts:34,75,79` — the table name in three SQL statements
- Create: `drizzle/0005_*.sql` (generated, then hand-checked)
- Test: `test/db/schema.test.ts`, `test/db/versions.test.ts` (new)

**Interfaces:**
- Produces: `mediaVersions`, `peopleVersions`, `sitesVersions`, and `sites` (was `providerSites`) exported from `lib/db/schema.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/db/versions.test.ts`. These hit a real database, so follow the
pattern in `test/db/transaction.test.ts` for how the suite skips without one.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction } from '../../lib/db/client';

/** Two throwaway media rows, returned smallest id first. */
async function twoMedia(tx: Parameters<Parameters<typeof withTransaction>[0]>[0]): Promise<[string, string]> {
  const rows = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('tv','series','A','a','tmdb',${`t-${crypto.randomUUID()}`},'{}'::jsonb, now()),
           ('tv','series','A','a','tvdb',${`v-${crypto.randomUUID()}`},'{}'::jsonb, now())
    RETURNING id`);
  const ids = rows.rows.map((r) => String(r.id)).sort();
  return [ids[0] ?? '', ids[1] ?? ''];
}

test('a pair is stored once, however it is offered', async () => {
  await assert.rejects(withTransaction(async (tx) => {
    const [a, b] = await twoMedia(tx);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)`);
    // Mirrored: the same fact, and the CHECK is what stops it being a
    // second row that every reader would then have to dedupe.
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${b}::uuid, ${a}::uuid)`);
    throw new Error('unreachable');
  }), /violates check constraint/);
});

test('a media row takes its links with it', async () => {
  await withTransaction(async (tx) => {
    const [a, b] = await twoMedia(tx);
    await tx.execute(sql`INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)`);
    await tx.execute(sql`DELETE FROM media WHERE id = ${a}::uuid`);
    const left = await tx.execute(sql`SELECT count(*)::int AS n FROM media_versions WHERE a = ${a}::uuid OR b = ${a}::uuid`);
    assert.equal(left.rows[0]?.n, 0, 'a dangling pair would outlive the row it describes');
    await tx.execute(sql`DELETE FROM media WHERE id = ${b}::uuid`);
  });
});

test('people_versions and sites_versions exist and are empty', async () => {
  await withTransaction(async (tx) => {
    for (const table of ['people_versions', 'sites_versions']) {
      const r = await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      assert.equal(r.rows[0]?.n, 0, `${table} should exist and start empty`);
    }
  });
});

test('sites holds what provider_sites held, under a surrogate id', async () => {
  await withTransaction(async (tx) => {
    const r = await tx.execute(sql`
      SELECT count(*)::int AS n, count(id)::int AS with_id FROM sites`);
    assert.equal(r.rows[0]?.n, r.rows[0]?.with_id, 'every row has an id');
  });
});
```

Append to `test/db/schema.test.ts`:

```ts
test('the link tables are exported and shaped alike', () => {
  for (const name of ['mediaVersions', 'peopleVersions', 'sitesVersions', 'sites']) {
    assert.ok(name in schema, `schema is missing ${name}`);
  }
  assert.ok(!('providerSites' in schema), 'provider_sites was renamed to sites');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/db/schema.test.ts test/db/versions.test.ts`
Expected: FAIL — `mediaVersions` missing, and `relation "media_versions" does not exist`.

- [ ] **Step 3: Change the schema**

In `lib/db/schema.ts`, replace the `providerSites` definition with:

```ts
/**
 * A site a provider knows: a studio, a network, a channel. An entity with
 * its own identity, like `people`, not an extension of a media row -- which
 * is why it is `sites` and not `site_details`, and why it carries a
 * surrogate id rather than keying on the provider pair.
 *
 * The old name read as a sibling of `provider_calls`, which is an
 * observability table about requests and nothing of the kind.
 */
export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: providerEnum('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  shortName: text('short_name').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('sites_provider_ref_key').on(t.provider, t.providerRef),
  unique('sites_short_name_key').on(t.provider, t.shortName),
]);
```

Then add, after it:

```ts
/**
 * Two rows that are the same thing, seen by different providers.
 *
 * `CHECK (a < b)` with the pair as the primary key is what makes a link
 * storable exactly once. Without it `(x, y)` and `(y, x)` are different rows
 * saying the same thing, and every reader has to look both ways *and*
 * dedupe. With it a writer sorts before inserting and a reader asks
 * `WHERE a = $1 OR b = $1`; the index on `b` keeps that second half from
 * scanning.
 *
 * Pairwise, so not transitive: three providers on one record would need all
 * three pairs. The only cross-provider overlap that exists is tmdb-tvdb on
 * `tv`, so that is a limitation to record rather than design around.
 */
export const mediaVersions = pgTable('media_versions', {
  a: uuid('a').notNull().references(() => media.id, { onDelete: 'cascade' }),
  b: uuid('b').notNull().references(() => media.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
  index('media_versions_b_idx').on(t.b),
  check('media_versions_ordered', sql`${t.a} < ${t.b}`),
]);

/** Empty until #3 gives it a link source. See the spec. */
export const peopleVersions = pgTable('people_versions', {
  a: uuid('a').notNull().references(() => people.id, { onDelete: 'cascade' }),
  b: uuid('b').notNull().references(() => people.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
  index('people_versions_b_idx').on(t.b),
  check('people_versions_ordered', sql`${t.a} < ${t.b}`),
]);

/** Empty: TPDB is the only provider that writes sites. See the spec. */
export const sitesVersions = pgTable('sites_versions', {
  a: uuid('a').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  b: uuid('b').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
  index('sites_versions_b_idx').on(t.b),
  check('sites_versions_ordered', sql`${t.a} < ${t.b}`),
]);
```

Add `check` and `sql` to the imports at the top of the file if they are not
already there (`import { check } from 'drizzle-orm/pg-core'`, `import { sql } from 'drizzle-orm'`).

- [ ] **Step 4: Point the TPDB site cache at the new name**

In `lib/providers/tpdb/sites.ts`, change `provider_sites` to `sites` in all
three statements (lines ~34, ~75, ~79). Nothing else in that file changes:
the reads and writes are still by `(provider, provider_ref)` and
`(provider, short_name)`, both of which are still unique.

- [ ] **Step 5: Generate and inspect the migration**

Run: `npm run db:generate`

Read the generated SQL. It **must** be an `ALTER TABLE ... RENAME TO sites`
plus an `ADD COLUMN id`, plus three `CREATE TABLE`s. If Drizzle instead emits
`DROP TABLE provider_sites` and a `CREATE TABLE sites`, do not accept it —
that discards 1,138 live rows. Hand-write the rename in that case:

```sql
ALTER TABLE "provider_sites" RENAME TO "sites";
ALTER TABLE "sites" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE "sites" DROP CONSTRAINT "provider_sites_provider_provider_ref_pk";
ALTER TABLE "sites" ADD CONSTRAINT "sites_pkey" PRIMARY KEY ("id");
ALTER TABLE "sites" ADD CONSTRAINT "sites_provider_ref_key" UNIQUE ("provider","provider_ref");
ALTER TABLE "sites" RENAME CONSTRAINT "provider_sites_short_name_key" TO "sites_short_name_key";
```

- [ ] **Step 6: Run the tests**

Run: `npx tsx --test test/db/schema.test.ts test/db/versions.test.ts test/providers/tpdb-sites.test.ts test/deploy/migrations.test.ts`
Expected: PASS. The tpdb-sites tests must pass **unchanged** — the rename is
invisible to them.

- [ ] **Step 7: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/db/schema.ts lib/providers/tpdb/sites.ts drizzle test/db
git commit -m "Give a site its own identity, and name the pairs that are one thing"
```

---

### Task 2: Writing a pair, once, in either order

**Files:**
- Create: `lib/media/versions.ts`
- Test: `test/media/versions.test.ts`

**Interfaces:**
- Consumes: `withTransaction`, `Tx` from `lib/db/client`.
- Produces:
  - `export async function linkVersions(tx: Tx, one: string, other: string): Promise<boolean>` — true when a pair was written, false when it was already there or the two ids are equal.
  - `export async function versionsOf(tx: Tx, mediaId: string): Promise<readonly string[]>` — the ids linked to this one, either direction.

- [ ] **Step 1: Write the failing test**

Create `test/media/versions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction } from '../../lib/db/client';
import { linkVersions, versionsOf } from '../../lib/media/versions';

async function media(tx: Parameters<Parameters<typeof withTransaction>[0]>[0], provider: string): Promise<string> {
  const r = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('tv','series','A','a', ${sql.raw(`'${provider}'`)}::provider, ${`${provider}-${crypto.randomUUID()}`}, '{}'::jsonb, now())
    RETURNING id`);
  return String(r.rows[0]?.id);
}

test('a pair is written once and found from both sides', async () => {
  await withTransaction(async (tx) => {
    const x = await media(tx, 'tmdb');
    const y = await media(tx, 'tvdb');
    assert.equal(await linkVersions(tx, x, y), true);
    assert.deepEqual(await versionsOf(tx, x), [y]);
    assert.deepEqual(await versionsOf(tx, y), [x], 'visible from the far side too');
  });
});

test('offering the same pair again, in either order, writes nothing', async () => {
  // The resolve path re-runs on every stale lookup, so this happens
  // constantly and must be silent rather than an error.
  await withTransaction(async (tx) => {
    const x = await media(tx, 'tmdb');
    const y = await media(tx, 'tvdb');
    assert.equal(await linkVersions(tx, x, y), true);
    assert.equal(await linkVersions(tx, x, y), false);
    assert.equal(await linkVersions(tx, y, x), false, 'order is not a new fact');
    const n = await tx.execute(sql`SELECT count(*)::int AS n FROM media_versions WHERE a = ${x}::uuid OR b = ${x}::uuid`);
    assert.equal(n.rows[0]?.n, 1);
  });
});

test('a row is not a version of itself', async () => {
  await withTransaction(async (tx) => {
    const x = await media(tx, 'tmdb');
    assert.equal(await linkVersions(tx, x, x), false, 'no row, and no constraint violation');
    assert.deepEqual(await versionsOf(tx, x), []);
  });
});

test('an unlinked row has no versions', async () => {
  await withTransaction(async (tx) => {
    assert.deepEqual(await versionsOf(tx, await media(tx, 'tmdb')), []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/media/versions.test.ts`
Expected: FAIL — `Cannot find module '../../lib/media/versions'`.

- [ ] **Step 3: Write the implementation**

Create `lib/media/versions.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/**
 * Records that two rows are the same thing.
 *
 * The pair is sorted before it is written, because `media_versions` stores
 * it under `CHECK (a < b)`: one fact, one row, whichever order a caller
 * happens to hold the two ids in. `ON CONFLICT DO NOTHING` because the
 * resolve path re-offers a link on every stale lookup and that is not news.
 *
 * Returns whether a row was written, which is what lets a backfill report
 * what it did rather than what it tried.
 */
export async function linkVersions(tx: Tx, one: string, other: string): Promise<boolean> {
  // A row is not a version of itself, and asking would violate the CHECK.
  if (one === other) return false;
  const [a, b] = one < other ? [one, other] : [other, one];
  const written = await tx.execute(sql`
    INSERT INTO media_versions (a, b) VALUES (${a}::uuid, ${b}::uuid)
    ON CONFLICT DO NOTHING
    RETURNING a`);
  return written.rows.length > 0;
}

/** Every row linked to this one, from either side of the pair. */
export async function versionsOf(tx: Tx, mediaId: string): Promise<readonly string[]> {
  const rows = await tx.execute(sql`
    SELECT CASE WHEN a = ${mediaId}::uuid THEN b ELSE a END AS other
      FROM media_versions
     WHERE a = ${mediaId}::uuid OR b = ${mediaId}::uuid`);
  return rows.rows.map((r) => String(r.other));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test test/media/versions.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/media/versions.ts test/media/versions.test.ts
git commit -m "Write a version pair once, whichever way round it arrives"
```

---

### Task 3: The composite says what it knows

**Files:**
- Modify: `lib/providers/types.ts` — `ResolvedMedia.sameAs`
- Modify: `lib/providers/fallback.ts` — set it on the returned series
- Test: `test/providers/fallback.test.ts`

**Interfaces:**
- Produces: `ResolvedMedia.sameAs?: { provider: ProviderName; providerRef: string }`, set by `createFallbackProvider` on the series node of a fallback answer.

- [ ] **Step 1: Write the failing test**

Append to `test/providers/fallback.test.ts`:

```ts
test('a fallback answer names the primary record it stood in for', async () => {
  // The composite is the only place both identities are in hand at once,
  // which is what makes the link exact rather than a guess.
  const tmdbSeries = {
    kind: 'series', title: 'House Hunters Renovation', provider: 'tmdb',
    providerRef: 'tmdb:tv:55493', externalIds: [{ source: 'tvdb', id: '262643' }], parent: null,
  };
  const tvdbSeries = {
    kind: 'series', provider: 'tvdb', providerRef: '262643', externalIds: [], parent: null,
  };
  const tvdbEpisode = { kind: 'episode', provider: 'tvdb', externalIds: [], parent: tvdbSeries };

  const primary: Provider = {
    name: 'tmdb', supports: () => true,
    resolve: async () => ({ confidence: 0.5, media: tmdbSeries as unknown as ResolveOutcome['media'] }),
  };
  const secondary: Provider = {
    name: 'tvdb', supports: () => true,
    resolve: async () => ({ confidence: 0.9, media: tvdbEpisode as unknown as ResolveOutcome['media'] }),
  };
  const out = await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);

  assert.deepEqual(out?.media.parent?.sameAs, { provider: 'tmdb', providerRef: 'tmdb:tv:55493' },
    'on the series, which is what the handover established');
  assert.equal(out?.media.sameAs, undefined,
    'not on the episode: the handover says nothing about whether TMDB has it');
});

test('an answer the primary gave itself names nothing', async () => {
  const media = { kind: 'episode', provider: 'tmdb', externalIds: [], parent: null };
  const primary: Provider = {
    name: 'tmdb', supports: () => true,
    resolve: async () => ({ confidence: 0.9, media: media as unknown as ResolveOutcome['media'] }),
  };
  const out = await createFallbackProvider(primary, null).resolve(parsed(EPISODE), ctx);
  assert.equal(out?.media.sameAs, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: FAIL — `sameAs` is undefined on the series.

- [ ] **Step 3: Add the field**

In `lib/providers/types.ts`, inside `ResolvedMedia`, after `externalIds`:

```ts
  /**
   * Another provider's record for this same thing, when the resolution knew
   * of one. Written into `media_versions` by `persistResolved` if that row
   * exists; nothing happens if it does not.
   *
   * Optional so a resolution that knows of no counterpart says nothing,
   * rather than saying something empty.
   */
  readonly sameAs?: { readonly provider: ProviderName; readonly providerRef: string };
```

- [ ] **Step 4: Set it in the composite**

In `lib/providers/fallback.ts`, replace the secondary call inside the `try`:

```ts
        const answered = await secondary.resolve(parsed, handover);
        if (answered === null) return first;
        // The handover established that two *series* are the same. Recorded
        // on the series of the chain being returned, naming the primary's
        // record -- not on the episode, because the handover says nothing
        // about whether the primary has that episode, which is usually the
        // reason the fallback ran at all.
        if (inherited === undefined || first === null) return answered;
        return { ...answered, media: withSameAs(answered.media, first.media) };
```

and add, beside `handoverFrom`:

```ts
/** The series node of a chain, or null when it has none. */
function seriesOf(media: ResolvedMedia | null): ResolvedMedia | null {
  for (let node = media; node !== null; node = node.parent) {
    if (node.kind === 'series') return node;
  }
  return null;
}

/**
 * The same chain with its series pointed at the primary's series.
 *
 * Rebuilt rather than mutated: `ResolvedMedia` is readonly throughout, and
 * the parent chain is shared structure a caller may hold elsewhere.
 */
function withSameAs(media: ResolvedMedia, primaryMedia: ResolvedMedia): ResolvedMedia {
  const counterpart = seriesOf(primaryMedia);
  if (counterpart === null) return media;
  const sameAs = { provider: counterpart.provider, providerRef: counterpart.providerRef };
  if (media.kind === 'series') return { ...media, sameAs };
  if (media.parent === null) return media;
  return { ...media, parent: withSameAs(media.parent, primaryMedia) };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test test/providers/fallback.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/providers/types.ts lib/providers/fallback.ts test/providers/fallback.test.ts
git commit -m "Let a stand-in answer name the record it stood in for"
```

---

### Task 4: Persisting the pair

**Files:**
- Modify: `lib/resolve/persist.ts` — in `persistResolved`, after the media upsert
- Test: `test/resolve/persist.test.ts`

**Interfaces:**
- Consumes: `linkVersions` from Task 2; `ResolvedMedia.sameAs` from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `test/resolve/persist.test.ts`, following the fixtures already in
that file for building a `ResolvedMedia`:

```ts
test('a sameAs naming a stored row records the pair', async () => {
  await withTransaction(async (tx) => {
    const primaryId = await persistResolved(tx, series({
      provider: 'tmdb', providerRef: 'tmdb:tv:55493', title: 'House Hunters Renovation',
    }));
    const fallbackId = await persistResolved(tx, series({
      provider: 'tvdb', providerRef: '262643', title: 'House Hunters Renovation',
      sameAs: { provider: 'tmdb', providerRef: 'tmdb:tv:55493' },
    }));
    assert.deepEqual(await versionsOf(tx, fallbackId), [primaryId]);
  });
});

test('a sameAs naming a row that is not stored is not an error', async () => {
  // The ordinary case on a first fallback: the primary's chain was
  // discarded unpersisted, so there is nothing to link to yet.
  await withTransaction(async (tx) => {
    const id = await persistResolved(tx, series({
      provider: 'tvdb', providerRef: '999001', title: 'Nothing Links Here',
      sameAs: { provider: 'tmdb', providerRef: 'tmdb:tv:does-not-exist' },
    }));
    assert.deepEqual(await versionsOf(tx, id), [], 'no pair, and no throw');
  });
});

test('a sameAs naming the row being written records nothing', async () => {
  await withTransaction(async (tx) => {
    const id = await persistResolved(tx, series({
      provider: 'tvdb', providerRef: '999002', title: 'Self',
      sameAs: { provider: 'tvdb', providerRef: '999002' },
    }));
    assert.deepEqual(await versionsOf(tx, id), []);
  });
});

test('resolving the same name twice leaves one pair', async () => {
  await withTransaction(async (tx) => {
    await persistResolved(tx, series({ provider: 'tmdb', providerRef: 'tmdb:tv:1', title: 'Twice' }));
    const one = series({
      provider: 'tvdb', providerRef: '1001', title: 'Twice',
      sameAs: { provider: 'tmdb', providerRef: 'tmdb:tv:1' },
    });
    const id = await persistResolved(tx, one);
    await persistResolved(tx, one);
    assert.deepEqual(await versionsOf(tx, id), [
      ...new Set(await versionsOf(tx, id)),
    ], 'idempotent');
    assert.equal((await versionsOf(tx, id)).length, 1);
  });
});
```

If `test/resolve/persist.test.ts` has no `series(...)` helper, add one that
returns a `ResolvedMedia` of kind `series` with the given overrides and
`category: 'tv'`, `people: []`, `externalIds: []`, `parent: null`,
`details` all-null, `raw: {}`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/resolve/persist.test.ts`
Expected: FAIL — no pair is recorded.

- [ ] **Step 3: Write the implementation**

In `lib/resolve/persist.ts`, import `linkVersions` from `../media/versions`,
and in `persistResolved` insert between the `mediaId` check and
`persistDetails`:

```ts
  await linkCounterpart(tx, mediaId, resolved);
```

then add:

```ts
/**
 * Records the pair when the resolution named another provider's record for
 * the same thing and that record is stored.
 *
 * Silent when it is not, which is the ordinary case on a first fallback:
 * the primary's chain is discarded unpersisted, so there is nothing yet to
 * link to. The next lookup that resolves the other provider, or the
 * backfill, closes it. A link that cannot be written is not an error, it is
 * a fact not yet known.
 */
async function linkCounterpart(tx: Tx, mediaId: string, resolved: ResolvedMedia): Promise<void> {
  const other = resolved.sameAs;
  if (other === undefined) return;
  const found = await tx.execute(sql`
    SELECT id FROM media
     WHERE provider = ${other.provider}::provider AND provider_ref = ${other.providerRef}`);
  const counterpart = found.rows[0]?.id;
  if (typeof counterpart !== 'string') return;
  await linkVersions(tx, mediaId, counterpart);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test test/resolve/persist.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/resolve/persist.ts test/resolve/persist.test.ts
git commit -m "Record the pair when both halves are stored"
```

---

### Task 5: `versions` on the read envelope

**Files:**
- Modify: `lib/media/read.ts` — `MediaView`, and the reader
- Modify: `lib/openapi/spec.ts`
- Test: `test/media/read.test.ts`, `test/openapi/spec.test.ts`

**Interfaces:**
- Consumes: `versionsOf` from Task 2.
- Produces: `MediaView.versions: readonly MediaNode[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/media/read.test.ts`:

```ts
test('a linked row reports its counterpart, from either side', async () => {
  await withTransaction(async (tx) => {
    const a = await persistResolved(tx, series({ provider: 'tmdb', providerRef: 'tmdb:tv:77', title: 'Linked' }));
    const b = await persistResolved(tx, series({
      provider: 'tvdb', providerRef: '77', title: 'Linked',
      sameAs: { provider: 'tmdb', providerRef: 'tmdb:tv:77' },
    }));
    const fromB = await readMedia(tx, b);
    assert.deepEqual(fromB?.versions.map((v) => v.providerRef), ['tmdb:tv:77']);
    // Stored canonically as one row, so the far side is the case a naive
    // `WHERE a = $1` gets wrong.
    const fromA = await readMedia(tx, a);
    assert.deepEqual(fromA?.versions.map((v) => v.providerRef), ['77']);
  });
});

test('an unlinked row reports an empty list, not a missing key', async () => {
  await withTransaction(async (tx) => {
    const id = await persistResolved(tx, series({ provider: 'tmdb', providerRef: 'tmdb:tv:78', title: 'Alone' }));
    const view = await readMedia(tx, id);
    assert.deepEqual(view?.versions, [], 'a consumer never distinguishes none from unsupported');
  });
});
```

Append to `test/openapi/spec.test.ts`, matching how that file asserts on the
document:

```ts
test('the media schema documents versions', () => {
  const media = spec.components.schemas.Media;
  assert.ok('versions' in media.properties, 'versions is part of the documented shape');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/media/read.test.ts test/openapi/spec.test.ts`
Expected: FAIL — `versions` is not a property of the view.

- [ ] **Step 3: Extend the view**

In `lib/media/read.ts`, add to `MediaView` after `parents`:

```ts
  /**
   * The same thing as another provider recorded it. Empty when none is
   * known, so a consumer never has to tell "none" from "not supported".
   *
   * Only for the node being read. A parent's versions are not included:
   * that would multiply the response with the chain for a fact the caller
   * can ask for directly.
   */
  readonly versions: readonly MediaNode[];
```

and in the reader, after the `people` query:

```ts
  // One extra query, and a left join in spirit: a row with no links yields
  // no rows and no media read can fail for want of one.
  const versions = await tx.execute(sql`
    SELECT m.id, m.kind, m.title, m.release_date, m.year, m.provider, m.provider_ref
      FROM media_versions v
      JOIN media m ON m.id = CASE WHEN v.a = ${mediaId}::uuid THEN v.b ELSE v.a END
     WHERE v.a = ${mediaId}::uuid OR v.b = ${mediaId}::uuid
     ORDER BY m.provider`);
```

and add `versions: versions.rows.map(node),` to the returned object.

- [ ] **Step 4: Document it**

In `lib/openapi/spec.ts`, add `versions` to the `Media` schema's properties,
as an array of the same node shape `parents` uses, with the description
"The same record as held by another provider. Empty when none is known."

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsx --test test/media/read.test.ts test/openapi/spec.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add lib/media/read.ts lib/openapi/spec.ts test/media/read.test.ts test/openapi/spec.test.ts
git commit -m "Say on the envelope what else is the same thing"
```

---

### Task 6: Backfill what is already stored

**Files:**
- Create: `scripts/backfill-media-versions.ts`
- Test: exercised by running it; no unit test (a one-off script over live data)

**Interfaces:**
- Consumes: `linkVersions` from Task 2.

- [ ] **Step 1: Write the script**

Create `scripts/backfill-media-versions.ts`:

```ts
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb } from '../lib/db/client';
import { linkVersions } from '../lib/media/versions';

/**
 * Pairs media rows already stored that two providers both hold.
 *
 * Matching is on `(kind, lower(sort_title))`, which is a heuristic, and
 * acceptable here in a way it is not on the resolve path: this runs once,
 * over a set small enough to read in full, and prints every pair before it
 * writes anything. Nothing is written without `--write`.
 */
const write = process.argv.includes('--write');

const pairs = await withTransaction(async (tx) => {
  const rows = await tx.execute(sql`
    SELECT a.id AS a_id, a.provider::text AS a_provider, a.provider_ref AS a_ref,
           b.id AS b_id, b.provider::text AS b_provider, b.provider_ref AS b_ref,
           a.kind::text AS kind, a.title AS title
      FROM media a
      JOIN media b
        ON b.kind = a.kind
       AND lower(b.sort_title) = lower(a.sort_title)
       AND b.provider <> a.provider
       AND a.id < b.id
     ORDER BY a.title`);
  return rows.rows;
});

console.log(`${pairs.length} pair(s) match on kind and title:\n`);
for (const p of pairs) {
  console.log(`  ${String(p.kind).padEnd(8)} ${String(p.title)}`);
  console.log(`      ${String(p.a_provider)}:${String(p.a_ref)}  <->  ${String(p.b_provider)}:${String(p.b_ref)}`);
}

if (!write) {
  console.log('\nNothing written. Re-run with --write to record these.');
  await closeDb();
} else {
  const written = await withTransaction(async (tx) => {
    let n = 0;
    for (const p of pairs) {
      if (await linkVersions(tx, String(p.a_id), String(p.b_id))) n += 1;
    }
    return n;
  });
  console.log(`\nwrote ${written} new pair(s); ${pairs.length - written} already recorded`);
  await closeDb();
}
```

- [ ] **Step 2: Add the npm script**

In `package.json`, beside the other one-off scripts:

```json
"backfill:versions": "node --env-file=.env.local --import tsx scripts/backfill-media-versions.ts"
```

- [ ] **Step 3: Dry run it**

Run: `npm run backfill:versions`
Expected: a list of pairs and "Nothing written". Read the list. Ten pairs are
expected, all tv series. If anything in the list is *not* obviously the same
show, stop and report it rather than writing.

- [ ] **Step 4: Full gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run build
git add scripts/backfill-media-versions.ts package.json
git commit -m "Pair up the duplicates already stored"
```

The `--write` run against production is a deploy step, not a commit step.
Do not run it without your human partner saying so.

---

### Task 7: Verify against the live API

**Files:** none expected. If a change is needed, add a test for it first.

- [ ] **Step 1: Resolve a fallback name end to end**

Create `.tmp/verify.ts` (untracked; delete afterwards). Resolve
`House.Hunters.Renovation.2012.S03E02.1080p.WEB-DL-FUZEER` through
`buildProvider('tmdb', () => {})` against a database, then read the resulting
media back with `readMedia` and print `versions`.

Run: `node --env-file=.env.local --import tsx .tmp/verify.ts`

Expected, given TMDB's House Hunters Renovation series row already exists:
`versions` contains the tmdb series. If TMDB's row does not exist in that
database, expect an empty list — that is the documented behaviour, not a
failure.

- [ ] **Step 2: Confirm the rename did not disturb the site cache**

Resolve any xxx name whose site is already cached and confirm it still takes
the one-call warm path — the tpdb provider reads `sites` by short name, and a
rename that broke it would show as an extra text search.

- [ ] **Step 3: Clean up**

```bash
rm -rf .tmp
npm run lint && npm run typecheck && npm test && npm run build
```

---

## Self-Review

**Spec coverage.** Three link tables and the `sites` rename with its surrogate
id → Task 1. `movie_details` unchanged → no task, correctly. Canonical
ordering and write-once → Task 2. `sameAs` on `ResolvedMedia`, set on the
series only → Task 3. Persisting the pair, silent when the counterpart is
absent → Task 4. `versions` on the envelope and in the OpenAPI document →
Task 5. Backfill with a dry run → Task 6. Live verification and the success
criteria → Task 7. `people_versions`/`sites_versions` created empty → Task 1,
asserted empty in its tests.

**Placeholders.** None: every code step carries its code, every test step its
assertions, every run step its command and expected result.

**Type consistency.** `linkVersions(tx, one, other) => Promise<boolean>` and
`versionsOf(tx, mediaId) => Promise<readonly string[]>` are defined in Task 2
and used unchanged in Tasks 4, 5 and 6. `ResolvedMedia.sameAs` is declared in
Task 3 and consumed in Task 4. `MediaNode` is the existing type reused for
`versions` in Task 5, so no new shape enters the API.

**Review Focus coverage.** Duplicate and mirrored inserts → Task 2, plus the
constraint itself in Task 1. Absent counterpart → Task 4. Self-reference →
Task 4, and `linkVersions` guards it in Task 2. Cascade on delete → Task 1.
Reading from the far side → Tasks 2 and 5.

One gap found and closed while reviewing: Task 3's `withSameAs` originally
set the field on whatever node was returned, which for an episode would have
been the episode. It now walks to the series, and the test asserts the
episode is left alone — the handover establishes that two series are the
same and says nothing about the episode.
