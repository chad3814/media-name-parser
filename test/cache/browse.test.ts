import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, withTransaction } from '../../lib/db/client';
import {
  parseFilters, browseCache, PER_PAGE, CONFIDENCE_BANDS,
  type CacheFilters,
} from '../../lib/cache/browse';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

const base: CacheFilters = {
  category: null, state: null, band: 'any', disagreementOnly: false, page: 1, perPage: PER_PAGE,
};

// --- parseFilters: pure, no database ---------------------------------------

test('parseFilters defaults an empty query', () => {
  const f = parseFilters(new URLSearchParams());
  assert.deepEqual(f, base);
});

test('parseFilters reads every filter the spec names', () => {
  const f = parseFilters(new URLSearchParams(
    'category=tv&state=unresolved&band=none&disagreement=1&page=3'));
  assert.equal(f.category, 'tv');
  assert.equal(f.state, 'unresolved');
  assert.equal(f.band, 'none');
  assert.equal(f.disagreementOnly, true);
  assert.equal(f.page, 3);
});

test('parseFilters is total: nonsense falls back rather than throwing', () => {
  // A URL is user input. This must not throw and must not produce a value
  // that reaches SQL as-is.
  const f = parseFilters(new URLSearchParams('category=banana&state=asleep&band=chartreuse&page=-3'));
  assert.equal(f.category, null);
  assert.equal(f.state, null);
  assert.equal(f.band, 'any');
  assert.equal(f.page, 1, 'page clamps to at least 1');
});

test('parseFilters ignores a caller-supplied page size', () => {
  // Not user-controlled: a query asking for 100000 rows is a denial of service
  // with extra steps.
  const f = parseFilters(new URLSearchParams('perPage=100000'));
  assert.equal(f.perPage, PER_PAGE);
});

test('parseFilters treats a repeated parameter as its first value', () => {
  const f = parseFilters(new URLSearchParams('page=2&page=9'));
  assert.equal(f.page, 2);
});

// --- browseCache: against the real database -------------------------------

const FIXTURE = 'books';

async function seed(): Promise<void> {
  await withTransaction(async (tx) => {
    // parses first: lookups_parse_fk requires the referenced row to exist, and
    // it is not deferrable. One parse per lookup, and `fixture-medium` carries
    // tokens with no categoryDisagreement key so the COALESCE path is covered.
    const parses: readonly [string, Record<string, unknown>][] = [
      ['fixture-high', { categoryDisagreement: false }],
      ['fixture-medium', {}],
      ['fixture-low', { categoryDisagreement: true }],
      ['fixture-none', { categoryDisagreement: false }],
    ];
    for (const [key, tokens] of parses) {
      await tx.execute(sql`
        INSERT INTO parses (category, normalized_key, tokens, parser_version)
        VALUES (${FIXTURE}, ${key}, ${JSON.stringify(tokens)}::jsonb, 1)`);
    }
    const rows: readonly [string, string, number | null][] = [
      ['fixture-high', 'resolved', 0.95],
      ['fixture-medium', 'resolved', 0.80],
      ['fixture-low', 'unresolved', 0.10],
      ['fixture-none', 'unresolved', null],
    ];
    for (const [name, state, confidence] of rows) {
      await tx.execute(sql`
        INSERT INTO lookups (category, name, normalized_key, state, confidence)
        VALUES (${FIXTURE}, ${name}, ${name}, ${state}::lookup_state, ${confidence})`);
    }
  });
}

async function unseed(): Promise<void> {
  const db = getDb();
  // Scoped to the `fixture-` names this file creates, not to the whole
  // category. Test files run in parallel, so deleting every row of a category
  // destroys rows another file is mid-assertion about -- and the tests below
  // assert exact counts within this category, so a foreign row breaks them in
  // the other direction too.
  //
  // lookups first: ON DELETE RESTRICT refuses to remove a parse that a lookup
  // still references.
  await db.execute(sql`
    DELETE FROM lookups WHERE category = ${FIXTURE} AND name LIKE 'fixture-%'`);
  await db.execute(sql`
    DELETE FROM parses WHERE category = ${FIXTURE} AND normalized_key LIKE 'fixture-%'`);
}

