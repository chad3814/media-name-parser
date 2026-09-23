import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeSchema, seriesSchema, extendedEpisodeResponseSchema } from '../../lib/providers/tvdb/schema';
import { normalizeEpisode, normalizeSeason, normalizeSeries } from '../../lib/providers/tvdb/normalize';

const SERIES = seriesSchema.parse({ id: 121361, name: 'Game of Thrones', year: '2011' });
const EPISODE = {
  id: 3254641, seriesId: 121361, name: 'Winter Is Coming', aired: '2011-04-17',
  number: 1, seasonNumber: 1,
};

/** The shape verified live on 2026-09-23. */
const CHARACTERS = [
  { id: 1, peopleId: 247911, personName: 'David Benioff', name: null, peopleType: 'Writer', sort: 0 },
  { id: 2, peopleId: 247912, personName: 'Timothy Van Patten', name: null, peopleType: 'Director', sort: 0 },
  { id: 3, peopleId: 100, personName: 'Sean Bean', name: 'Eddard Stark', peopleType: 'Actor', sort: 1 },
  { id: 4, peopleId: 101, personName: 'Jason Momoa', name: 'Khal Drogo', peopleType: 'Guest Star', sort: 7 },
  { id: 5, peopleId: 102, personName: 'Someone', name: null, peopleType: 'Crew', sort: 0 },
];

function episodeWith(characters: unknown): ReturnType<typeof normalizeEpisode> {
  const parsedEpisode = episodeSchema.parse({ ...EPISODE, characters });
  return normalizeEpisode(normalizeSeason(normalizeSeries(SERIES), 1), parsedEpisode);
}

test('an episode carries its credits, mapped onto the shared roles', () => {
  const people = episodeWith(CHARACTERS).people;
  assert.deepEqual(people.map((p) => [p.name, p.role, p.characterName]), [
    ['Sean Bean', 'performer', 'Eddard Stark'],
    ['Jason Momoa', 'performer', 'Khal Drogo'],
    ['David Benioff', 'writer', null],
    ['Timothy Van Patten', 'director', null],
  ], 'performers first in billing order, then crew; an unmapped type is skipped');
});

test('the person is the ref, not the character record', () => {
  // `people` is keyed `unique(provider, provider_ref)`. `id` is the
  // character credit and differs per role, so using it would make a new
  // person row for every credit the same actor ever holds.
  const people = episodeWith(CHARACTERS).people;
  assert.equal(people[0]?.providerRef, 'tvdb:person:100');
  assert.ok(people.every((p) => p.providerRef.startsWith('tvdb:person:')),
    'namespaced like tmdb, so two catalogues cannot collide on a bare number');
});

test('billing order comes from sort', () => {
  const people = episodeWith(CHARACTERS).people;
  assert.equal(people.find((p) => p.name === 'Sean Bean')?.billingOrder, 1);
  assert.equal(people.find((p) => p.name === 'David Benioff')?.billingOrder, null,
    'crew are not billed');
});

test('absent credits are absent, not an error', () => {
  // House Hunters Renovation really does answer `characters: null`: it is
  // unscripted and has none recorded. That must still resolve.
  assert.deepEqual(episodeWith(null).people, []);
  assert.deepEqual(episodeWith(undefined).people, []);
  assert.deepEqual(episodeWith([]).people, []);
});

test('series and season carry no people, exactly as TMDB does', () => {
  // `normalizeSeries` and `normalizeSeason` in the tmdb provider both return
  // `people: []`; only movies and episodes are credited. Parity is the goal,
  // and it is also what keeps this to one extra call.
  const series = normalizeSeries(SERIES);
  assert.deepEqual(series.people, []);
  assert.deepEqual(normalizeSeason(series, 1).people, []);
});

test('the cast is capped, as the tmdb path caps it', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: i, peopleId: 1000 + i, personName: `Actor ${i}`, name: `Role ${i}`,
    peopleType: 'Actor', sort: i,
  }));
  const people = episodeWith(many).people;
  assert.equal(people.length, 15);
  assert.equal(people[0]?.name, 'Actor 0', 'the top-billed survive the cap');
});

test('the extended episode response parses', () => {
  const body = extendedEpisodeResponseSchema.parse({
    data: { ...EPISODE, characters: CHARACTERS },
  });
  assert.equal(body.data.characters.length, 5);
});
