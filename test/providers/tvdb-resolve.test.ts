import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZodType } from 'zod';
import { createTvdbProvider } from '../../lib/providers/tvdb/resolve';
import type { TvdbClient } from '../../lib/providers/tvdb/client';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';

const ctx = { signal: new AbortController().signal, lookupId: null };

interface Call {
  readonly path: string;
  readonly query: Record<string, string | number | undefined>;
}

/**
 * A client that answers by path, so a test can say which endpoint holds
 * what. An unlisted path is a 404, which is how the real client reports
 * absence.
 */
function stubClient(calls: Call[], byPath: Readonly<Record<string, unknown>>): TvdbClient {
  return {
    async get<T>(
      path: string,
      query: Record<string, string | number | undefined>,
      schema: ZodType<T>,
    ): Promise<T | null> {
      calls.push({ path, query });
      const body = byPath[path];
      return body === undefined ? null : schema.parse(body);
    },
  };
}

function parsed(name: string): ParsedVideo {
  const result = parseVideo('tv', name);
  if (!result.ok) throw new Error(`fixture refused: ${result.refusal}`);
  return result.parsed;
}

const GOT_SERIES = {
  id: 121361,
  name: 'Game of Thrones',
  slug: 'game-of-thrones',
  firstAired: '2011-04-17',
  lastAired: '2019-05-19',
  year: '2011',
  status: { name: 'Ended' },
  overview: 'Seven noble families fight.',
};
const GOT_EPISODE = {
  id: 3254641,
  seriesId: 121361,
  name: 'Winter Is Coming',
  aired: '2011-04-17',
  runtime: 62,
  overview: 'Eddard Stark is torn.',
  number: 1,
  seasonNumber: 1,
  absoluteNumber: 1,
};
const EPISODES_BODY = { data: { series: GOT_SERIES, episodes: [GOT_EPISODE] } };
const EPISODE_NAME = 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP.mkv';

test('it supports tv and nothing else', () => {
  const provider = createTvdbProvider(stubClient([], {}));
  assert.equal(provider.name, 'tvdb');
  assert.equal(provider.supports('tv'), true);
  assert.equal(provider.supports('movies'), false);
  assert.equal(provider.supports('xxx'), false);
  assert.equal(provider.supports('books'), false);
});

test('an inherited series id costs one call and no search', async () => {
  // TMDB already publishes the TVDB series id, so the common path never
  // guesses at a title.
  const calls: Call[] = [];
  const provider = createTvdbProvider(
    stubClient(calls, { '/series/121361/episodes/default': EPISODES_BODY }),
  );
  const out = await provider.resolve(parsed(EPISODE_NAME), { ...ctx, seriesRef: '121361' });

  // One query to find the episode, then one for its credits -- the listing
  // returns base records with no `characters`. No search either way.
  assert.deepEqual(calls.map((c) => c.path), [
    '/series/121361/episodes/default', '/episodes/3254641/extended',
  ]);
  assert.deepEqual(calls[0]?.query, { season: 1, episodeNumber: 1 });
  assert.equal(out?.media.kind, 'episode');
  assert.equal(out?.media.title, 'Winter Is Coming');
  assert.equal(out?.media.parent?.kind, 'season');
  assert.equal(out?.media.parent?.parent?.kind, 'series');
  assert.ok((out?.confidence ?? 0) >= 0.75, `should clear the floor, got ${out?.confidence}`);
});

test('with no inherited id it searches, then fetches the episode', async () => {
  const calls: Call[] = [];
  const provider = createTvdbProvider(stubClient(calls, {
    '/search': {
      data: [{
        tvdb_id: '121361', name: 'Game of Thrones', year: '2011', first_air_time: '2011-04-17',
      }],
    },
    '/series/121361/episodes/default': EPISODES_BODY,
  }));
  const out = await provider.resolve(parsed(EPISODE_NAME), ctx);

  assert.deepEqual(calls.map((c) => c.path), [
    '/search', '/series/121361/episodes/default', '/episodes/3254641/extended',
  ]);
  assert.deepEqual(calls[0]?.query, { query: 'Game of Thrones', type: 'series' });
  assert.equal(out?.media.title, 'Winter Is Coming');
});

test('a series with no such episode is not answered with the series', async () => {
  // Supplying the episode is this provider's entire purpose; returning its
  // parent instead would be the very shortfall it exists to repair.
  const provider = createTvdbProvider(stubClient([], {
    '/series/121361/episodes/default': { data: { series: GOT_SERIES, episodes: [] } },
  }));
  assert.equal(
    await provider.resolve(parsed(EPISODE_NAME), { ...ctx, seriesRef: '121361' }),
    null,
  );
});

