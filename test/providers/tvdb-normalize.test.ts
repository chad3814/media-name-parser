import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesSchema, searchResultSchema, episodeSchema } from '../../lib/providers/tvdb/schema';
import {
  normalizeEpisode, normalizeSeason, normalizeSeries,
} from '../../lib/providers/tvdb/normalize';

test('a series status is an object on a record and a string in search', () => {
  // Verified live on 2026-09-20. One shape per endpoint, and a schema that
  // accepts only one of them rejects half the API.
  const record = seriesSchema.parse({
    id: 121361,
    name: 'Game of Thrones',
    slug: 'game-of-thrones',
    firstAired: '2011-04-17',
    lastAired: '2019-05-19',
    year: '2011',
    status: { id: 2, name: 'Ended', recordType: 'series', keepUpdated: false },
  });
  assert.equal(record.status?.name, 'Ended');

  const found = searchResultSchema.parse({
    id: 'series-121361',
    tvdb_id: '121361',
    name: 'Game of Thrones',
    first_air_time: '2011-04-17',
    year: '2011',
    status: 'Ended',
    slug: 'game-of-thrones',
  });
  assert.equal(found.tvdb_id, '121361', 'the bare id, not the "series-" prefixed one');
});

test('the chain runs series to season to episode, all tvdb', () => {
  const series = normalizeSeries(seriesSchema.parse({
    id: 121361,
    name: 'Game of Thrones',
    slug: 'game-of-thrones',
    firstAired: '2011-04-17',
    lastAired: '2019-05-19',
    year: '2011',
    status: { name: 'Ended' },
    overview: 'Seven noble families fight.',
  }));
  assert.equal(series.provider, 'tvdb');
  assert.equal(series.kind, 'series');
  assert.equal(series.category, 'tv');
  assert.equal(series.providerRef, '121361');
  assert.equal(series.year, 2011);
  assert.equal(series.details.series?.firstAirDate, '2011-04-17');
  assert.equal(series.details.series?.status, 'Ended');
  assert.deepEqual(series.externalIds, [{ source: 'tvdb', id: '121361' }]);

  const season = normalizeSeason(series, 1);
  assert.equal(season.kind, 'season');
  assert.equal(season.details.season?.seasonNumber, 1);
  assert.equal(season.parent, series);
  assert.equal(season.providerRef, '121361:s1', 'unique across series, not just within one');
  assert.deepEqual(season.externalIds, [], 'a synthesised season has no id of its own');

  const episode = normalizeEpisode(season, episodeSchema.parse({
    id: 3254641,
    seriesId: 121361,
    name: 'Winter Is Coming',
    aired: '2011-04-17',
    runtime: 62,
    overview: 'Eddard Stark is torn.',
    number: 1,
    seasonNumber: 1,
    absoluteNumber: 1,
  }));
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.providerRef, '3254641');
  assert.equal(episode.title, 'Winter Is Coming');
  assert.equal(episode.details.episode?.seasonNumber, 1);
  assert.equal(episode.details.episode?.episodeNumber, 1);
  assert.equal(episode.details.episode?.airDate, '2011-04-17');
  assert.equal(episode.year, 2011);
  assert.equal(episode.parent, season);
});

test('a year is read from firstAired when the year field is absent', () => {
  const series = normalizeSeries(seriesSchema.parse({ id: 1, name: 'X', firstAired: '1999-03-31' }));
  assert.equal(series.year, 1999);
});

test('an episode with no name still gets a title', () => {
  // A recently-aired episode often has no name yet, and an empty string
  // would be written straight into `media.title`.
  const series = normalizeSeries(seriesSchema.parse({ id: 1, name: 'X', year: '2020' }));
  const episode = normalizeEpisode(normalizeSeason(series, 2), episodeSchema.parse({
    id: 9, number: 4, seasonNumber: 2,
  }));
  assert.equal(episode.title, 'Episode 4');
  assert.equal(episode.year, 2020, 'an undated episode inherits the season year');
});
