import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'fixtures/tmdb';

export function fixtureKey(path: string, query: Record<string, string>): string {
  const sorted = Object.keys(query).sort().map((k) => `${k}=${query[k] ?? ''}`).join('&');
  const slug = `${path}${sorted.length > 0 ? `?${sorted}` : ''}`
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9]+/g, '_');
  return `${slug}.json`;
}

/**
 * A `fetch` that serves recorded fixtures and throws on a miss.
 *
 * Throwing matters: a test that needs a response nobody recorded must fail
 * loudly. Falling back to the network would make the suite quietly depend on
 * TMDB being reachable, and the failure would show up on someone else's
 * machine, months later, as a flake.
 */
export function fixtureFetch(): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;
    const file = join(DIR, fixtureKey(url.pathname.replace(/^\/3/, ''), query));
    if (!existsSync(file)) {
      throw new Error(
        `no TMDB fixture for ${url.pathname}${url.search}\n` +
        `expected ${file}\n` +
        'record it with: node --env-file=.env.local --import tsx scripts/record-tmdb.ts',
      );
    }
    return new Response(readFileSync(file, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return impl as unknown as typeof fetch;
}
