import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../lib/parse/tokens';
import { findBoundary } from '../../lib/parse/boundary';

function boundaryOf(stem: string) {
  return findBoundary(tokenize(stem));
}

test('a plain scene movie name', () => {
  const got = boundaryOf('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.deepEqual(got.titleTokens, ['Outbreak']);
  assert.equal(got.year, 1995);
  assert.equal(got.group, 'UnKn0wn');
});

test('the real group wins over a trailing DUAL re-release tag', () => {
  const got = boundaryOf('Die.Hard.1988.UHD.BluRay.2160p.DTS-HD.MA.5.1.DV.HEVC.HYBRID.REMUX-FraMeSToR.DUAL-LACTATO');
  assert.deepEqual(got.titleTokens, ['Die', 'Hard']);
  assert.equal(got.year, 1988);
  assert.equal(got.group, 'FraMeSToR');
});

test('a bare trailing group name is appended to the hyphenated one', () => {
  const got = boundaryOf('Cold.Storage.2026.1080p.BluRay.x265.SDR.DDP.Atmos.7.1.English-DarQ.HONE');
  assert.deepEqual(got.titleTokens, ['Cold', 'Storage']);
  assert.equal(got.year, 2026);
  assert.equal(got.group, 'DarQ.HONE');
});

test('hyphens inside a title survive', () => {
  const got = boundaryOf('John.Wick-Chapter.3-Parabellum.2019.1080p.BluRay.x265.SDR.DDP.Atmos.7.1.English-DarQ.HONE');
  assert.deepEqual(got.titleTokens, ['John', 'Wick-Chapter', '3-Parabellum']);
  assert.equal(got.year, 2019);
  assert.equal(got.group, 'DarQ.HONE');
});

test('a roman numeral stays in the title and the year still resolves', () => {
  const got = boundaryOf('Mortal.Kombat.II.2026.UHD.BluRay.1080p.DD+Atmos.5.1.DoVi.HDR10+.x265-SM737');
  assert.deepEqual(got.titleTokens, ['Mortal', 'Kombat', 'II']);
  assert.equal(got.year, 2026);
  assert.equal(got.group, 'SM737');
});

test('a digit that belongs to the title is not eaten', () => {
  const got = boundaryOf('The.Adventures.of.Super.Mario.Bros.3.FULLSCREEN.NTSC.USA.DVD5-AndreMor');
  assert.deepEqual(got.titleTokens, ['The', 'Adventures', 'of', 'Super', 'Mario', 'Bros', '3']);
  assert.equal(got.year, null);
  assert.equal(got.group, 'AndreMor');
});

test('a space-separated name yields the same title and group as its dotted twin', () => {
  const dotted = boundaryOf('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  const spaced = boundaryOf('Outbreak 1995 1080p BluRay REMUX AVC DTS-HD-MA 5 1-UnKn0wn');
  assert.deepEqual(spaced.titleTokens, dotted.titleTokens);
  assert.equal(spaced.group, dotted.group);
  assert.equal(spaced.year, dotted.year);
});

test('a library name with a Sonarr quality suffix and no group', () => {
  const got = boundaryOf('Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux');
  assert.equal(got.group, null);
  assert.equal(got.year, null);
});

test('a name that is entirely title has no group and no junk', () => {
  const got = boundaryOf('Interstellar');
  assert.deepEqual(got.titleTokens, ['Interstellar']);
  assert.deepEqual(got.junkTokens, []);
  assert.equal(got.group, null);
});