test('a search that matches nothing resolves to null', async () => {
  const provider = createTvdbProvider(stubClient([], { '/search': { data: [] } }));
  assert.equal(await provider.resolve(parsed(EPISODE_NAME), ctx), null);
});

test('a series whose name shares nothing with the filename is refused', async () => {
  // The same guard the TPDB provider grew: a row with no bearing on the
  // filename is not a match however it was reached.
  const provider = createTvdbProvider(stubClient([], {
    '/series/999/episodes/default': {
      data: {
        series: { id: 999, name: 'Entirely Unrelated Programme', firstAired: '2011-04-17' },
        episodes: [GOT_EPISODE],
      },
    },
  }));
  const out = await provider.resolve(parsed(EPISODE_NAME), { ...ctx, seriesRef: '999' });
  assert.equal(out, null, 'nothing in common is not a match');
});

test('a season parse resolves to the season, not an episode', async () => {
  const provider = createTvdbProvider(stubClient([], {
    '/search': { data: [{ tvdb_id: '121361', name: 'Game of Thrones', year: '2011' }] },
    '/series/121361': { data: GOT_SERIES },
  }));
  const out = await provider.resolve(parsed('Game.of.Thrones.S01.1080p.WEB.h264-GRP.mkv'), ctx);
  assert.equal(out?.media.kind, 'season');
  assert.equal(out?.media.details.season?.seasonNumber, 1);
  assert.equal(out?.media.parent?.kind, 'series');
});

test('a series parse is not docked for an episode it never named', async () => {
  // Passing `false` rather than `null` for an unasserted flag would cost 0.4
  // for a question nobody asked, and sink a clean series match.
  const provider = createTvdbProvider(stubClient([], {
    '/search': { data: [{ tvdb_id: '121361', name: 'Game of Thrones', year: '2011' }] },
    '/series/121361': { data: GOT_SERIES },
  }));
  const out = await provider.resolve(parsed('Game.of.Thrones.1080p.WEB.h264-GRP.mkv'), ctx);
  assert.equal(out?.media.kind, 'series');
  assert.ok((out?.confidence ?? 0) >= 0.75, `an exact series title should resolve, got ${out?.confidence}`);
});

test('a multi-episode filename resolves the first episode it names', async () => {
  const calls: Call[] = [];
  const provider = createTvdbProvider(
    stubClient(calls, { '/series/121361/episodes/default': EPISODES_BODY }),
  );
  await provider.resolve(
    parsed('Game.of.Thrones.S01E01E02.1080p.WEB.h264-GRP.mkv'),
    { ...ctx, seriesRef: '121361' },
  );
  assert.equal(calls[0]?.query.episodeNumber, 1, 'the first number, as the TMDB path does');
});

test('a movie parse is refused outright, with no call', async () => {
  const calls: Call[] = [];
  const provider = createTvdbProvider(stubClient(calls, {}));
  const movie = parseVideo('movies', 'The.Matrix.1999.1080p.BluRay.x264-GRP.mkv');
  if (!movie.ok) throw new Error('fixture refused');
  assert.equal(await provider.resolve(movie.parsed, ctx), null);
  assert.deepEqual(calls, [], 'nothing is asked of an API that cannot answer');
});

/**
 * TheTVDB answers in a series' primary language. One Piece really does come
 * back as `ワンピース`, with Japanese episode titles, from an id TMDB itself
 * published -- so this is the ordinary case for any non-English series, not
 * an edge one.
 */
const ONE_PIECE_JA = {
  id: 81797, name: 'ワンピース', firstAired: '1999-10-20', year: '1999',
};
const ONE_PIECE_EPISODE = {
  id: 1, seriesId: 81797, name: '正義のうそつき？キャプテンウソップ',
  aired: '1999-11-17', number: 1, seasonNumber: 2,
};

test('a handed-over match is judged on the handing provider title', async () => {
  // Judging `One Piece` against `ワンピース` scores 0.000, which both fails
  // the guard and sinks the confidence -- discarding a correct episode that
  // TMDB does not have and TheTVDB does.
  const provider = createTvdbProvider(stubClient([], {
    '/series/81797/episodes/default': {
      data: { series: ONE_PIECE_JA, episodes: [ONE_PIECE_EPISODE] },
    },
  }));
  const out = await provider.resolve(
    parsed('One.Piece.S02E01.1080p.WEB.h264-GRP.mkv'),
    { ...ctx, seriesRef: '81797', seriesTitle: 'One Piece' },
  );
  assert.equal(out?.media.kind, 'episode');
  assert.equal(out?.media.title, '正義のうそつき？キャプテンウソップ');
  assert.ok((out?.confidence ?? 0) >= 0.75,
    `the episode TMDB lacks should resolve, got ${out?.confidence}`);
});

