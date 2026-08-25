import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMarker } from '../../lib/parse/markers';

test('a plain SxxExx marker', () => {
  const got = findMarker('The.Great.British.Sewing.Bee.S12E07.1080p.HDTV.H264-FTP');
  assert.deepEqual(got, {
    kind: 'episode', season: 12, episodes: [7], yearSeason: false, start: 29, end: 35,
  });
});

test('a hyphenated episode range expands to every episode it covers', () => {
  const got = findMarker('Star Trek - Prodigy - S02E01-E02 - Into the Breach Bluray-1080p Remux');
  assert.equal(got?.kind, 'episode');
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [1, 2]);
  assert.equal(got?.kind === 'episode' ? got.season : null, 2);
});

test('a repeated-E multi-episode marker expands too', () => {
  const got = findMarker('Show.Name.S02E04E05.1080p.WEB-DL');
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [4, 5]);
});

test('season zero is a special, not a missing season', () => {
  const got = findMarker("The Hitchhiker's Guide to the Galaxy - S00E22 - Recorded at the End of the Universe Bluray-1080p");
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 0);
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [22]);
});

test('a four-digit season is a year-season, not season 2013', () => {
  const got = findMarker('Koln.50667.S2013E015.German.1080p.RTLP.WEB-DL.AAC2.0.H.264-GLOTZE');
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 2013);
  assert.equal(got?.kind === 'episode' ? got.yearSeason : null, true);
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [15]);
});

test('a date sitting in the season slot is a date marker', () => {
  const got = findMarker('Millionaire.Hot.Seat.AU.S2026.08.25.1080p.WEBDL.h264-P147YPU5');
  assert.equal(got?.kind, 'date');
  assert.equal(got?.kind === 'date' ? got.date : null, '2026-08-25');
});

test('a season plus disc is a disc, never an episode', () => {
  const got = findMarker('The.Adventures.of.Jimmy.Neutron.Boy.Genius.FULLSCREEN.S03D03.NTSC.USA.DVD9-AndreMor');
  assert.equal(got?.kind, 'disc');
  assert.equal(got?.kind === 'disc' ? got.season : null, 3);
  assert.equal(got?.kind === 'disc' ? got.disc : null, 3);
});

test('a bare DISC with no season is still a disc', () => {
  const got = findMarker('The.Adventures.of.Super.Mario.Bros.3.FULLSCREEN.DISC3.NTSC.USA.DVD5-AndreMor');
  assert.equal(got?.kind, 'disc');
  assert.equal(got?.kind === 'disc' ? got.season : null, null);
  assert.equal(got?.kind === 'disc' ? got.disc : null, 3);
});

test('an ISO date in a library name', () => {
  const got = findMarker('Wheel of Fortune - 2026-03-23 - Hawaiian Vacation 1 HDTV-720p');
  assert.equal(got?.kind, 'date');
  assert.equal(got?.kind === 'date' ? got.date : null, '2026-03-23');
});

test('a dotted date in a scene name', () => {
  const got = findMarker('WWE.Monday.Night.RAW.2026.08.24.Satfeed.720p.HDTV.H264-Star');
  assert.equal(got?.kind, 'date');
  assert.equal(got?.kind === 'date' ? got.date : null, '2026-08-24');
});

test('a lowercase sxxexx marker', () => {
  const got = findMarker('the.block.au.s22e15.HDTV.H264-RBB');
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 22);
});

test('a bare season marker with no episode', () => {
  const got = findMarker('Some.Show.S04.1080p.WEB-DL-GRP');
  assert.equal(got?.kind, 'season');
  assert.equal(got?.kind === 'season' ? got.season : null, 4);
});

test('an NxNN marker', () => {
  const got = findMarker('Some.Show.2x04.HDTV-GRP');
  assert.equal(got?.kind, 'episode');
  assert.equal(got?.kind === 'episode' ? got.season : null, 2);
  assert.deepEqual(got?.kind === 'episode' ? got.episodes : null, [4]);
});

test('a roman numeral after the word Episode is not a marker', () => {
  const got = findMarker('Star.Wars.Episode.VI.Return.of.the.Jedi.1983.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD7.1.Atmos-3L.DUAL-LACTATO');
  assert.equal(got, null);
});

test('a roman numeral in a movie title is not a marker either', () => {
  const got = findMarker('Mortal.Kombat.II.2026.UHD.BluRay.1080p.DD+Atmos.5.1.DoVi.HDR10+.x265-SM737');
  assert.equal(got, null);
});

test('a movie with a year and no markers has no marker', () => {
  const got = findMarker('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.equal(got, null);
});

test('an audio channel layout is never mistaken for an NxNN marker', () => {
  const got = findMarker('Aliens.1986.Special.Edition.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1.DUAL-BiOMA');
  assert.equal(got, null);
});
