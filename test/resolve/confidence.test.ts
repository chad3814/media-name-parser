import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, pickBest, titleSimilarity, CONFIDENCE_FLOOR } from '../../lib/resolve/confidence';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';

function parsed(category: 'tv' | 'movies', name: string): ParsedVideo {
  const r = parseVideo(category, name);
  if (!r.ok) throw new Error(`fixture refused: ${r.refusal}`);
  return r.parsed;
}

const base = {
  originalTitle: null, year: null, originCountries: [],
  popularity: 1, voteCount: 100, seasonExists: null, episodeExists: null,
} as const;

test('titleSimilarity is 1 for an exact fold-equal match', () => {
  assert.equal(titleSimilarity('The Matrix', 'the matrix'), 1);
  assert.equal(titleSimilarity('90 Day Fiance', '90 Day Fiancé'), 1);
});

test('an unrelated title cannot clear the floor however favourable everything else is', () => {
  // Two unrelated words still share letters -- Outbreak/Interstellar folds to a
  // similarity around 0.33 -- so the assertion that matters is not a raw
  // similarity threshold but whether such a match could ever be believed.
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const score = scoreCandidate(p, {
    ...base, title: 'Interstellar', year: 1995,
    popularity: 1e6, voteCount: 1e6,
  });
  assert.ok(
    score < CONFIDENCE_FLOOR,
    `an unrelated title scored ${score}, at or above the floor of ${CONFIDENCE_FLOOR}`,
  );
});

test('an exact title and year clears the floor comfortably', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb');
  const score = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1995 });
  assert.ok(score >= 0.9, `expected >= 0.9, got ${score}`);
});

test('a year that is off by one is only mildly penalised', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const exact = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1995 });
  const nearby = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1996 });
  const wrong = scoreCandidate(p, { ...base, title: 'Outbreak', year: 2015 });
  assert.ok(nearby < exact, 'off-by-one should score below exact');
  assert.ok(nearby > wrong, 'off-by-one should score above a real mismatch');
  assert.ok(wrong < CONFIDENCE_FLOOR, `a twenty-year gap should fall below the floor, got ${wrong}`);
});

test('popularity only breaks ties and never outranks the title', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const right = scoreCandidate(p, { ...base, title: 'Outbreak', year: 1995, popularity: 0.1, voteCount: 12 });
  const famousWrong = scoreCandidate(p, { ...base, title: 'Oblivion', year: 1995, popularity: 900, voteCount: 90000 });
  assert.ok(right > famousWrong, 'a popular wrong title must not beat the right one');
});

test('popularity does break a genuine tie', () => {
  const p = parsed('movies', 'Ghosts.2019.1080p.WEB-DL-GRP.nzb');
  const popular = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2019, popularity: 50, voteCount: 5000 });
  const obscure = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2019, popularity: 0.2, voteCount: 3 });
  assert.ok(popular > obscure);
});

test('an episode that does not exist on the candidate series is decisive', () => {
  const p = parsed('tv', 'Some.Show.S02E04.1080p.WEB-DL-GRP.nzb');
  const exists = scoreCandidate(p, { ...base, title: 'Some Show', seasonExists: true, episodeExists: true });
  const missing = scoreCandidate(p, { ...base, title: 'Some Show', seasonExists: true, episodeExists: false });
  assert.ok(exists >= CONFIDENCE_FLOOR, `expected >= floor, got ${exists}`);
  assert.ok(missing < CONFIDENCE_FLOOR, 'a missing episode must drop below the floor');
});

test('a matching origin country lifts the right one of two same-named shows', () => {
  const p = parsed('tv', 'TV Shows/Ghosts (US)/Season 5/Ghosts (US) - S05E12 - The List WEBRip-1080p.mkv');
  const us = scoreCandidate(p, { ...base, title: 'Ghosts', originCountries: ['US'], seasonExists: true, episodeExists: true });
  const gb = scoreCandidate(p, { ...base, title: 'Ghosts', originCountries: ['GB'], seasonExists: true, episodeExists: true });
  assert.ok(us > gb, 'the (US) disambiguator should favour the US series');
});

test('a year disambiguator from a directory behaves like a year', () => {
  const p = parsed('tv', 'TV Shows/Ghosts (2019)/Season 1/Ghosts (2019) - S01E01 - Pilot WEBDL-1080p.mkv');
  const right = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2019, seasonExists: true, episodeExists: true });
  const wrong = scoreCandidate(p, { ...base, title: 'Ghosts', year: 2021, seasonExists: true, episodeExists: true });
  assert.ok(right > wrong);
});

