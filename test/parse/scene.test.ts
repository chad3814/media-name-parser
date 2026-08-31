import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneDate, parseScene } from '../../lib/parse/scene';
import { parseVideo } from '../../lib/parse/video';

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

function scene(name: string) {
  const r = parseVideo('xxx', name);
  assert.ok(r.ok, `expected a parse, got: ${r.ok ? '' : r.refusal}`);
  assert.equal(r.parsed.kind, 'scene');
  if (r.parsed.kind !== 'scene') throw new Error('unreachable');
  return r.parsed;
}

test('the anchored form decomposes into site, date, title, group and quality', () => {
  // The worked example from the spec, supplied by the project owner.
  const p = scene('SpankMonster.22.07.07.Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb');
  assert.equal(p.site, 'SpankMonster');
  assert.equal(p.releasedOn, '2022-07-07');
  assert.equal(p.group, 'WRB');
  assert.equal(p.quality.resolution, '2160p');
  assert.equal(p.title, 'Ruby Redbottom And Octavia Red');
});

test('the XXX tag and the container never reach the title', () => {
  const p = scene('AnalMom.26.07.11.Katie.Morgan.XXX.2160p.MP4-KTR.nzb');
  assert.ok(!/xxx/i.test(p.title), `XXX leaked into the title: ${p.title}`);
  assert.ok(!/mp4/i.test(p.title), `MP4 leaked into the title: ${p.title}`);
  assert.equal(p.title, 'Katie Morgan');
});

test('performers are left in the title, unsplit', () => {
  // A decision, not an omission: see the spec's Performers section. TPDB
  // returns canonical performers, and a corpus-mined dictionary caps at 58%
  // recall and cannot represent mononyms.
  const p = scene('SpankMonster.22.07.07.Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb');
  assert.equal(p.title, 'Ruby Redbottom And Octavia Red');
});

test('the site falls back to the nearest ancestor', () => {
  const p = scene('Scenes/18Lust/18Lust - Finally Got To Fuck Kiara Alternative Angles.mp4');
  assert.equal(p.site, '18Lust');
  assert.equal(p.releasedOn, null);
  assert.ok(p.hints.fromDirectories.includes('18Lust'));
});

test('the filename beats the directory, and the directory is still recorded', () => {
  const p = scene('Scenes/2ChicksSameTime/NaughtyAmerica.14.04.25.bonnie.mp4');
  assert.equal(p.site, 'NaughtyAmerica', 'the filename head wins');
  assert.ok(p.hints.fromDirectories.includes('2ChicksSameTime'),
    'the directory must survive so a disagreement is inspectable');
});

test('a name with neither site nor date parses rather than refusing', () => {
  const p = scene('777REMIX.Kenzies.Megamix.The.Best.Little.Whore.In.The.World.4K.nzb');
  assert.equal(p.releasedOn, null);
  assert.ok(p.title.length > 0, 'a best-effort title is still an answer');
});

test('a sidecar in the xxx category still refuses', () => {
  const r = parseVideo('xxx', 'Scenes/18Lust/cover.jpg');
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  assert.match(r.refusal, /not a media file/);
});

test('xxx is junk for a scene but NOT for a movie', () => {
  // xXx (2002) and xXx: Return of Xander Cage are real releases. Putting the
  // XXX tag in the global junk vocabulary would make them unparseable, which
  // is why the scene vocabulary is scene-local.
  const movie = parseVideo('movies', 'xXx.2002.1080p.BluRay.x264-GRP.mkv');
  assert.ok(movie.ok);
  if (!movie.ok) throw new Error('unreachable');
  assert.equal(movie.parsed.title.toLowerCase(), 'xxx');
});

test('a season marker in an xxx name sets categoryDisagreement', () => {
  const p = scene('SomeSite.22.07.07.S01E02.Something.XXX.1080p.mp4');
  assert.equal(p.categoryDisagreement, true);
});

test('the fused hyphen date is not sliced by token count', () => {
  // `2021-05-31` arrives from `tokenize` as one token (tokenize never splits
  // on a bare hyphen), not three. Slicing the remainder by "date is always
  // three tokens" would drop or duplicate a token here.
  const p = scene(
    'Scenes/2ChicksSameTime/2.Chicks.Same.Time.2021-05-31.Jackie.Hoff.and.Aubree.Valentine.2160p.mp4',
  );
  assert.equal(p.releasedOn, '2021-05-31');
  assert.equal(p.title, 'Jackie Hoff and Aubree Valentine');
});

test('a dot-separated trailing group is recognised, not just a hyphenated one', () => {
  // The corpus's dominant title-leak shape: the group sits as its own
  // trailing token after the junk run (`...2160p.MP4.WRB`), not fused to it
  // by a hyphen (`...2160p.MP4-WRB`). Without this, `findTitleRegion`'s
  // backward walk halts on the bare `WRB` before it ever reaches the real
  // junk, and the whole `2160p MP4 WRB` run leaks into the title.
  const p = scene('2ChicksSameTime.17.07.12.Aubrey.Sinclair.And.Khloe.Kapri.XXX.2160p.MP4.KTR.mp4');
  assert.equal(p.group, 'KTR');
  assert.equal(p.title, 'Aubrey Sinclair And Khloe Kapri');
});

test('an ordinary two-word title tail is not mistaken for a dot-separated group', () => {
  // `Alternative Angles` has no junk token before its last word, so the new
  // dot-separated-group heuristic must not fire here. Uses a dated name so
  // the assertion isolates `extractTrailingGroup` from `findBoundary`'s own,
  // separate "bare trailing word may be a group" heuristic in the no-date
  // path, which is pre-existing, reused as-is, and not this test's concern.
  const p = scene('SomeSite.22.07.07.Ruby.Redbottom.Alternative.Angles.mp4');
  assert.equal(p.group, null);
  assert.equal(p.title, 'Ruby Redbottom Alternative Angles');
});

test('a release group literally named XXX is still a group, not junk', () => {
  // The corpus has `...480p.MP4-XXX.nzb`: a real release group that happens
  // to be spelled the same as the category tag. `XXX` is not in the shared
  // junk vocabulary, so `splitGroupSuffix` accepts it as a group name.
  const p = scene('18Eighteen.24.06.12.Someone.XXX.480p.MP4-XXX.nzb');
  assert.equal(p.group, 'XXX');
});

test('parseScene uses no clock, no randomness, and no environment reads', () => {
  // This is a textual check on parseScene's own source, not a proof of
  // determinism: it catches an obvious clock/randomness/env read added
  // directly in this function, but it cannot see one hiding inside a helper
  // it calls (`findBoundary`, `findTitleRegion`, `tokenize`, ...), and it
  // cannot catch a non-literal read spelled to dodge these exact substrings.
  // Word-boundaries guard against false positives from identifiers that
  // merely contain these words, such as `locateSceneDate` or `dateSplit`.
  const source = parseScene.toString();
  const forbidden = [/\bDate\b/, /\bperformance\b/, /\bMath\.random\b/, /\bprocess\.env\b/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `parseScene's source matches forbidden pattern ${pattern}`);
  }
});
