import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CORPUS, readLines } from './corpus-report';
import { fixtureKey } from '../test/support/tmdb-fixtures';
import { resolveLookup } from '../lib/resolve/pipeline';
import { createTmdbClient } from '../lib/providers/tmdb/client';
import { createTmdbProvider } from '../lib/providers/tmdb/resolve';
import { closeDb, withTransaction } from '../lib/db/client';
import { inArray } from 'drizzle-orm';
import { lookups } from '../lib/db/schema';

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN ?? process.env.TMDB_API_KEY ?? '';
if (TOKEN.length === 0) {
  console.error('neither TMDB_READ_ACCESS_TOKEN nor TMDB_API_KEY is set');
  process.exit(1);
}

const DIR = 'fixtures/tmdb';
const SAMPLE_SIZE = 20;

let recorded = 0;
let served = 0;

/**
 * Serves a recorded fixture when one exists and otherwise fetches for real and
 * writes it.
 *
 * This is the only place in the codebase that reaches the network outside the
 * explicit recording script, and it exists so the resolve rate can be measured
 * over a real sample rather than over the four titles someone recorded by hand.
 */
function recordingFetch(): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;
    const file = join(DIR, fixtureKey(url.pathname.replace(/^\/3/, ''), query));

    if (existsSync(file)) {
      served += 1;
      return new Response(readFileSync(file, 'utf8'), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    });
    const text = await response.text();
    if (response.ok) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${text}\n`);
      recorded += 1;
    }
    return new Response(text, {
      status: response.status, headers: { 'content-type': 'application/json' },
    });
  };
  return impl as unknown as typeof fetch;
}

const provider = createTmdbProvider(createTmdbClient({
  token: TOKEN, fetchImpl: recordingFetch(), ratePerSecond: 20,
}));
const deps = { providers: [provider], now: (): Date => new Date() };

for (const { file, category } of CORPUS) {
  const lines = readLines(file);
  const step = Math.max(1, Math.floor(lines.length / SAMPLE_SIZE));
  const chosen: string[] = [];
  for (let i = 0; i < lines.length; i += step) {
    const line = lines[i];
    if (line !== undefined) chosen.push(line);
  }
  // Clear cached verdicts so every sampled line actually reaches the provider.
  await withTransaction(async (tx) => {
    await tx.delete(lookups).where(inArray(lookups.name, chosen));
  });
  for (const name of chosen) {
    await resolveLookup({ category, name }, deps).catch(() => null);
  }
  console.log(`${file.padEnd(42)} ${chosen.length} lines walked`);
}

await closeDb();
console.log(`\nrecorded ${recorded} new fixtures, served ${served} from disk`);
