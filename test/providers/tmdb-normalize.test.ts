import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmdbMovieDetails, tmdbTvDetails, tmdbSeasonDetails,
} from '../../lib/providers/tmdb/schema';
import {
  normalizeMovie, normalizeSeries, normalizeSeason, normalizeEpisode,
  providerRefFor, sortTitleOf,
} from '../../lib/providers/tmdb/normalize';

const MOVIE = {
  id: 603,
  title: 'The Matrix',
  original_title: 'The Matrix',
  release_date: '1999-03-30',
  overview: 'A hacker learns the truth.',
  runtime: 136,
  imdb_id: 'tt0133093',
  tagline: 'Welcome to the Real World.',
  belongs_to_collection: { id: 2344, name: 'The Matrix Collection' },
  a_field_tmdb_added_later: 'must not break parsing',
  credits: {
    cast: [
      { id: 6384, name: 'Keanu Reeves', character: 'Neo', order: 0 },
      { id: 2975, name: 'Laurence Fishburne', character: 'Morpheus', order: 1 },
    ],
    crew: [
      { id: 9339, name: 'Lana Wachowski', job: 'Director', department: 'Directing' },
      { id: 9340, name: 'Lilly Wachowski', job: 'Writer', department: 'Writing' },
      { id: 1, name: 'Someone', job: 'Best Boy', department: 'Lighting' },
    ],
  },
};

const TV = {
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  last_air_date: '2013-09-29',
  status: 'Ended',
  overview: 'A chemistry teacher.',
  origin_country: ['US'],
};

const SEASON = {
  id: 3573,
  season_number: 2,
  name: 'Season 2',
  air_date: '2009-03-08',
  overview: '',
  episodes: [
    {
      id: 62092,
      episode_number: 4,
      season_number: 2,
      name: 'Down',
      air_date: '2009-03-29',
      overview: 'Things get worse.',
      crew: [{ id: 5, name: 'John Dahl', job: 'Director', department: 'Directing' }],
      guest_stars: [{ id: 7, name: 'Guest One', character: 'Clerk', order: 3 }],
    },
  ],
};

test('provider refs are the natural keys the schema deduplicates on', () => {
  assert.equal(providerRefFor('movie', [603]), 'tmdb:movie:603');
  assert.equal(providerRefFor('tv', [1396]), 'tmdb:tv:1396');
  assert.equal(providerRefFor('season', [1396, 2]), 'tmdb:tv:1396:2');
  assert.equal(providerRefFor('episode', [1396, 2, 4]), 'tmdb:tv:1396:2:4');
});

test('sortTitleOf strips a leading article and lowercases', () => {
  assert.equal(sortTitleOf('The Matrix'), 'matrix');
  assert.equal(sortTitleOf('A Quiet Place'), 'quiet place');
  assert.equal(sortTitleOf('An Education'), 'education');
  assert.equal(sortTitleOf('Alien'), 'alien');
  assert.equal(sortTitleOf('The The'), 'the');
});

test('an unexpected extra field does not break validation', () => {
  assert.equal(tmdbMovieDetails.parse(MOVIE).id, 603);
});

test('a movie normalizes with details and only the interesting crew', () => {
  const media = normalizeMovie(tmdbMovieDetails.parse(MOVIE));
  assert.equal(media.kind, 'movie');
  assert.equal(media.category, 'movies');
  assert.equal(media.providerRef, 'tmdb:movie:603');
  assert.equal(media.title, 'The Matrix');
  assert.equal(media.sortTitle, 'matrix');
  assert.equal(media.releaseDate, '1999-03-30');
  assert.equal(media.year, 1999);
  assert.equal(media.parent, null);
  assert.equal(media.details.movie?.imdbId, 'tt0133093');
  assert.equal(media.details.movie?.runtimeMinutes, 136);
  assert.equal(media.details.movie?.collectionName, 'The Matrix Collection');

  const roles = media.people.map((p) => `${p.role}:${p.name}`);
  assert.ok(roles.includes('director:Lana Wachowski'));
  assert.ok(roles.includes('writer:Lilly Wachowski'));
  assert.ok(roles.includes('performer:Keanu Reeves'));
  assert.ok(
    !roles.some((r) => r.includes('Best Boy') || r.includes('Someone')),
    'a Best Boy is not a role this service models',
  );
  const neo = media.people.find((p) => p.name === 'Keanu Reeves');
  assert.equal(neo?.characterName, 'Neo');
  assert.equal(neo?.billingOrder, 0);
});

test('a series normalizes with its air dates and status', () => {
  const media = normalizeSeries(tmdbTvDetails.parse(TV));
  assert.equal(media.kind, 'series');
  assert.equal(media.category, 'tv');
  assert.equal(media.providerRef, 'tmdb:tv:1396');
  assert.equal(media.year, 2008);
  assert.equal(media.details.series?.status, 'Ended');
  assert.equal(media.parent, null);
});

test('a season hangs off its series and an episode off its season', () => {
  const series = normalizeSeries(tmdbTvDetails.parse(TV));
  const season = normalizeSeason(series, tmdbSeasonDetails.parse(SEASON));
  assert.equal(season.kind, 'season');
  assert.equal(season.providerRef, 'tmdb:tv:1396:2');
  assert.equal(season.parent?.providerRef, 'tmdb:tv:1396');
  assert.equal(season.details.season?.seasonNumber, 2);

  const raw = tmdbSeasonDetails.parse(SEASON).episodes[0];
  assert.ok(raw !== undefined);
  const episode = normalizeEpisode(season, raw);
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.providerRef, 'tmdb:tv:1396:2:4');
  assert.equal(episode.title, 'Down');
  assert.equal(episode.parent?.providerRef, 'tmdb:tv:1396:2');
  assert.equal(episode.parent?.parent?.providerRef, 'tmdb:tv:1396');
  assert.equal(episode.details.episode?.episodeNumber, 4);
  assert.equal(episode.details.episode?.airDate, '2009-03-29');
  assert.ok(episode.people.some((p) => p.role === 'director' && p.name === 'John Dahl'));
  assert.ok(episode.people.some((p) => p.role === 'performer' && p.name === 'Guest One'));
});

test('an empty release date yields a null date and a null year, not NaN', () => {
  const media = normalizeMovie(tmdbMovieDetails.parse({ ...MOVIE, release_date: '' }));
  assert.equal(media.releaseDate, null);
  assert.equal(media.year, null);
});

test('a missing collection and a missing runtime are null, not undefined', () => {
  const media = normalizeMovie(tmdbMovieDetails.parse({
    id: 1, title: 'X', release_date: '2001-01-01',
    belongs_to_collection: null, runtime: null, imdb_id: null,
  }));
  assert.equal(media.details.movie?.collectionName, null);
  assert.equal(media.details.movie?.runtimeMinutes, null);
  assert.deepEqual(media.people, []);
});
