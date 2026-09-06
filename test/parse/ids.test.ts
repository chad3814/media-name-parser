import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExternalId } from '../../lib/parse/ids';
import { parseVideo } from '../../lib/parse/video';
import { normalizeKey } from '../../lib/parse/normalize';

test('every source the convention uses is recognised', () => {
  for (const [stem, source, id] of [
    ['The Matrix (1999) {tmdb-603}', 'tmdb', '603'],
    ['The Matrix (1999) {imdb-tt0133093}', 'imdb', 'tt0133093'],
    ['Moon Knight {tvdb-368611}', 'tvdb', '368611'],
    ['Scene {tpdb-2012507}', 'tpdb', '2012507'],
    ['Upper case {TMDB-603}', 'tmdb', '603'],
  ] as const) {
    const got = extractExternalId(stem);
    assert.equal(got?.id.source, source, stem);
    assert.equal(got?.id.id, id, stem);
  }
});

test('the token is lifted out of the stem, not left in it', () => {
  // Left in place it reads as ordinary text: `{tmdb-603}` became the release
  // *group* on a movies lookup and part of the title on an xxx one.
  const got = extractExternalId('The Matrix (1999) {tmdb-603}');
  assert.equal(got?.rest, 'The Matrix (1999)');
  assert.ok(!(got?.rest ?? '').includes('603'));
});

test('a name with no token is left completely alone', () => {
  assert.equal(extractExternalId('The Matrix (1999)'), null);
  assert.equal(extractExternalId('Not {a-token} either'), null, 'an unknown source is not an id');
});

test('the leftmost token wins when a name contradicts itself', () => {
  const got = extractExternalId('Film {tmdb-1} {imdb-tt2}');
  assert.equal(got?.id.source, 'tmdb');
  assert.equal(got?.id.id, '1');
});

test('the id reaches the parse and keeps the title clean', () => {
  for (const [category, name] of [
    ['movies', 'The Matrix (1999) {tmdb-603}.mkv'],
    ['tv', 'Moon Knight - S01E01 {tvdb-368611}.mkv'],
    ['xxx', 'RKPrime.26.07.13.Lola.Valentine {tpdb-2012507}.mp4'],
  ] as const) {
    const result = parseVideo(category, name);
    assert.ok(result.ok, name);
    if (!result.ok) throw new Error('unreachable');
    assert.ok(result.parsed.externalId !== undefined, `${name} should carry its id`);
    assert.ok(!result.parsed.title.includes('tmdb'), name);
    assert.ok(!result.parsed.title.includes('tpdb'), name);
    assert.ok(!(result.parsed.group ?? '').includes('-'), `${name} group: ${String(result.parsed.group)}`);
  }
});

test('a parse without an id does not carry the key at all', () => {
  // `exactOptionalPropertyTypes` makes an absent optional property genuinely
  // absent, so it does not serialise -- which is what keeps the 13,000
  // committed golden expectations unchanged.
  const result = parseVideo('movies', 'The Matrix (1999).mkv');
  assert.ok(result.ok);
  if (!result.ok) throw new Error('unreachable');
  const serialised = JSON.parse(JSON.stringify(result.parsed)) as Record<string, unknown>;
  assert.ok(!('externalId' in serialised));
});

test('two ids under one title keep separate cache keys', () => {
  // The stem is stripped for parsing, but `normalizeKey` reads the raw input
  // and keeps the token. Sharing a key would let `findResolvedSibling` serve
  // one record as the answer for the other.
  assert.notEqual(normalizeKey('Movie {tmdb-1}.mkv'), normalizeKey('Movie {tmdb-2}.mkv'));
});
