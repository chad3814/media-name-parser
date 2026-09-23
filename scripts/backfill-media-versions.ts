import { sql } from 'drizzle-orm';
import { withTransaction, closeDb } from '../lib/db/client';
import { linkVersions } from '../lib/media/versions';

/**
 * Pairs media rows already stored that two providers both hold.
 *
 * Series only, and that restriction is load-bearing. Matching is on
 * `lower(sort_title)`, and across every kind that join finds 2,994 pairs in
 * production against 13 real ones: episodes are routinely titled `Episode
 * 1` or `Part Two` and seasons `Season 1`, so the same title under two
 * providers means nothing below the series. A dry run over an empty
 * development database would not have shown it.
 *
 * Series titles are distinctive enough for the heuristic to hold, and it is
 * acceptable here in a way it is not on the resolve path: this runs once,
 * over a set small enough to read in full, and prints every pair before it
 * writes anything. Nothing is written without `--write`.
 *
 * It also matches what the resolve path records, which is series links and
 * nothing else -- the handover establishes that two series are the same and
 * says nothing about their episodes. This exists only for rows that predate
 * it.
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
     WHERE a.kind = 'series'
     ORDER BY a.title`);
  return rows.rows;
});

console.log(`${pairs.length} pair(s) match on kind and title:\n`);
for (const pair of pairs) {
  console.log(`  ${String(pair.kind).padEnd(8)} ${String(pair.title)}`);
  console.log(`      ${String(pair.a_provider)}:${String(pair.a_ref)}`
    + `  <->  ${String(pair.b_provider)}:${String(pair.b_ref)}`);
}

if (write) {
  const written = await withTransaction(async (tx) => {
    let n = 0;
    for (const pair of pairs) {
      // Sequential on purpose: one short transaction, a handful of rows,
      // and a count that means what it says.
      // eslint-disable-next-line no-await-in-loop
      if (await linkVersions(tx, String(pair.a_id), String(pair.b_id))) n += 1;
    }
    return n;
  });
  console.log(`\nwrote ${written} new pair(s); ${pairs.length - written} already recorded`);
} else {
  console.log('\nNothing written. Re-run with --write to record these.');
}

await closeDb();
