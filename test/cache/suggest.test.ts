import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { withTransaction, closeDb } from '../../lib/db/client';
import { suggestForScene, nameWindows } from '../../lib/cache/suggest';
import { parseVideo } from '../../lib/parse/video';

const hasDb = (process.env.DATABASE_URL ?? '').length > 0;
const opts = hasDb ? {} : { skip: 'DATABASE_URL is not set' };

after(async () => { if (hasDb) await closeDb(); });

/** Rolls back, so fixtures never persist. */
async function inRollback(fn: (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<void>): Promise<void> {
  await assert.rejects(
    withTransaction(async (tx) => { await fn(tx); throw new Error('__rollback__'); }),
    (error: unknown) => {
      // Re-throw anything that is not our sentinel, so a real failure reports
      // itself instead of arriving as a regex mismatch.
      if (error instanceof Error && error.message.includes('__rollback__')) return true;
      throw error;
    },
  );
}

function sceneParse(name: string) {
  const result = parseVideo('xxx', name);
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  return result.parsed;
}

// --- windows: pure, no database ---------------------------------------------

test('windows run longest first, so a two-word name outranks its first word', () => {
  const windows = nameWindows('Maddie Wren Service');
  assert.equal(windows[0]?.text, 'maddie wren service');
  const texts = windows.map((w) => w.text);
  assert.ok(texts.indexOf('maddie wren') < texts.indexOf('maddie'),
    'the longer window must be offered first or the greedy pass picks the short one');
  assert.ok(texts.includes('maddie'), 'single tokens must be present: mononyms exist');
});

test('windows fold punctuation, because a filename spells names with dots', () => {
  assert.ok(nameWindows('Maddie.Wren').map((w) => w.text).includes('maddie wren'));
});

// --- against the database ----------------------------------------------------

test('a known site and a known performer are both offered', opts, async () => {
  await inRollback(async (tx) => {
    await tx.execute(sql`
      INSERT INTO provider_sites (provider, provider_ref, short_name, name)
      VALUES ('tpdb', '999001', 'suggestsite', 'Suggest Site')`);
    await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES ('tpdb', 'sug-1', 'Suggest Performer', 'Suggest Performer', '{}'::jsonb, now())`);

    const got = await suggestForScene(tx,
      sceneParse('SuggestSite.26.09.01.Suggest.Performer.Some.Title.XXX.2160p.mp4'));
    assert.equal(got?.site?.name, 'Suggest Site');
    assert.equal(got?.site?.providerRef, '999001');
    assert.deepEqual(got?.performers.map((p) => p.name), ['Suggest Performer']);
  });
});

test('a longer name wins over a performer whose name is one of its words', opts, async () => {
  // Both rows match a window. Returning each separately would offer a
  // performer the title does not actually name.
  await inRollback(async (tx) => {
    await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES ('tpdb', 'sug-2', 'Suggestia', 'Suggestia', '{}'::jsonb, now()),
             ('tpdb', 'sug-3', 'Suggestia Lange', 'Suggestia Lange', '{}'::jsonb, now())`);
    const got = await suggestForScene(tx, sceneParse('Nowhere.26.09.01.Suggestia.Lange.XXX.1080p.mp4'));
    assert.deepEqual(got?.performers.map((p) => p.name), ['Suggestia Lange']);
  });
});

test('an alias matches, because performers work under more than one name', opts, async () => {
  await inRollback(async (tx) => {
    await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, aliases, raw, raw_fetched_at)
      VALUES ('tpdb', 'sug-4', 'Canonical Name', 'Canonical Name',
              ARRAY['Working Alias'], '{}'::jsonb, now())`);
    const got = await suggestForScene(tx, sceneParse('Nowhere.26.09.01.Working.Alias.XXX.1080p.mp4'));
    assert.deepEqual(got?.performers.map((p) => p.name), ['Canonical Name']);
  });
});

test('a TMDB actor cannot be suggested for a scene', opts, async () => {
  // The same table holds ~90 film actors. Without the provider filter, a
  // scene title containing an ordinary name would surface one of them.
  await inRollback(async (tx) => {
    await tx.execute(sql`
      INSERT INTO people (provider, provider_ref, name, sort_name, raw, raw_fetched_at)
      VALUES ('tmdb', 'tmdb:person:999002', 'Filmonly Actor', 'Filmonly Actor', '{}'::jsonb, now())`);
    const got = await suggestForScene(tx, sceneParse('Nowhere.26.09.01.Filmonly.Actor.XXX.1080p.mp4'));
    assert.equal(got, null, 'a film actor is not a scene performer');
  });
});

test('recognising nothing is null, not an empty shell', opts, async () => {
  const got = await withTransaction((tx) =>
    suggestForScene(tx, sceneParse('NoSuchSiteAnywhere.26.09.01.No.Such.Person.XXX.1080p.mp4')));
  assert.equal(got, null);
});

test('a non-scene parse is never given suggestions', opts, async () => {
  const movie = parseVideo('movies', 'Outbreak.1995.1080p.BluRay.x264-GRP.mkv');
  assert.ok(movie.ok);
  if (!movie.ok) throw new Error('unreachable');
  const got = await withTransaction((tx) => suggestForScene(tx, movie.parsed));
  assert.equal(got, null, 'performers and sites are scene concepts');
});
