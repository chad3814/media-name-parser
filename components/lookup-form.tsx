'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
// Type-only: lib/http/envelope.ts imports the TMDB client and the database,
// and a value import would put both in the browser bundle.
import type { LookupEnvelope } from '../lib/http/envelope';

const CATEGORIES = ['tv', 'movies', 'books', 'xxx'] as const;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'looking' }
  | { readonly kind: 'done'; readonly envelope: LookupEnvelope }
  | { readonly kind: 'error'; readonly message: string };

export function LookupForm() {
  const [category, setCategory] = useState<string>('movies');
  const [name, setName] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ kind: 'looking' });
    try {
      const response = await fetch('/api/ui/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, name }),
      });
      if (response.status === 401) {
        setState({ kind: 'error', message: 'Your session expired. Sign in again.' });
        return;
      }
      if (!response.ok && response.status !== 202) {
        // RFC 9457 problem responses carry `detail`; it never contains a
        // credential, because lib/http/problem.ts is written not to.
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        setState({ kind: 'error', message: problem?.detail ?? `Request failed (${response.status})` });
        return;
      }
      setState({ kind: 'done', envelope: await response.json() as LookupEnvelope });
    } catch {
      setState({ kind: 'error', message: 'The request could not be sent.' });
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            name="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div className="min-w-64 flex-1 space-y-1">
          <Label htmlFor="name">Filename</Label>
          <Input
            id="name"
            name="name"
            required
            placeholder="Interstellar.2014.1080p.BluRay.x264-GROUP.mkv"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={state.kind === 'looking'}>
          {state.kind === 'looking' ? 'Looking up…' : 'Look up'}
        </Button>
      </form>

      {state.kind === 'error' ? <p role="alert" className="text-sm text-red-600">{state.message}</p> : null}
      {state.kind === 'done' ? <Result envelope={state.envelope} /> : null}
    </div>
  );
}

function Result({ envelope }: { readonly envelope: LookupEnvelope }) {
  const media = envelope.media;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={envelope.state === 'resolved' ? 'default' : 'secondary'}>{envelope.state}</Badge>
        {/* The spec asks for this badge by name: a reader must be able to tell
            a cache hit from a provider call without reading the logs. */}
        <Badge variant="outline">{envelope.cached ? 'cached' : 'fetched'}</Badge>
        {envelope.partial ? <Badge variant="outline">still working</Badge> : null}
        {envelope.confidence === null
          ? null
          : <Badge variant="outline">confidence {envelope.confidence.toFixed(3)}</Badge>}
      </div>

      {envelope.refusal === null ? null : (
        <p className="text-sm text-muted-foreground">Not parsed: {envelope.refusal}</p>
      )}

      {envelope.partial ? (
        <p className="text-sm text-muted-foreground">
          This is taking longer than the request allows. The parse below is final; the match is
          still being fetched and will be in the cache shortly.
        </p>
      ) : null}

      {media === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>
              {media.title}{media.year === null ? '' : ` (${media.year})`}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{media.kind}</p>
            {media.parents.length === 0 ? null : (
              <p className="text-muted-foreground">
                in {media.parents.map((parent) => parent.title).join(' » ')}
              </p>
            )}
            {media.overview === null ? null : <p>{media.overview}</p>}
            {media.people.length === 0 ? null : (
              <ul className="space-y-1">
                {media.people.map((person) => (
                  <li key={`${person.role}:${person.name}:${person.characterName ?? ''}`}>
                    <span className="font-medium">{person.name}</span>
                    <span className="text-muted-foreground">
                      {' '}— {person.role}
                      {person.characterName === null ? '' : ` as ${person.characterName}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {envelope.parsed === null ? null : (
        <Card>
          <CardHeader><CardTitle className="text-base">Parsed tokens</CardTitle></CardHeader>
          <CardContent>
            {/* Rendered generically from the JSON rather than field by field:
                the envelope types this as opaque JSON because a refused lookup
                stores a refusal record here instead of a parse. */}
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
              {Object.entries(envelope.parsed).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="font-mono break-all">
                    {typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
