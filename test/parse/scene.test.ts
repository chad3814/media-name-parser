import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneDate } from '../../lib/parse/scene';

test('a two-digit year expands to 20YY', () => {
  const got = parseSceneDate('22.07.07.Ruby.Redbottom');
  assert.deepEqual(got, { iso: '2022-07-07', rest: 'Ruby.Redbottom' });
});

test('a four-digit year is taken as written', () => {
  const got = parseSceneDate('2022.07.07.Ruby.Redbottom');
  assert.deepEqual(got, { iso: '2022-07-07', rest: 'Ruby.Redbottom' });
});

test('a month over 12 is not a date', () => {
  // 1.6% of date-shaped triples in the corpus are not dates. Letting one
  // through would put a wrong released_on on a scene and query TPDB for a
  // day that does not exist.
  assert.equal(parseSceneDate('22.13.07.Something'), null);
});

test('a day over 31 is not a date', () => {
  assert.equal(parseSceneDate('22.07.45.Something'), null);
});

test('a two-component YYYY.MM is not a date', () => {
  // `2026.07.Cleo.Mercury` occurs in the corpus: a year and a month, no day.
  assert.equal(parseSceneDate('2026.07.Cleo.Mercury'), null);
});

test('the date must start the text', () => {
  assert.equal(parseSceneDate('Something.22.07.07.Else'), null);
});

test('hyphen and underscore separators are accepted', () => {
  assert.equal(parseSceneDate('22-07-07-Name')?.iso, '2022-07-07');
  assert.equal(parseSceneDate('22_07_07_Name')?.iso, '2022-07-07');
});

test('the rule uses no clock, so it cannot drift', () => {
  // The parse feeds normalized_key. A year sanity-checked against today would
  // make one name produce two cache keys on two different days.
  const source = parseSceneDate.toString();
  assert.ok(!source.includes('Date.now'), 'parseSceneDate must not read the clock');
  assert.ok(!source.includes('new Date'), 'parseSceneDate must not read the clock');
});
