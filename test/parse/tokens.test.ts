import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, classifyToken, isJunk, splitGroupSuffix, expandCompound } from '../../lib/parse/tokens';

test('an audio channel layout stays one token', () => {
  assert.deepEqual(tokenize('DTS-HD.MA.5.1'), ['DTS-HD', 'MA', '5.1']);
});

test('a channel layout fused to a group suffix stays one token', () => {
  assert.deepEqual(
    tokenize('Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn'),
    ['Outbreak', '1995', '1080p', 'BluRay', 'REMUX', 'AVC', 'DTS-HD-MA', '5.1-UnKn0wn'],
  );
});

test('a bare digit that is part of a title is left alone', () => {
  const got = tokenize('The.Adventures.of.Super.Mario.Bros.3.FULLSCREEN.DISC3.NTSC.USA.DVD5-AndreMor');
  assert.ok(got.includes('3'), `expected a standalone '3' in ${JSON.stringify(got)}`);
  assert.equal(isJunk('3'), false);
});

test('a codec written with a dot stays one token', () => {
  assert.deepEqual(tokenize('AAC2.0.H.264'), ['AAC2.0', 'H.264']);
});

test('an acronym run of single letters is rejoined', () => {
  assert.deepEqual(
    tokenize('Marvels.Agents.of.S.H.I.E.L.D.S01E01'),
    ['Marvels', 'Agents', 'of', 'S.H.I.E.L.D', 'S01E01'],
  );
});

test('punctuation-only parts are dropped', () => {
  assert.deepEqual(
    tokenize('Ghosts - S05E12 - The List WEBRip-1080p'),
    ['Ghosts', 'S05E12', 'The', 'List', 'WEBRip-1080p'],
  );
});

test('every quality class is recognised', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['2160p', 'resolution'], ['1080p', 'resolution'], ['480p', 'resolution'],
    ['BluRay', 'source'], ['Blu-ray', 'source'], ['WEB-DL', 'source'],
    ['WEBDL', 'source'], ['WEBRip', 'source'], ['HDTV', 'source'],
    ['DVD9', 'source'], ['REMUX', 'source'], ['Satfeed', 'source'],
    ['UHD', 'source'],
    ['x265', 'videoCodec'], ['H.264', 'videoCodec'], ['HEVC', 'videoCodec'],
    ['AVC', 'videoCodec'],
    ['DTS-HD', 'audioCodec'], ['TrueHD7.1', 'audioCodec'], ['Atmos', 'audioCodec'],
    ['DDP', 'audioCodec'], ['DD+Atmos', 'audioCodec'], ['AAC2.0', 'audioCodec'],
    ['5.1', 'audioCodec'], ['MA', 'audioCodec'],
    ['HDR10+', 'hdr'], ['DoVi', 'hdr'], ['DV', 'hdr'], ['SDR', 'hdr'], ['10bit', 'hdr'],
    ['MULTi', 'language'], ['NORDiC', 'language'], ['VFI', 'language'],
    ['MultiSubs', 'language'], ['DUAL', 'language'], ['German', 'language'],
    ['REPACK', 'edition'], ['Unrated', 'edition'], ['FULLSCREEN', 'edition'],
    ['WIDESCREEN', 'edition'], ['Proper', 'edition'], ['forced', 'edition'],
    ['NF', 'streaming'], ['AMZN', 'streaming'], ['MAX', 'streaming'],
    ['DSNP', 'streaming'], ['OSN', 'streaming'], ['RTLP', 'streaming'],
    ['3D', 'threeD'], ['Half-SBS', 'threeD'], ['RBG', 'threeD'],
    ['NTSC', 'ancillary'], ['USA', 'ancillary'], ['HYBRID', 'ancillary'],
    ['60fps', 'ancillary'],
  ];
  for (const [token, expected] of cases) {
    assert.equal(classifyToken(token), expected, `${token} classified wrongly`);
  }
});

test('a title word is not junk', () => {
  for (const token of ['Outbreak', 'Interstellar', 'Wick', 'Prodigy', 'Ghosts', '3', 'Jedi']) {
    assert.equal(isJunk(token), false, `${token} was treated as junk`);
  }
});

test('splitGroupSuffix finds the group hiding behind a junk token', () => {
  assert.deepEqual(splitGroupSuffix('5.1-UnKn0wn'), { head: '5.1', group: 'UnKn0wn' });
  assert.deepEqual(splitGroupSuffix('5.1-FraMeSToR'), { head: '5.1', group: 'FraMeSToR' });
  assert.deepEqual(splitGroupSuffix('DUAL-LACTATO'), { head: 'DUAL', group: 'LACTATO' });
  assert.deepEqual(splitGroupSuffix('Atmos-3L'), { head: 'Atmos', group: '3L' });
  assert.deepEqual(splitGroupSuffix('English-DarQ'), { head: 'English', group: 'DarQ' });
});

test('splitGroupSuffix refuses a hyphenated token that is entirely vocabulary', () => {
  assert.equal(splitGroupSuffix('WEB-DL'), null);
  assert.equal(splitGroupSuffix('DTS-HD'), null);
  assert.equal(splitGroupSuffix('Blu-ray'), null);
  assert.equal(splitGroupSuffix('Half-SBS'), null);
});

test('a Sonarr Source-Resolution pair is vocabulary, not a group suffix', () => {
  for (const token of ['Bluray-2160p', 'HDTV-720p', 'WEBDL-1080p', 'WEBRip-1080p']) {
    assert.equal(classifyToken(token), 'source', `${token} should classify as a source`);
    assert.equal(splitGroupSuffix(token), null, `${token} is not a group suffix`);
  }
});

test('splitGroupSuffix refuses a hyphen inside a title', () => {
  assert.equal(splitGroupSuffix('Wick-Chapter'), null);
});

test('expandCompound splits a junk pair and leaves everything else alone', () => {
  assert.deepEqual(expandCompound('Bluray-2160p'), ['Bluray', '2160p']);
  assert.deepEqual(expandCompound('HDTV-720p'), ['HDTV', '720p']);
  assert.deepEqual(expandCompound('5.1-UnKn0wn'), ['5.1-UnKn0wn']);
  assert.deepEqual(expandCompound('Wick-Chapter'), ['Wick-Chapter']);
  assert.deepEqual(expandCompound('Outbreak'), ['Outbreak']);
});