test('without a handed-over title a localised name is still refused', async () => {
  // The guard is not weakened in general: it is only that a title supplied
  // by the provider which established identity outranks this one's.
  const provider = createTvdbProvider(stubClient([], {
    '/series/81797/episodes/default': {
      data: { series: ONE_PIECE_JA, episodes: [ONE_PIECE_EPISODE] },
    },
  }));
  const out = await provider.resolve(
    parsed('One.Piece.S02E01.1080p.WEB.h264-GRP.mkv'), { ...ctx, seriesRef: '81797' },
  );
  assert.equal(out, null);
});

test('an episode belonging to another series is refused', async () => {
  // A language-independent integrity check on the handed-over path, where
  // the title guard is judging someone else's title.
  const provider = createTvdbProvider(stubClient([], {
    '/series/81797/episodes/default': {
      data: {
        series: ONE_PIECE_JA,
        episodes: [{ ...ONE_PIECE_EPISODE, seriesId: 999999 }],
      },
    },
  }));
  const out = await provider.resolve(
    parsed('One.Piece.S02E01.1080p.WEB.h264-GRP.mkv'),
    { ...ctx, seriesRef: '81797', seriesTitle: 'One Piece' },
  );
  assert.equal(out, null);
});

test('the romaji alias is what makes a Japanese-named series resolve', async () => {
  // TheTVDB answers in a series' primary language, so Re:ZERO's canonical
  // name is Japanese and the romaji a filename carries is an alias. Judging
  // on the canonical name alone rejects it at the guard and sinks the score,
  // which is the case this provider exists to serve.
  const RE_ZERO = {
    id: 305089,
    name: 'Re：ゼロから始める異世界生活',
    firstAired: '2016-04-04',
    year: '2016',
    aliases: [
      { language: 'fra', name: 'Re:Zero kara Hajimeru Isekai Seikatsu' },
      { language: 'jpn', name: 'Re:ゼロから始める異世界生活 新編集版' },
    ],
  };
  const provider = createTvdbProvider(stubClient([], {
    '/series/305089/episodes/default': {
      data: {
        series: RE_ZERO,
        episodes: [{ id: 1, seriesId: 305089, name: 'ラム', aired: '2026-05-06', number: 18, seasonNumber: 4 }],
      },
    },
  }));
  const out = await provider.resolve(
    parsed('[Onalrie] ReZero kara Hajimeru Isekai Seikatsu - S04E18 [1080p].mkv'),
    { ...ctx, seriesRef: '305089' },
  );
  assert.equal(out?.media.kind, 'episode');
  assert.ok((out?.confidence ?? 0) >= 0.75,
    `the romaji alias should carry it over the floor, got ${out?.confidence}`);
});

test('a search hit is selected and accepted on its aliases', async () => {
  // The guard reads aliases too. Without that, `pickBest` would choose the
  // right series on its romaji alias and `agrees` would then reject it for
  // not matching a Japanese name.
  const calls: Call[] = [];
  const provider = createTvdbProvider(stubClient(calls, {
    '/search': {
      data: [{
        tvdb_id: '305089',
        name: 'Re：ゼロから始める異世界生活',
        year: '2016',
        aliases: ['Re: Zero Kara Hajimeru Isekai Seikatsu'],
      }],
    },
    '/series/305089/episodes/default': {
      data: {
        series: {
          id: 305089, name: 'Re：ゼロから始める異世界生活', year: '2016',
          aliases: [{ language: 'fra', name: 'Re:Zero kara Hajimeru Isekai Seikatsu' }],
        },
        episodes: [{ id: 1, seriesId: 305089, name: 'ラム', number: 18, seasonNumber: 4 }],
      },
    },
  }));
  const out = await provider.resolve(
    parsed('[Onalrie] ReZero kara Hajimeru Isekai Seikatsu - S04E18 [1080p].mkv'), ctx,
  );
  assert.deepEqual(calls.map((c) => c.path), [
    '/search', '/series/305089/episodes/default', '/episodes/1/extended',
  ]);
  assert.equal(out?.media.kind, 'episode');
});
