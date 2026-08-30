/**
 * The three numbers the corpus page exists to show, and the counts behind them.
 *
 * Its own module because there is no React renderer in this project, so
 * arithmetic inside a component would be untested — and the failure mode here
 * is not a crash but a plausible wrong number. A measurement tool that
 * under-reports is worse than one that breaks.
 */

export interface CorpusRow {
  readonly name: string;
  readonly state: 'resolved' | 'unresolved' | 'pending';
  readonly status: number;
  readonly cached: boolean;
  readonly confidence: number | null;
  readonly refusal: string | null;
}

export interface CorpusSummary {
  readonly total: number;
  readonly parsed: number;
  readonly resolved: number;
  readonly pending: number;
  readonly refused: number;
  readonly cachedCount: number;
  readonly meanConfidence: number | null;
  readonly parsedRate: number;
  readonly resolvedRate: number;
  /** False while any item is still resolving, which makes `resolvedRate` a floor. */
  readonly complete: boolean;
}

/**
 * How many names one run accepts.
 *
 * The committed fixtures total 5,951 lines; at `CORPUS_CHUNK` of 5 that is
 * 1,190 requests, and a cold run of that takes hours. 500 is 100 chunks --
 * enough to measure against a real sample, short enough that someone waits for
 * it. A full sweep belongs in `scripts/corpus-report.ts`, which runs offline.
 */
export const MAX_NAMES = 500;

export function summarise(rows: readonly CorpusRow[]): CorpusSummary {
  const total = rows.length;
  let parsed = 0;
  let resolved = 0;
  let pending = 0;
  let refused = 0;
  let cachedCount = 0;
  let scored = 0;
  let confidenceSum = 0;

  for (const row of rows) {
    if (row.refusal === null) parsed += 1; else refused += 1;
    if (row.state === 'resolved') resolved += 1;
    // Both signals, on purpose: `status` is what the handler sets from
    // `partial`, and `state` is what the pipeline stored. Either one meaning
    // "still working" makes the run incomplete.
    if (row.state === 'pending' || row.status === 202) pending += 1;
    if (row.cached) cachedCount += 1;
    if (row.confidence !== null) {
      scored += 1;
      confidenceSum += row.confidence;
    }
  }

  // Guarded rather than relying on the caller never passing an empty array:
  // 0/0 is NaN, and NaN formats as "NaN%" on a page whose job is numbers.
  const rate = (count: number): number => (total === 0 ? 0 : count / total);

  return {
    total,
    parsed,
    resolved,
    pending,
    refused,
    cachedCount,
    // Only scored rows. Treating a null as zero would make "no match found"
    // indistinguishable from "a bad match", which is the distinction the
    // parser is being measured on.
    meanConfidence: scored === 0 ? null : confidenceSum / scored,
    parsedRate: rate(parsed),
    resolvedRate: rate(resolved),
    complete: pending === 0,
  };
}