test('a title taken from a directory rather than the filename is penalised', () => {
  const fromFile = parsed('movies', 'Interstellar.2014.1080p.BluRay-GRP.nzb');
  const fromDir = parsed('movies', 'Movies/Interstellar (2014)/00136.m2ts');
  const a = scoreCandidate(fromFile, { ...base, title: 'Interstellar', year: 2014 });
  const b = scoreCandidate(fromDir, { ...base, title: 'Interstellar', year: 2014 });
  assert.ok(b < a, 'a directory-sourced title is weaker evidence');
  assert.ok(b >= CONFIDENCE_FLOOR, `but still good enough to resolve, got ${b}`);
});

test('scores stay inside [0, 1]', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  for (const c of [
    { ...base, title: 'Outbreak', year: 1995, popularity: 1e6, voteCount: 1e6 },
    { ...base, title: '', year: null, popularity: 0, voteCount: 0 },
  ]) {
    const score = scoreCandidate(p, c);
    assert.ok(score >= 0 && score <= 1, `out of range: ${score}`);
  }
});

test('pickBest returns the highest scorer and null for an empty list', () => {
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const items = [
    { name: 'wrong', c: { ...base, title: 'Oblivion', year: 1995 } },
    { name: 'right', c: { ...base, title: 'Outbreak', year: 1995 } },
  ];
  const best = pickBest(p, items, (i) => i.c);
  assert.equal(best?.item.name, 'right');
  assert.ok((best?.confidence ?? 0) > 0.8);
  assert.equal(pickBest(p, [], (i: (typeof items)[number]) => i.c), null);
});

test('a lone exact title clears the floor without a year to help it', () => {
  // A clean library filename carries a title and nothing else. Similarity
  // contributes at most 0.7 and the year bonus is unavailable, so a perfect
  // match capped near 0.73 and fell under the floor: the right film found and
  // reported unresolved.
  const p = parsed('movies', 'The Dark Knight Rises.mkv');
  const best = pickBest(p, [{ ...base, title: 'The Dark Knight Rises', year: 2012 }], (c) => c);
  assert.ok(best !== null);
  assert.ok(best.confidence >= CONFIDENCE_FLOOR,
    `an exact title with nothing against it should resolve: ${String(best?.confidence)}`);
});

test('a near miss still needs a year, so the bonus lifts nothing it should not', () => {
  const p = parsed('movies', 'The Dark Knight Rises.mkv');
  const best = pickBest(p, [{ ...base, title: 'The Dark Knight Rise', year: 2012 }], (c) => c);
  assert.ok(best !== null);
  assert.ok(best.confidence < CONFIDENCE_FLOOR,
    `one letter out is not an exact match: ${String(best?.confidence)}`);
});

test('two candidates sharing a title get no bonus at all', () => {
  // `Ghosts` (2019, GB) and `Ghosts` (2021, US) both exist and both match
  // exactly. An exact match cannot disambiguate them -- it is the case it
  // cannot settle -- so lifting both would turn a safe refusal into a
  // confident guess decided by popularity.
  const p = parsed('movies', 'Ghosts.mkv');
  const twin = pickBest(p, [
    { ...base, title: 'Ghosts', year: 2019, popularity: 5 },
    { ...base, title: 'Ghosts', year: 2021, popularity: 90 },
  ], (c) => c);
  assert.ok(twin !== null);
  assert.ok(twin.confidence < CONFIDENCE_FLOOR,
    `an ambiguous exact match must stay refused: ${String(twin?.confidence)}`);

  const alone = pickBest(p, [{ ...base, title: 'Ghosts', year: 2021, popularity: 90 }], (c) => c);
  assert.ok(alone !== null);
  assert.ok(alone.confidence >= CONFIDENCE_FLOOR, 'the same title alone does resolve');
});

test('an exact title cannot rescue a contradicting year', () => {
  // The bonus is 0.1 and a year gap over one costs 0.35, so the wrong film
  // with the right name stays refused.
  const p = parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb');
  const best = pickBest(p, [{ ...base, title: 'Outbreak', year: 2015 }], (c) => c);
  assert.ok(best !== null);
  assert.ok(best.confidence < CONFIDENCE_FLOOR,
    `a 20-year gap is not fixed by the title: ${String(best?.confidence)}`);
});
