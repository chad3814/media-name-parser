import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSceneDate } from '../../lib/parse/scene';
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

test('two performers and a distinct title all stay together, unsplit', () => {
  // A decision, not an omission: see the spec's Performers section. TPDB
  // returns canonical performers, and a corpus-mined dictionary caps at 58%
  // recall and cannot represent mononyms. Two performer names *and* separate
  // title words after them, both surviving into one `title` string, is the
  // case a future performer-splitting change would actually break -- unlike
  // a single-performer title, which would look the same whether or not
  // splitting existed.
  const p = scene('SomeSite.22.07.07.Aubrey.Sinclair.And.Khloe.Kapri.Anal.Adventure.mp4');
  assert.equal(p.title, 'Aubrey Sinclair And Khloe Kapri Anal Adventure');
});

test('the site falls back to the nearest ancestor', () => {
  const p = scene('Scenes/18Lust/18Lust - Finally Got To Fuck Kiara Alternative Angles.mp4');
  assert.equal(p.site, '18Lust');
  assert.equal(p.releasedOn, null);
  assert.ok(p.hints.fromDirectories.includes('18Lust'));
});

test('a library-form name with no date does not duplicate the site into the title', () => {
  // Fix round 3: Task 4 found this while sampling parses before freezing a
  // golden file. The no-date branch fell back to the ancestor directory for
  // `site` but never stripped a leading filename token that duplicated it,
  // so `Scenes/18Lust/18Lust_Lola...` produced title "18Lust Lola Haze
  // Nature Schoolgirl" instead of just the performer/scene text. Measured
  // at 71.7% of library-form names with no date (1,156 of 1,613). Real
  // corpus name.
  const p = scene('Scenes/18Lust/18Lust_Lola.Haze.Nature.Schoolgirl_1080p.mp4');
  assert.equal(p.site, '18Lust');
  assert.equal(p.title, 'Lola Haze Nature Schoolgirl');
});

test('a library-form title that does not start with the site is not touched', () => {
  // The case that must not change: the site-stripping fix must fire only on
  // a genuine duplicate, never unconditionally on the leading token. Real
  // corpus name -- its title does not start with "18Lust" at all.
  const p = scene('Scenes/18Lust/18Lust - Finally Got To Fuck Kiara Alternative Angles.mp4');
  assert.equal(p.site, '18Lust');
  assert.ok(!p.title.startsWith('18Lust'), `title unexpectedly begins with the site: "${p.title}"`);
});