test('every band together accounts for every row, so nothing is hidden', opts, async () => {
  // The invariant is asserted against the whole table rather than only the
  // fixture -- a band filter that silently drops NULL-confidence rows would
  // make these sums disagree, and that must hold over real rows too. But the
  // fixture is seeded first, because `any > 0` against an empty table is a
  // failure about the database rather than about banding.
  await unseed();
  await seed();
  try {
    // All five counts in ONE repeatable-read transaction, so they share a
    // single snapshot. Five separate transactions cannot test this invariant:
    // node runs test files in parallel, other files insert and delete
    // `lookups` rows throughout, and a row arriving between the `any` read and
    // a band read makes the sums disagree for reasons that have nothing to do
    // with banding. That is what produced the intermittent "bands sum to 9 but
    // any is 8" this suite has been living with -- a real defect in the test,
    // not a flake in the database.
    const counts = await withTransaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const seen = new Map<string, number>();
      for (const band of CONFIDENCE_BANDS) {
        seen.set(band, (await browseCache(tx, { ...base, band })).total);
      }
      return seen;
    });
    const any = counts.get('any') ?? -1;
    const parts = (counts.get('high') ?? 0) + (counts.get('medium') ?? 0)
      + (counts.get('low') ?? 0) + (counts.get('none') ?? 0);
    assert.ok(any >= 4, `the four seeded rows should be counted, saw ${any}`);
    assert.equal(parts, any, `bands sum to ${parts} but any is ${any}`);
  } finally {
    await unseed();
  }
});

test('the none band finds unscored rows, which are the interesting ones', opts, async () => {
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, band: 'none' }));
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.name, 'fixture-none');
    assert.equal(page.rows[0]?.confidence, null);
  } finally {
    await unseed();
  }
});

test('each band selects only its own rows', opts, async () => {
  await unseed();
  try {
    await seed();
    const only = async (band: CacheFilters['band']): Promise<readonly string[]> => {
      const page = await withTransaction((tx) =>
        browseCache(tx, { ...base, category: FIXTURE, band }));
      return page.rows.map((row) => row.name);
    };
    assert.deepEqual(await only('high'), ['fixture-high']);
    assert.deepEqual(await only('medium'), ['fixture-medium']);
    assert.deepEqual(await only('low'), ['fixture-low']);
    assert.deepEqual(await only('none'), ['fixture-none']);
    assert.equal((await only('any')).length, 4);
  } finally {
    await unseed();
  }
});

test('the state filter narrows to one state', opts, async () => {
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, state: 'resolved' }));
    assert.equal(page.total, 2);
    assert.ok(page.rows.every((row) => row.state === 'resolved'));
  } finally {
    await unseed();
  }
});

test('the disagreement filter needs the parses join and finds the flagged row', opts, async () => {
  // categoryDisagreement is not a column: it lives in parses.tokens, joined on
  // (category, normalized_key).
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, disagreementOnly: true }));
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.name, 'fixture-low');
    assert.equal(page.rows[0]?.disagreement, true);
  } finally {
    await unseed();
  }
});

test('a parse without the disagreement key reports false, not null', opts, async () => {
  // lookups_parse_fk means every lookup has a parse, so the "no parse row"
  // case is unreachable -- but a parse whose tokens lack the key is not, and
  // COALESCE is what turns that into false rather than null.
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE }));
    assert.equal(page.total, 4);
    const medium = page.rows.find((row) => row.name === 'fixture-medium');
    assert.equal(medium?.disagreement, false, 'a missing key must read as false');
  } finally {
    await unseed();
  }
});

test('paging is stable and reports a total larger than the page', opts, async () => {
  await unseed();
  try {
    await seed();
    const first = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, perPage: 2, page: 1 }));
    const second = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, perPage: 2, page: 2 }));
    assert.equal(first.total, 4);
    assert.equal(first.pageCount, 2);
    assert.equal(first.rows.length, 2);
    assert.equal(second.rows.length, 2);
    // No row appears on both pages -- the failure a non-total sort produces.
    const ids = new Set([...first.rows, ...second.rows].map((row) => row.id));
    assert.equal(ids.size, 4, 'a row appeared on two pages');
  } finally {
    await unseed();
  }
});

test('a page past the end is empty rather than an error', opts, async () => {
  await unseed();
  try {
    await seed();
    const page = await withTransaction((tx) =>
      browseCache(tx, { ...base, category: FIXTURE, perPage: 2, page: 99 }));
    assert.equal(page.rows.length, 0);
    assert.equal(page.total, 4, 'the total still describes the filtered set');
  } finally {
    await unseed();
  }
});
