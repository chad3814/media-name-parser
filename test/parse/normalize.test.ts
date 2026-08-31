import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInput, normalizeKey, foldForMatch } from '../../lib/parse/normalize';

test('splitInput separates stem, extension, and ancestors nearest-first', () => {
  const got = splitInput('Movies/Interstellar (2014)/00136.m2ts');
  assert.equal(got.stem, '00136');
  assert.equal(got.extension, 'm2ts');
  assert.deepEqual(got.ancestors, ['Interstellar (2014)', 'Movies']);
  assert.equal(got.isMedia, true);
});

test('splitInput handles a bare release name with no directories', () => {
  const got = splitInput('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  assert.equal(got.stem, 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn');
  assert.equal(got.extension, 'nzb');
  assert.deepEqual(got.ancestors, []);
  assert.equal(got.isMedia, true);
});

test('a dotfile is not an extension and is not media', () => {
  const got = splitInput('TV Shows/Moon Knight/.plexmatch');
  assert.equal(got.stem, '.plexmatch');
  assert.equal(got.extension, null);
  assert.equal(got.isMedia, false);
});

test('a sidecar file is recognised but is not media', () => {
  const got = splitInput('TV Shows/Moon Knight/Season 1/Moon Knight - S01E01.srt');
  assert.equal(got.extension, 'srt');
  assert.equal(got.isMedia, false);
});

test('iso, m2ts and nzb all count as media', () => {
  for (const ext of ['iso', 'm2ts', 'nzb', 'mkv', 'mp4']) {
    assert.equal(splitInput(`Something.2020.${ext}`).isMedia, true, ext);
  }
});

test('surrounding whitespace does not make a media file unrecognisable', () => {
  // A name pasted from a shell or a spreadsheet arrives with a trailing space,
  // which landed in the extension: `mkv ` is not in MEDIA_EXTENSIONS, so a
  // real release was refused as "not a media file".
  const name = 'The.Guardians.of.the.Galaxy.Holiday.Special.2022.2160p.WEB-DL.DDP5.1.H.265-NTb.mkv';
  for (const [label, padded] of [
    ['trailing space', `${name} `],
    ['leading space', ` ${name}`],
    ['trailing newline', `${name}\n`],
    ['trailing tab', `${name}\t`],
    ['non-breaking space', `${name}\u00A0`],
  ] as const) {
    const got = splitInput(padded);
    assert.equal(got.extension, 'mkv', label);
    assert.equal(got.isMedia, true, label);
  }
});

test('trimming leaves the key of an already-clean name untouched', () => {
  // The stem never saw the trailing space -- it landed in the extension -- so
  // no stored key changes and nothing needs re-resolving.
  const name = 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb';
  assert.equal(normalizeKey(`${name} `), normalizeKey(name));
  assert.equal(normalizeKey(name), 'outbreak 1995 1080p bluray remux avc dts hd ma 5 1 unkn0wn');
});

test('the two real spellings of Outbreak 1995 share one normalized key', () => {
  const dotted = normalizeKey('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const spaced = normalizeKey('Outbreak 1995 1080p BluRay REMUX AVC DTS-HD-MA 5 1-UnKn0wn.nzb');
  assert.equal(dotted, spaced);
  assert.equal(dotted, 'outbreak 1995 1080p bluray remux avc dts hd ma 5 1 unkn0wn');
});

test('normalizeKey strips bracketing so a bracketed year matches a bare one', () => {
  assert.equal(
    normalizeKey('Cold.Storage.[2026].[1080p.BluRay.x265.SDR.DDP.Atmos.7.1.English-DarQ.HONE].nzb'),
    'cold storage 2026 1080p bluray x265 sdr ddp atmos 7 1 english darq hone',
  );
});

test('normalizeKey keeps directory structure so two shows never collide', () => {
  const a = normalizeKey('TV Shows/Ghosts (US)/Season 5/Ghosts (US) - S05E12 - The List WEBRip-1080p.mkv');
  const b = normalizeKey('TV Shows/Ghosts (2019)/Season 5/Ghosts (2019) - S05E12 - The List WEBRip-1080p.mkv');
  assert.notEqual(a, b);
  assert.equal(a, 'tv shows/ghosts us/season 5/ghosts us s05e12 the list webrip 1080p');
});

test('foldForMatch removes diacritics, apostrophes and stray punctuation', () => {
  assert.equal(foldForMatch('90 Day Fiancé'), '90 day fiance');
  assert.equal(foldForMatch('What If…!'), 'what if');
  assert.equal(foldForMatch("The Hitchhiker's Guide to the Galaxy"), 'the hitchhikers guide to the galaxy');
  assert.equal(foldForMatch('Marvel’s Agents of S.H.I.E.L.D'), 'marvels agents of s h i e l d');
});
