import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackProvider, needsFallback } from '../../lib/providers/fallback';
import { parseVideo } from '../../lib/parse/video';
import type { ParsedVideo } from '../../lib/parse/types';
import type { MediaKind, Provider, ResolveOutcome } from '../../lib/providers/types';

const ctx = { signal: new AbortController().signal, lookupId: null };

function parsed(name: string): ParsedVideo {
  const result = parseVideo('tv', name);
  if (!result.ok) throw new Error(`fixture refused: ${result.refusal}`);
  return result.parsed;
}

/**
 * Only the fields the composite reads: the kind the rule compares, plus the
 * chain fields the series-id handover walks.
 */
function outcome(kind: MediaKind): ResolveOutcome {
  return {
    confidence: 0.9,
    media: { kind, externalIds: [], parent: null } as unknown as ResolveOutcome['media'],
  };
}

const EPISODE = 'Ghosts.S05E12.1080p.WEB.h264-GRP.mkv';
const SEASON = 'Ghosts.S05.1080p.WEB.h264-GRP.mkv';
const SERIES = 'Ghosts.1080p.WEB.h264-GRP.mkv';

test('no answer at all needs the fallback', () => {
  assert.equal(needsFallback(parsed(EPISODE), null), true);
  assert.equal(needsFallback(parsed(SERIES), null), true);
});

test('an answer at the depth that was asked for does not', () => {
  assert.equal(needsFallback(parsed(EPISODE), outcome('episode')), false);
  assert.equal(needsFallback(parsed(SEASON), outcome('season')), false);
  assert.equal(needsFallback(parsed(SERIES), outcome('series')), false);
});

test('a shallower answer than the filename asked for needs the fallback', () => {
  // The reported case: TMDB matched the series, had no such episode, and
  // returned the season instead -- `lib/providers/tmdb/resolve.ts:273`.
  assert.equal(needsFallback(parsed(EPISODE), outcome('season')), true);
  assert.equal(needsFallback(parsed(EPISODE), outcome('series')), true);
  assert.equal(needsFallback(parsed(SEASON), outcome('series')), true);
});

test('a deeper answer than asked for is not a shortfall', () => {
  assert.equal(needsFallback(parsed(SERIES), outcome('episode')), false);
});

test('a kind with no tv depth is never a shortfall', () => {
  // A movie or a scene cannot be missing a season, so the depth rule must
  // not fire for them however the two kinds happen to compare.
  assert.equal(needsFallback(parsed(SERIES), outcome('movie')), false);
});

