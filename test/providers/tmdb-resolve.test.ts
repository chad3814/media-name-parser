import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmdbClient } from '../../lib/providers/tmdb/client';
import { createTmdbProvider } from '../../lib/providers/tmdb/resolve';
import { parseVideo } from '../../lib/parse/video';
import { fixtureFetch } from '../support/tmdb-fixtures';
import type { ParsedVideo } from '../../lib/parse/types';

function provider() {
  const paths: string[] = [];
  const client = createTmdbClient({
    token: 'fixture',
    fetchImpl: fixtureFetch(),
    recordCall: (row) => { paths.push(row.endpoint); },
    ratePerSecond: 1000,
  });
  return { p: createTmdbProvider(client), count: () => paths.length, paths };
}

function parsed(category: 'tv' | 'movies', name: string): ParsedVideo {
  const r = parseVideo(category, name);
  if (!r.ok) throw new Error(`fixture refused: ${r.refusal}`);
  return r.parsed;
}

const ctx = { signal: new AbortController().signal, lookupId: null };

test('supports only the categories it can resolve', () => {
  const { p } = provider();
  assert.equal(p.supports('movies'), true);
  assert.equal(p.supports('tv'), true);
  assert.equal(p.supports('books'), false);
  assert.equal(p.supports('xxx'), false);
});

test('a movie resolves to one node with people and no parent, in two calls', async () => {
  const { p, count } = provider();
  const got = await p.resolve(parsed('movies', 'Outbreak.1995.1080p.BluRay.REMUX.AVC.DTS-HD-MA.5.1-UnKn0wn.nzb'), ctx);
  assert.ok(got !== null);
  assert.equal(got.kind, 'movie');
  assert.equal(got.title, 'Outbreak');
  assert.equal(got.year, 1995);
  assert.equal(got.parent, null);
  assert.equal(got.details.movie?.imdbId, 'tt0114069');
  assert.ok(got.people.some((x) => x.role === 'director' && x.name === 'Wolfgang Petersen'));
  assert.ok(got.people.filter((x) => x.role === 'performer').length <= 15, 'cast is capped');
  assert.equal(count(), 2, 'a movie is one search plus one detail call');
});

test('an episode resolves with its season and series as parents, in three calls', async () => {
  const { p, count } = provider();
  const got = await p.resolve(
    parsed('tv', 'TV Shows/Moon Knight/Season 1/Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux.mkv'),
    ctx,
  );
  assert.ok(got !== null);
  assert.equal(got.kind, 'episode');
  assert.equal(got.title, 'The Friendly Type');
  assert.equal(got.details.episode?.seasonNumber, 1);
  assert.equal(got.details.episode?.episodeNumber, 3);
  assert.equal(got.parent?.kind, 'season');
  assert.equal(got.parent?.parent?.kind, 'series');
  assert.equal(got.parent?.parent?.title, 'Moon Knight');
  // The season payload carries the episode crew, so there is no fourth call.
  assert.ok(got.people.some((x) => x.role === 'director' && x.name === 'Mohamed Diab'));
  assert.equal(count(), 3);
});

test('the (US) and (2019) disambiguators pick two different series called Ghosts', async () => {
  const us = await provider().p.resolve(
    parsed('tv', 'TV Shows/Ghosts (US)/Season 5/Ghosts (US) - S05E12 - The List WEBRip-1080p.mkv'), ctx,
  );
  const gb = await provider().p.resolve(
    parsed('tv', 'TV Shows/Ghosts (2019)/Season 1/Ghosts (2019) - S01E01 - Pilot WEBDL-1080p.mkv'), ctx,
  );
  assert.ok(us !== null && gb !== null);
  const usSeries = us.parent?.parent ?? us;
  const gbSeries = gb.parent?.parent ?? gb;
  assert.equal(usSeries.providerRef, 'tmdb:tv:126027', 'Ghosts (US) is the 2021 US series');
  assert.equal(gbSeries.providerRef, 'tmdb:tv:17174', 'Ghosts (2019) is the 2019 UK series');
  assert.notEqual(usSeries.providerRef, gbSeries.providerRef);
});

test('a title with no match at all resolves to null rather than throwing', async () => {
  const { p } = provider();
  const got = await p.resolve(
    parsed('tv', 'Nonexistent.Show.That.Should.Return.Nothing.99999.S01E01.1080p.WEB-DL-GRP.nzb'), ctx,
  );
  assert.equal(got, null);
});

test('a movies lookup never touches the tv namespace, whatever the tokens look like', async () => {
  const { p, paths } = provider();
  // Declared movies, tokens episodic. The invariant under test is which
  // namespace gets asked -- not whether a match is found -- so this asserts on
  // the requested paths. It may well run out of fixtures partway through and
  // throw; that is fine and the paths recorded up to then are the evidence.
  await p.resolve(parsed('movies', 'Moon.Knight.S01E03.1080p.WEB-DL-GRP.nzb'), ctx).catch(() => null);
  assert.ok(paths.length > 0, 'at least one request should have been attempted');
  assert.ok(
    paths.every((path) => !path.startsWith('/search/tv') && !path.startsWith('/tv/')),
    `a tv-namespace path was requested for a movies lookup: ${paths.join(', ')}`,
  );
  assert.ok(paths.includes('/search/movie'), `expected a movie search, got ${paths.join(', ')}`);
});

test('a tv lookup never touches the movie namespace', async () => {
  const { p, paths } = provider();
  await p.resolve(
    parsed('tv', 'TV Shows/Moon Knight/Season 1/Moon Knight - S01E03 - The Friendly Type Bluray-2160p Remux.mkv'),
    ctx,
  );
  assert.ok(
    paths.every((path) => !path.startsWith('/search/movie') && !path.startsWith('/movie/')),
    `a movie-namespace path was requested for a tv lookup: ${paths.join(', ')}`,
  );
});

test('an aborted context stops before any request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { p, count } = provider();
  await assert.rejects(
    p.resolve(parsed('movies', 'Outbreak.1995.1080p.BluRay-GRP.nzb'), { signal: controller.signal, lookupId: null }),
  );
  assert.equal(count(), 0);
});
