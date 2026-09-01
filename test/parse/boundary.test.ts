import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../lib/parse/tokens';
import { findBoundary } from '../../lib/parse/boundary';
import { parseVideo } from '../../lib/parse/video';

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

// --- a bare title is not a release name -------------------------------------

test('a multi-word title keeps its last word', () => {
  // Reported from production: `The Dark Knight Rises.mp4` resolved to The Dark
  // Knight, and `Back to the Future II.mkv` to Back to the Future. The rule
  // that takes one trailing bare token as a release group fired on every
  // multi-word title, because a title's last word looks exactly like one.
  // Resolving to a real but wrong film -- usually the predecessor -- is the
  // worst available failure: it looks like a success.
  for (const [name, title] of [
    ['The Dark Knight Rises.mp4', 'The Dark Knight Rises'],
    ['Back to the Future II.mkv', 'Back to the Future II'],
    ['Moon Knight.mkv', 'Moon Knight'],
    ['Alien Covenant.mp4', 'Alien Covenant'],
    ['THE ROCKY HORROR PICTURE SHOW.mkv', 'THE ROCKY HORROR PICTURE SHOW'],
  ] as const) {
    const result = parseVideo('movies', name);
    assert.ok(result.ok, name);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.parsed.title, title, name);
    assert.equal(result.parsed.group, null, `${name} has no release group to find`);
  }
});

test('a real release still yields its group', () => {
  // The other half. The fix must not buy clean titles by losing every group:
  // an earlier attempt required the group to sit directly after the
  // vocabulary run, which fed 1,148 real corpus groups into their titles.
  for (const [name, group] of [
    ['The.Dark.Knight.Rises.2012.1080p.BluRay.x264-GRP.mkv', 'GRP'],
    ['Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb', 'UnKn0wn'],
    ['Aeon.Flux.2005.H264.AAC.5.1.3D.Conv.H-SBS.RealGoneKid.BennuRG.mkv', 'BennuRG'],
    ['Some.Movie.2012.1080p.BluRay.GRP.mkv', 'GRP'],
  ] as const) {
    const result = parseVideo('movies', name);
    assert.ok(result.ok, name);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.parsed.group, group, name);
  }
});

test('a compound trailing token carries its own evidence', () => {
  // `2003-REPACK-COMPLETE-UHD-BLURAY-COASTER` is a release tail wearing one
  // token: the vocabulary proving it is a release name is inside it. A bare
  // `2049` is not, which is why the separator is part of the test.
  const packed = parseVideo('movies', 'Bad.Boys.II.2003-REPACK-COMPLETE-UHD-BLURAY-COASTER.iso');
  assert.ok(packed.ok);
  if (!packed.ok) throw new Error('unreachable');
  assert.equal(packed.parsed.title, 'Bad Boys II');

  const numeric = parseVideo('movies', 'Blade Runner 2049.mkv');
  assert.ok(numeric.ok);
  if (!numeric.ok) throw new Error('unreachable');
  assert.equal(numeric.parsed.group, null, 'a title ending in a number is not a release');
});

test('a trailing year is a year, never a group', () => {
  for (const name of ['SUPERMAN II 1980.ISO', 'Jackie Brown -1997.mkv']) {
    const result = parseVideo('movies', name);
    assert.ok(result.ok, name);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.parsed.group, null, name);
    assert.ok(result.parsed.year !== null, `${name} should surface its year`);
  }
});
