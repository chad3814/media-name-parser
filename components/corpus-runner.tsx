'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CATEGORIES, type Category } from '../lib/parse/types';
import { CORPUS_CHUNK } from '../lib/corpus/chunk';
import { summarise, MAX_NAMES, type CorpusRow } from '../lib/corpus/aggregate';

interface Envelope {
  readonly state: 'resolved' | 'unresolved' | 'pending';
  readonly status: number;
  readonly cached: boolean;
  readonly confidence: number | null;
  readonly refusal: string | null;
}

function split(text: string): readonly string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function CorpusRunner() {
  const [category, setCategory] = useState<Category>('movies');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<readonly CorpusRow[]>([]);
  const [done, setDone] = useState(0);
  const [target, setTarget] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const names = split(text);
    if (names.length === 0) {
      setError('Paste some names, or upload a file.');
      return;
    }
    if (names.length > MAX_NAMES) {
      setError(`That is ${names.length} names; this page runs at most ${MAX_NAMES} at a time.`);
      return;
    }

    setError(null);
    setRunning(true);
    setRows([]);
    setDone(0);
    setTarget(names.length);

    const collected: CorpusRow[] = [];
    try {
      // Chunked because handleLookup runs items sequentially at up to 8s each
      // and a function has 60s. Sent one chunk at a time rather than in
      // parallel, for the same reason the handler is sequential: a burst would
      // exhaust the provider budget that the pacing exists to protect.
      for (let start = 0; start < names.length; start += CORPUS_CHUNK) {
        const chunk = names.slice(start, start + CORPUS_CHUNK);
        const response = await fetch('/api/ui/corpus', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: chunk.map((name) => ({ category, name })) }),
        });
        if (response.status === 401) {
          setError('You are not signed in. Sign in and try again — the results below are partial.');
          return;
        }
        if (!response.ok) {
          const problem = await response.json().catch(() => null) as { detail?: string } | null;
          setError(problem?.detail ?? `The run stopped at name ${start + 1} (${response.status}).`);
          return;
        }
        const payload = await response.json() as { results: readonly Envelope[] };
        // The route returns one result per item on any 200 -- but that
        // guarantee lives in another module, and a page whose whole purpose is
        // three numbers must not quietly compute them over fewer rows than the
        // user submitted. Stop loudly instead.
        if (payload.results.length !== chunk.length) {
          setError(
            `The run stopped at name ${start + 1}: asked for ${chunk.length} results and got `
            + `${payload.results.length}. The results below are partial.`,
          );
          return;
        }
        chunk.forEach((name, index) => {
          // Not load-bearing now that the length check above guarantees a
          // result at every index -- `noUncheckedIndexedAccess` still requires
          // this narrowing, so it stays. Do not remove it as redundant.
          const result = payload.results[index];
          if (result === undefined) return;
          collected.push({
            name,
            state: result.state,
            status: result.status,
            cached: result.cached,
            confidence: result.confidence,
            refusal: result.refusal,
          });
        });
        // Committed after every chunk so a long run shows its work, and a
        // failure part-way still reports what it measured.
        setRows([...collected]);
        setDone(collected.length);
      }
    } catch {
      setError('The run could not be completed. The results below are partial.');
    } finally {
      setRunning(false);
    }
  }

  const summary = summarise(rows);

  return (
    <div className="space-y-6">
      <form onSubmit={run} className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="file">Or upload a file</Label>
            <input
              id="file"
              type="file"
              accept=".txt,text/plain"
              className="block text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                void file.text().then((contents) => { setText(contents); });
              }}
            />
          </div>
          <Button type="submit" disabled={running}>
            {running ? `Running ${done}/${target}…` : 'Run'}
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="names">Names, one per line</Label>
          <Textarea
            id="names"
            rows={8}
            placeholder={'Interstellar.2014.1080p.BluRay.x264-GROUP.mkv\nGhosts (2019) - S05E01 - Fools WEBRip-1080p.mkv'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </form>

      {error === null ? null : <p role="alert" className="text-sm text-red-600">{error}</p>}

      {summary.total === 0 ? null : (
        <Card>
          <CardHeader><CardTitle className="text-base">Summary</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{summary.total} names</Badge>
              <Badge variant="outline">parsed {percent(summary.parsedRate)}</Badge>
              <Badge variant="outline">resolved {percent(summary.resolvedRate)}</Badge>
              <Badge variant="outline">
                mean confidence {summary.meanConfidence === null ? '—' : summary.meanConfidence.toFixed(3)}
              </Badge>
              <Badge variant="outline">{summary.cachedCount} cached</Badge>
              {summary.refused === 0 ? null : <Badge variant="outline">{summary.refused} refused</Badge>}
            </div>
            {summary.complete ? null : (
              <p className="text-muted-foreground">
                {summary.pending} {summary.pending === 1 ? 'name is' : 'names are'} still resolving —
                each blew its deadline and was queued for the background sweeper. The resolved rate
                above is a floor; run the same list again in a minute or two for the real number,
                and it will be fast because everything will be cached.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {summary.total === 0 ? null : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              // Keyed on position as well as name: the committed fixtures
              // contain duplicated lines (41 in movies.releases), and a
              // corpus with repeats is legitimate to measure -- so the name
              // alone is not unique and React would reconcile two rows
              // together, showing a result against the wrong name.
              <TableRow key={`${index}-${row.name}`}>
                <TableCell className="font-mono text-xs break-all">{row.name}</TableCell>
                <TableCell>
                  {row.status === 202 ? 'still working' : row.state}
                  {row.refusal === null ? null : (
                    <span className="text-muted-foreground"> — {row.refusal}</span>
                  )}
                </TableCell>
                <TableCell>{row.confidence === null ? '—' : row.confidence.toFixed(3)}</TableCell>
                <TableCell>{row.cached ? 'cached' : 'fetched'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