test('a synthetic library-form title that never repeats the site keeps its title whole', () => {
  // A second guard on the same "do not strip unconditionally" invariant,
  // using a name whose first title word shares no relation to the site at
  // all, so `stripLeadingSiteToken` must be a straightforward no-op.
  const p = scene('Scenes/2ChicksSameTime/Totally.Different.Title.Words.mp4');
  assert.equal(p.site, '2ChicksSameTime');
  // `Words` belongs to the title. This expectation used to read `Totally
  // Different Title`, which quietly encoded the very truncation the test's
  // name promises to guard against -- `findBoundary` took the last bare token
  // as a release group on any name, title or not.
  assert.equal(p.title, 'Totally Different Title Words');
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

test('a language word before the last token is not mistaken for a group marker', () => {
  // Fix round 2, finding 1: the dot-separated-group heuristic used to fire
  // whenever the second-to-last token was `isJunk()` of *any* class, and
  // `language` is stocked with ordinary English words that are also real
  // vocabulary (`DUTCH`). This is the `Moon Knight` -> group `Knight`
  // failure `findBoundary`'s docstring warns about, reintroduced one
  // category over: `Dutch` looked like `MP4` (a technical tag) to the old
  // check, so `Delight` got read as a group and `Dutch Delight` fell out of
  // the title.
  const p = scene('SomeSite.22.07.07.Britney.Dutch.Delight.mp4');
  assert.equal(p.group, null);
  assert.equal(p.title, 'Britney Dutch Delight');
});

test('an edition word before the last token is not mistaken for a group marker', () => {
  // Same failure, the `edition`/other-ambiguous-class side: `French` is a
  // language tag, and swapping it in reproduces the same misread.
  const p = scene('SomeSite.22.07.07.Anna.French.Kiss.mp4');
  assert.equal(p.group, null);
  assert.equal(p.title, 'Anna French Kiss');
});

test('the dot-separated group is still recognised for an unambiguous technical tag', () => {
  // The fix must not overcorrect: a real container tag (`MP4`) before the
  // trailing group token must still trigger the heuristic.
  const p = scene('SomeSite.22.07.07.Ruby.Redbottom.XXX.2160p.MP4.WRB.mp4');
  assert.equal(p.group, 'WRB');
  assert.equal(p.title, 'Ruby Redbottom');
});

test('a release group literally named XXX is still a group, not junk', () => {
  // The corpus has `...480p.MP4-XXX.nzb`: a real release group that happens
  // to be spelled the same as the category tag. `XXX` is not in the shared
  // junk vocabulary, so `splitGroupSuffix` accepts it as a group name.
  const p = scene('18Eighteen.24.06.12.Someone.XXX.480p.MP4-XXX.nzb');
  assert.equal(p.group, 'XXX');
});

test('a late date does not swallow the title into the site', () => {
  // Fix round 1: the plan's algorithm said "everything before the first
  // date is the site," but the spec anchors the date right after the site,
  // and the corpus has a third shape the plan missed: `<site>.<title>.
  // <date>.<quality>`, where the date is late. On this shape, "everything
  // before the date" is the site AND the title glued together. This is a
  // real corpus name (library form, so the site also comes from the
  // directory) that used to parse with an empty title and a seven-word
  // "site".
  const p = scene(
    'Scenes/ATKGirlfriends/ATKGirlfriends.Breezy.Bri.Breezy.Bri.POV.Sex.2022-11-10..2160p..mp4',
  );
  assert.equal(p.site, 'ATKGirlfriends');
  assert.equal(p.releasedOn, '2022-11-10');
  assert.ok(p.title.length > 0, 'the title must not be empty');
  assert.ok(p.title.includes('Breezy Bri'), `expected "Breezy Bri" in the title, got "${p.title}"`);
});

test('the site is never longer than the measured site-length cap', () => {
  // The corpus census behind `SITE_HEAD_TOKEN_CAP` found no real site name
  // longer than 4 tokens across 12,815 names. A `site` longer than that is
  // therefore not evidence of an unusually long site -- it is title text
  // that leaked into the site, which is exactly the bug fix round 1
  // corrects. This is the sharpest single invariant available without
  // hand-listing every site the corpus contains.
  const names = [
    'SpankMonster.22.07.07.Ruby.Redbottom.And.Octavia.Red.XXX.2160p.MP4-WRB.nzb',
    'Scenes/ATKGirlfriends/ATKGirlfriends.Breezy.Bri.Breezy.Bri.POV.Sex.2022-11-10..2160p..mp4',
    'BackroomCastingCouch.Zoe.Weird.Science.Anal.Origin.Story.23.02.27.1080p.mp4',
    '777REMIX.Kenzies.Megamix.The.Best.Little.Whore.In.The.World.4K.nzb',
  ];
  for (const name of names) {
    const p = scene(name);
    if (p.site === null) continue;
    const wordCount = p.site.split(' ').length;
    assert.ok(wordCount <= 4, `site "${p.site}" (${wordCount} words) exceeds the measured cap for ${name}`);
  }
});

test('the scene module uses no clock, no randomness, and no environment reads', () => {
  // Fix round 2, finding 2: `parseScene.toString()` alone only sees
  // `parseScene`'s own body. The date and site logic actually live in
  // sibling functions in this module -- `locateSceneDate`,
  // `splitLateSiteHead`, `extractTrailingGroup`, `parseSceneDate` -- which
  // that scan never reached. Reading the module's source file once and
  // scanning the whole text covers all of them without needing each helper
  // exported just so a test can call `.toString()` on it.
  //
  // This still is not a proof of determinism: it cannot see inside a helper
  // *imported* from another module (`findBoundary`, `findTitleRegion`,
  // `tokenize`, `classifyToken`, ...), and it cannot catch a non-literal
  // read spelled to dodge these exact patterns. Word-boundaries guard
  // against false positives from identifiers that merely contain these
  // words, such as `locateSceneDate` or `dateSplit`.
  const source = readFileSync('lib/parse/scene.ts', 'utf8');
  const forbidden = [/\bDate\b/, /\bperformance\b/, /\bMath\.random\b/, /\bprocess\.env\b/];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `lib/parse/scene.ts matches forbidden pattern ${pattern}`);
  }
});
