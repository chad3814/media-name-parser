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
