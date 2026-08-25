import { readFileSync, writeFileSync } from 'node:fs';
import { parseVideo } from '../lib/parse/video';
import { isJunk, tokenize } from '../lib/parse/tokens';
import type { Category } from '../lib/parse/types';

export interface CorpusRate {
  readonly file: string;
  readonly total: number;
  readonly parsed: number;
  readonly refused: number;
  /** Parsed, but with an empty title. A parser bug, not an honest refusal. */
  readonly failed: number;
  /** Threw. Always unacceptable — the parser must never throw on any input. */
  readonly threw: number;
  readonly rate: number;
  /**
   * Titles that still contain a vocabulary token — quality junk that leaked
   * past the boundary walk.
   *
   * This is the metric that carries real information. `rate` is close to
   * tautological: it only falls when the parser throws or produces an empty
   * title, so a parser that returned the whole filename as the title would
   * still score 100%. A leak, by contrast, means the title is definitely
   * wrong. It over-counts slightly — a Grand Prix name legitimately contains
   * `Dutch`, which is also a language tag — so it is a ceiling to defend, not
   * a number to drive to zero.
   */
  readonly titleLeaks: number;
}

export interface CorpusFile {
  readonly file: string;
  readonly category: Category;
}

export const CORPUS: readonly CorpusFile[] = [
  { file: 'fixtures/corpus/movies.releases.raw.txt', category: 'movies' },
  { file: 'fixtures/corpus/movies.library.raw.txt', category: 'movies' },
  { file: 'fixtures/corpus/tv.releases.raw.txt', category: 'tv' },
  { file: 'fixtures/corpus/tv.library.raw.txt', category: 'tv' },
  { file: 'fixtures/corpus/tv.sport.raw.txt', category: 'tv' },
];

export function readLines(file: string): readonly string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
}

export function measure(file: string, category: Category): CorpusRate {
  const lines = readLines(file);
  let parsed = 0;
  let refused = 0;
  let failed = 0;
  let threw = 0;
  let titleLeaks = 0;
  for (const line of lines) {
    try {
      const result = parseVideo(category, line);
      if (result.ok) {
        if (result.parsed.title.length > 0) {
          parsed += 1;
          if (tokenize(result.parsed.title).some(isJunk)) titleLeaks += 1;
        } else {
          failed += 1;
        }
      } else {
        refused += 1;
      }
    } catch {
      threw += 1;
    }
  }
  const total = lines.length;
  return {
    file, total, parsed, refused, failed, threw, titleLeaks,
    rate: total === 0 ? 0 : (parsed + refused) / total,
  };
}

function main(): void {
  const write = process.argv.includes('--write');
  const rates = CORPUS.map(({ file, category }) => measure(file, category));
  for (const r of rates) {
    const pct = (r.rate * 100).toFixed(2);
    console.log(
      `${r.file.padEnd(42)} total=${String(r.total).padStart(5)} ` +
      `parsed=${String(r.parsed).padStart(5)} refused=${String(r.refused).padStart(4)} ` +
      `failed=${String(r.failed).padStart(4)} threw=${String(r.threw).padStart(4)} ` +
      `leaks=${String(r.titleLeaks).padStart(4)} rate=${pct}%`,
    );
  }
  if (write) {
    const baseline = {
      parseRate: Object.fromEntries(rates.map((r) => [r.file, Number(r.rate.toFixed(4))])),
      // Ceilings, not floors: these may go down but must never go up.
      titleLeaks: Object.fromEntries(rates.map((r) => [r.file, r.titleLeaks])),
      // Without this, `rate` cannot detect a parser that refuses everything:
      // refusals count toward the rate, so refuse-all scores 100%.
      refused: Object.fromEntries(rates.map((r) => [r.file, r.refused])),
      resolveRate: null,
    };
    writeFileSync('fixtures/corpus/baseline.json', `${JSON.stringify(baseline, null, 2)}\n`);
    console.log('\nwrote fixtures/corpus/baseline.json');
  }
}

if (process.argv[1]?.endsWith('corpus-report.ts') === true) {
  main();
}
