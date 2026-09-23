import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldForMatch, foldTight } from '../../lib/parse/normalize';

test('a title wearing separators folds to the word underneath', () => {
  // `M*A*S*H` and `S.W.A.T.` are one word in punctuation, not several
  // words. The spaced fold keeps them apart from the form a filename
  // actually carries.
  assert.equal(foldForMatch('M*A*S*H'), 'm a s h', 'the spaced fold is unchanged');
  assert.equal(foldTight('M*A*S*H'), 'mash');
  assert.equal(foldTight('MASH'), 'mash');
  assert.equal(foldTight('S.W.A.T.'), 'swat');
  assert.equal(foldTight('SWAT'), 'swat');
});

test('it also closes the gap between hyphenated and joined spellings', () => {
  assert.equal(foldTight('Spider-Man'), 'spiderman');
  assert.equal(foldTight('Spider Man'), 'spiderman');
  assert.equal(foldTight('Spiderman'), 'spiderman');
});

test('it keeps everything the spaced fold already normalises', () => {
  assert.equal(foldTight('90 Day Fiancé'), foldTight('90 Day Fiance'));
  assert.equal(foldTight("The Handmaid's Tale"), 'thehandmaidstale');
});

test('two genuinely different titles do not collapse together', () => {
  assert.notEqual(foldTight('The Office'), foldTight('The Officer'));
  assert.notEqual(foldTight('Ghosts'), foldTight('Ghost'));
});
