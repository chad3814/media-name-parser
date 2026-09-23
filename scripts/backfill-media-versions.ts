import { withTransaction, closeDb } from '../lib/db/client';
import { linkVersions, seriesVersionCandidates } from '../lib/media/versions';

/**
 * Pairs series already stored that two providers both hold.
 *
 * The matching rule lives in `seriesVersionCandidates`, which is where its
 * reasoning and its tests are. This script is the human-facing half: it
 * prints what it would do and writes nothing without `--write`.
 *
 * That printout is the whole safeguard on a heuristic, so it carries what a
 * person needs to judge a line -- the year and both media ids, not just the
 * title. A first version printed title and provider refs alone, which made
 * four rows reading `series The Office` indistinguishable, and two of those
 * four joined the US show to the UK one.
 *
 * Any row appearing in more than one pair is called out, because that is
 * the cheapest signal that a title is ambiguous in a way the year did not
 * settle.
 *
 * The resolve path records links exactly, from the handover the composite
 * already makes. This exists only for rows that predate it.
 */
const write = process.argv.includes('--write');

const pairs = await withTransaction(seriesVersionCandidates);

const appearances = new Map<string, number>();
for (const pair of pairs) {
  for (const id of [pair.aId, pair.bId]) appearances.set(id, (appearances.get(id) ?? 0) + 1);
}

console.log(`${pairs.length} series pair(s) match on title and year:\n`);
for (const pair of pairs) {
  const ambiguous = (appearances.get(pair.aId) ?? 0) > 1 || (appearances.get(pair.bId) ?? 0) > 1;
  console.log(`  ${pair.title} (${pair.year ?? '----'})${ambiguous ? '   << AMBIGUOUS' : ''}`);
  console.log(`      ${pair.aRef}  ${pair.aId}`);
  console.log(`      ${pair.bRef}  ${pair.bId}`);
}

const ambiguous = [...appearances.values()].filter((n) => n > 1).length;
if (ambiguous > 0) {
  console.log(`\n${ambiguous} row(s) appear in more than one pair. Read those before writing:`
    + ' a title and year shared by two different shows would link them.');
}

if (write) {
  const written = await withTransaction(async (tx) => {
    let n = 0;
    for (const pair of pairs) {
      // Sequential on purpose: one short transaction, a handful of rows,
      // and a count that means what it says.
      // eslint-disable-next-line no-await-in-loop
      if (await linkVersions(tx, pair.aId, pair.bId)) n += 1;
    }
    return n;
  });
  console.log(`\nwrote ${written} new pair(s); ${pairs.length - written} already recorded`);
} else {
  console.log('\nNothing written. Re-run with --write to record these.');
}

await closeDb();
