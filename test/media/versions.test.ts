import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb, type Tx } from '../../lib/db/client';
import { linkVersions, seriesVersionCandidates, versionsOf } from '../../lib/media/versions';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => {
  if (hasDb) await closeDb();
});

async function media(tx: Tx, provider: 'tmdb' | 'tvdb'): Promise<string> {
  const r = await tx.execute(sql`
    INSERT INTO media (category, kind, title, sort_title, provider, provider_ref, raw, raw_fetched_at)
    VALUES ('tv','series','A','a', ${provider}::provider, ${`${provider}-${crypto.randomUUID()}`},
            '{}'::jsonb, now())
    RETURNING id`);
  return String(r.rows[0]?.id);
}

/**
 * Every assertion runs inside a transaction that is then rolled back, as
 * the persist and read suites do. Committing fixtures would leave rows
 * behind for the backfill -- and every other query -- to trip over.
 */
async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await assert.rejects(withTransaction(async (tx) => {
    await fn(tx);
    throw new Error('__rollback__');
  }), /__rollback__/);
}

test('a pair is written once and found from both sides', opts, async () => {
  await inRollback(async (tx) => {
    const x = await media(tx, 'tmdb');
    const y = await media(tx, 'tvdb');
    assert.equal(await linkVersions(tx, x, y), true);
    assert.deepEqual(await versionsOf(tx, x), [y]);
    assert.deepEqual(await versionsOf(tx, y), [x], 'visible from the far side too');
  });
});

test('the same pair offered again, in either order, writes nothing', opts, async () => {
  // The resolve path re-offers a link on every stale lookup, so this
  // happens constantly and must be silent rather than an error.
  await inRollback(async (tx) => {
    const x = await media(tx, 'tmdb');
    const y = await media(tx, 'tvdb');
    assert.equal(await linkVersions(tx, x, y), true);
    assert.equal(await linkVersions(tx, x, y), false);
    assert.equal(await linkVersions(tx, y, x), false, 'order is not a new fact');
    const n = await tx.execute(sql`
      SELECT count(*)::int AS n FROM media_versions WHERE a = ${x}::uuid OR b = ${x}::uuid`);
    assert.equal(n.rows[0]?.n, 1);
  });
});

test('a row is not a version of itself', opts, async () => {
  await inRollback(async (tx) => {
    const x = await media(tx, 'tmdb');
    assert.equal(await linkVersions(tx, x, x), false, 'no row, and no constraint violation');
    assert.deepEqual(await versionsOf(tx, x), []);
  });
});

test('an unlinked row has no versions', opts, async () => {
  await inRollback(async (tx) => {
    assert.deepEqual(await versionsOf(tx, await media(tx, 'tmdb')), []);
  });
});

test('two shows with one title are not cross-linked', opts, async () => {
  // The Office (US, 2005) and The Office (UK, 2001) are both held by both
  // providers. Matching on title alone yields n*m pairs -- four here, two
  // of them joining a US row to a UK one.
  await inRollback(async (tx) => {
    const ids: Record<string, string> = {};
    for (const [key, provider, year] of [
      ['usTmdb', 'tmdb', 2005], ['usTvdb', 'tvdb', 2005],
      ['ukTmdb', 'tmdb', 2001], ['ukTvdb', 'tvdb', 2001],
    ] as const) {
      const r = await tx.execute(sql`
        INSERT INTO media (category, kind, title, sort_title, year, provider, provider_ref, raw, raw_fetched_at)
        VALUES ('tv','series','The Office','office', ${year}, ${provider}::provider,
                ${`${key}-${crypto.randomUUID()}`}, '{}'::jsonb, now())
        RETURNING id`);
      ids[key] = String(r.rows[0]?.id);
    }
    const pairs = await seriesVersionCandidates(tx);
    const found = pairs.map((p) => [p.aId, p.bId].sort().join('|')).sort();
    const want = [
      [ids.usTmdb ?? '', ids.usTvdb ?? ''].sort().join('|'),
      [ids.ukTmdb ?? '', ids.ukTvdb ?? ''].sort().join('|'),
    ].sort();
    assert.deepEqual(found, want, 'the US pair and the UK pair, and nothing crossing them');
  });
});

test('a candidate carries what a human needs to judge it', opts, async () => {
  // The whole safeguard on this heuristic is a person reading the list. A
  // line that prints only the title cannot be judged when the ambiguity IS
  // the title.
  await inRollback(async (tx) => {
    for (const provider of ['tmdb', 'tvdb'] as const) {
      await tx.execute(sql`
        INSERT INTO media (category, kind, title, sort_title, year, release_date, provider, provider_ref, raw, raw_fetched_at)
        VALUES ('tv','series','Judged','judged', 1999, '1999-03-31', ${provider}::provider,
                ${`j-${provider}-${crypto.randomUUID()}`}, '{}'::jsonb, now())`);
    }
    const pair = (await seriesVersionCandidates(tx)).find((p) => p.title === 'Judged');
    assert.ok(pair !== undefined);
    assert.equal(pair.year, 1999, 'the year is what separates two shows of one name');
    assert.ok(pair.aId.length > 0 && pair.bId.length > 0, 'and the ids identify the rows');
  });
});
