import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN ?? process.env.TMDB_API_KEY ?? '';
if (TOKEN.length === 0) {
  console.error('neither TMDB_READ_ACCESS_TOKEN nor TMDB_API_KEY is set');
  process.exit(1);
}

const OUT = 'fixtures/tmdb';

/** Same key derivation the test stub uses, so a recording is always findable. */
export function fixtureKey(path: string, query: Record<string, string>): string {
  const sorted = Object.keys(query).sort().map((k) => `${k}=${query[k] ?? ''}`).join('&');
  const slug = `${path}${sorted.length > 0 ? `?${sorted}` : ''}`
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9]+/g, '_');
  return `${slug}.json`;
}

async function record(path: string, query: Record<string, string>): Promise<number> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
  });
  const file = join(OUT, fixtureKey(path, query));
  mkdirSync(dirname(file), { recursive: true });
  if (!response.ok) {
    console.error(`${response.status}  ${path}  (not recorded)`);
    return response.status;
  }
  const body: unknown = await response.json();
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`${response.status}  ${file}`);
  return response.status;
}

const PLAN: readonly (readonly [string, Record<string, string>])[] = [
  ['/search/movie', { query: 'Outbreak', primary_release_year: '1995' }],
  ['/search/movie', { query: 'Interstellar', primary_release_year: '2014' }],
  ['/search/movie', { query: 'Moon Knight' }],
  ['/search/tv', { query: 'Moon Knight' }],
  ['/search/tv', { query: 'Ghosts' }],
  ['/search/tv', { query: 'Wheel of Fortune' }],
  ['/search/tv', { query: 'Nonexistent Show That Should Return Nothing 99999' }],
  // `Ghosts (2019)` asserts a year, so the client sends first_air_date_year
  // and that is a different request from the bare `Ghosts` search above.
  ['/search/tv', { query: 'Ghosts', first_air_date_year: '2019' }],

  // `Blade Runner 2049` parses as the title `Blade Runner` and the year 2049,
  // which is the wrong reading. Both halves of the retry are recorded: the
  // year-filtered search that matches nothing, and the rejoined title that
  // finds the film.
  ['/search/movie', { query: 'Blade Runner', primary_release_year: '2049' }],
  ['/search/movie', { query: 'Blade Runner 2049' }],

  // `{imdb-...}` and `{tvdb-...}` are translated through /find; `{tmdb-...}`
  // needs no translation and goes straight to the details endpoint.
  ['/find/tt0133093', { external_source: 'imdb_id' }],
  ['/find/368611', { external_source: 'tvdb_id' }],
  ['/movie/603', { append_to_response: 'credits' }],

  // A bare `{tmdb-N}` is ambiguous across TMDB's two id spaces, and both are
  // densely populated: 5725 is the film `Supervixens` and the series `Project
  // Catwalk`; 603 is `The Matrix` and `Veronica's Closet`. Both sides of both
  // ids are recorded so the corroboration guard can be tested offline.
  ['/movie/5725', { append_to_response: 'credits' }],
  ['/tv/5725', {}],
  ['/tv/603', {}],

  // Details. Ids read out of the recorded searches, not guessed:
  // Outbreak is 6950 (not the 8339 the plan supposed), and the two Ghosts are
  // 126027 (US, 2021) and 17174 (GB, 2019) -- genuinely different series.
  ['/movie/6950', { append_to_response: 'credits' }],
  ['/movie/157336', { append_to_response: 'credits' }],
  ['/movie/335984', { append_to_response: 'credits' }],
  ['/tv/92749', {}],
  ['/tv/92749/season/1', {}],
  ['/tv/126027', {}],
  ['/tv/126027/season/5', {}],
  ['/tv/17174', {}],
  ['/tv/17174/season/1', {}],
  ['/tv/2778', {}],
  ['/tv/2778/season/43', {}],
];

let failures = 0;
for (const [path, query] of PLAN) {
  const status = await record(path, query);
  if (status !== 200) failures += 1;
}
console.log(failures === 0 ? '\nall recorded' : `\n${failures} request(s) failed`);