function stub(
  name: 'tmdb' | 'tvdb', answer: ResolveOutcome | null | Error, calls: string[],
): Provider {
  return {
    name,
    supports: (category) => category === 'tv',
    resolve: async () => {
      calls.push(name);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test('the secondary is never called when the primary answers in full', async () => {
  const calls: string[] = [];
  const provider = createFallbackProvider(
    stub('tmdb', outcome('episode'), calls), stub('tvdb', outcome('episode'), calls),
  );
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb'], 'a good answer costs nothing extra');
  assert.equal(out?.media.kind, 'episode');
});

test('the secondary answers when the primary returns nothing', async () => {
  const calls: string[] = [];
  const better: ResolveOutcome = {
    confidence: 0.95,
    media: { kind: 'episode', externalIds: [], parent: null } as unknown as ResolveOutcome['media'],
  };
  const provider = createFallbackProvider(stub('tmdb', null, calls), stub('tvdb', better, calls));
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb', 'tvdb']);
  assert.equal(out?.confidence, 0.95);
});

test('the primary answer survives when the secondary has nothing', async () => {
  // The fallback may only improve an answer, never destroy one.
  const calls: string[] = [];
  const provider = createFallbackProvider(
    stub('tmdb', outcome('season'), calls), stub('tvdb', null, calls),
  );
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb', 'tvdb']);
  assert.equal(out?.media.kind, 'season', 'a shallow answer still beats none');
});

test('the primary answer survives when the secondary throws', async () => {
  const calls: string[] = [];
  const provider = createFallbackProvider(
    stub('tmdb', outcome('season'), calls), stub('tvdb', new Error('tvdb exploded'), calls),
  );
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.equal(out?.media.kind, 'season');
});

test('a throwing secondary on a null primary yields null, not a throw', async () => {
  const calls: string[] = [];
  const provider = createFallbackProvider(
    stub('tmdb', null, calls), stub('tvdb', new Error('tvdb exploded'), calls),
  );
  assert.equal(await provider.resolve(parsed(EPISODE), ctx), null);
});

test('with no secondary the composite is the primary', async () => {
  // A missing TVDB_API_KEY must not be an outage.
  const calls: string[] = [];
  const provider = createFallbackProvider(stub('tmdb', outcome('season'), calls), null);
  const out = await provider.resolve(parsed(EPISODE), ctx);
  assert.deepEqual(calls, ['tmdb']);
  assert.equal(out?.media.kind, 'season');
});

test('the composite reports the primary name and support', () => {
  const provider = createFallbackProvider(stub('tmdb', null, []), stub('tvdb', null, []));
  assert.equal(provider.name, 'tmdb', 'so the pipeline id-routing still finds it');
  assert.equal(provider.supports('tv'), true);
  assert.equal(provider.supports('movies'), false);
});

test('the tvdb id TMDB published is handed to the fallback', async () => {
  // What makes the common path exact: TMDB already knows the TVDB series id,
  // so the fallback never has to search for the series.
  let seenRef: string | undefined;
  const withIds: ResolveOutcome = {
    confidence: 0.5,
    media: {
      kind: 'season', externalIds: [{ source: 'tvdb', id: '121361' }], parent: null,
    } as unknown as ResolveOutcome['media'],
  };
  const primary: Provider = { name: 'tmdb', supports: () => true, resolve: async () => withIds };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async (_parsed, inner) => { seenRef = inner.seriesRef; return null; },
  };
  await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);
  assert.equal(seenRef, '121361');
});

test('the id is found on an ancestor when the match is a season', async () => {
  // TMDB records external ids on the series, and the shortfall case returns
  // the season -- so the id lives on the parent, not the returned node.
  let seenRef: string | undefined;
  const series = { kind: 'series', externalIds: [{ source: 'tvdb', id: '77' }], parent: null };
  const season = { kind: 'season', externalIds: [], parent: series };
  const primary: Provider = {
    name: 'tmdb',
    supports: () => true,
    resolve: async () => ({
      confidence: 0.5, media: season as unknown as ResolveOutcome['media'],
    }),
  };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async (_parsed, inner) => { seenRef = inner.seriesRef; return null; },
  };
  await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);
  assert.equal(seenRef, '77');
});

test('no tvdb id means the fallback searches for itself', async () => {
  let seenRef: string | undefined = 'unset';
  const primary: Provider = { name: 'tmdb', supports: () => true, resolve: async () => null };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async (_parsed, inner) => { seenRef = inner.seriesRef; return null; },
  };
  await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);
  assert.equal(seenRef, undefined);
});

test('a fallback answer names the primary record it stood in for', async () => {
  // The composite is the only place both identities are in hand at once,
  // which is what makes the link exact rather than a guess.
  const tmdbSeries = {
    kind: 'series', title: 'House Hunters Renovation', provider: 'tmdb',
    providerRef: 'tmdb:tv:55493', externalIds: [{ source: 'tvdb', id: '262643' }], parent: null,
  };
  const tvdbSeries = {
    kind: 'series', title: 'House Hunters Renovation', provider: 'tvdb',
    providerRef: '262643', externalIds: [], parent: null,
  };
  const tvdbEpisode = { kind: 'episode', provider: 'tvdb', externalIds: [], parent: tvdbSeries };

  const primary: Provider = {
    name: 'tmdb',
    supports: () => true,
    resolve: async () => ({
      confidence: 0.5, media: tmdbSeries as unknown as ResolveOutcome['media'],
    }),
  };
  const secondary: Provider = {
    name: 'tvdb',
    supports: () => true,
    resolve: async () => ({
      confidence: 0.9, media: tvdbEpisode as unknown as ResolveOutcome['media'],
    }),
  };
  const out = await createFallbackProvider(primary, secondary).resolve(parsed(EPISODE), ctx);

  assert.deepEqual(out?.media.parent?.sameAs, { provider: 'tmdb', providerRef: 'tmdb:tv:55493' },
    'on the series, which is what the handover established');
  assert.equal(out?.media.sameAs, undefined,
    'not on the episode: the handover says nothing about whether TMDB has it');
});

test('an answer the primary gave itself names nothing', async () => {
  const media = { kind: 'episode', provider: 'tmdb', externalIds: [], parent: null };
  const primary: Provider = {
    name: 'tmdb',
    supports: () => true,
    resolve: async () => ({ confidence: 0.9, media: media as unknown as ResolveOutcome['media'] }),
  };
  const out = await createFallbackProvider(primary, null).resolve(parsed(EPISODE), ctx);
  assert.equal(out?.media.sameAs, undefined);
});
