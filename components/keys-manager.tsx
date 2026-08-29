'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
// Type-only: lib/keys/manage.ts imports Drizzle.
import type { KeyRow } from '../lib/keys/manage';

/**
 * Formats a timestamp for display, deterministically regardless of the
 * ambient timezone.
 *
 * Exported so the determinism claim is testable directly: `toLocaleString()`
 * renders in the server's timezone during SSR and the visitor's on
 * hydration, a mismatch invisible to tests and the build until a real
 * browser disagrees with a real server.
 */
export function when(value: string | null): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  // Degrade rather than throw: toISOString() raises RangeError on an
  // unparseable timestamp, and a throw in a client render takes the page down
  // -- there is no error.tsx. The toLocaleString() this replaced returned
  // "Invalid Date" instead, and losing that was a regression, not a trade.
  if (Number.isNaN(parsed.getTime())) return '—';
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Whether the create form may be submitted.
 *
 * Exported so the rule is testable: it cannot be exercised through the
 * component, because this project has no React renderer.
 *
 * An undismissed secret blocks creation because `fresh` holds the only copy
 * of that token in existence -- replacing it would destroy it silently, and
 * dismissing the panel is the user saying they have copied it.
 */
export function canCreateKey(busy: boolean, hasUndismissedSecret: boolean): boolean {
  return !busy && !hasUndismissedSecret;
}

export function KeysManager({ initialKeys }: { readonly initialKeys: readonly KeyRow[] }) {
  const [keys, setKeys] = useState<readonly KeyRow[]>(initialKeys);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one and only copy of the secret, held in memory for as long as the
  // panel is open and never written anywhere else.
  const [fresh, setFresh] = useState<{ readonly prefix: string; readonly token: string } | null>(null);
  // Ids currently mid-revoke, so a fast double-click on the same row is
  // ignored rather than firing a second DELETE while the first is in flight.
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canCreateKey(busy, fresh !== null)) {
      setError('Copy the key above and dismiss it before creating another.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        setError(problem?.detail ?? `Could not create the key (${response.status})`);
        return;
      }
      const payload = await response.json() as { key: KeyRow; token: string };
      setKeys((current) => [payload.key, ...current]);
      setFresh({ prefix: payload.key.prefix, token: payload.token });
      setLabel('');
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    if (revoking.has(id)) return;
    setError(null);
    setRevoking((current) => new Set(current).add(id));
    try {
      const response = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (response.status !== 204) {
        setError('Could not revoke that key.');
        return;
      }
      setKeys((current) => current.map(
        (key) => (key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key),
      ));
    } catch {
      setError('The request could not be sent.');
    } finally {
      setRevoking((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1">
          <Label htmlFor="label">Label</Label>
          <Input
            id="label"
            name="label"
            required
            maxLength={120}
            placeholder="laptop, CI, sonarr…"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!canCreateKey(busy, fresh !== null)}>
          {busy ? 'Creating…' : 'Create key'}
        </Button>
      </form>

      {fresh === null ? null : (
        <p className="text-sm text-muted-foreground">
          Copy the key below and dismiss it before creating another.
        </p>
      )}

      {error === null ? null : <p role="alert" className="text-sm text-red-600">{error}</p>}

      {fresh === null ? null : (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-base">Copy this key now — it is shown once</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Only a hash is stored, so this cannot be shown again. If you lose it, revoke the key
              and create another.
            </p>
            <code className="block break-all rounded bg-muted p-3 font-mono text-sm">{fresh.token}</code>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => { void navigator.clipboard?.writeText(fresh.token); }}
              >
                Copy
              </Button>
              {/* Dismissal drops the only copy, so it is an explicit action. */}
              <Button type="button" size="sm" variant="outline" onClick={() => setFresh(null)}>
                I have copied it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Label</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">No keys yet.</TableCell>
            </TableRow>
          ) : keys.map((key) => (
            <TableRow key={key.id}>
              <TableCell>{key.label}</TableCell>
              <TableCell className="font-mono text-xs">
                mnp_{key.prefix}…
                {key.revokedAt === null ? null : <Badge variant="outline" className="ml-2">revoked</Badge>}
              </TableCell>
              <TableCell>{when(key.createdAt)}</TableCell>
              <TableCell>{when(key.lastUsedAt)}</TableCell>
              <TableCell className="text-right">
                {key.revokedAt === null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={revoking.has(key.id)}
                    onClick={() => { void revoke(key.id); }}
                  >
                    {revoking.has(key.id) ? 'Revoking…' : 'Revoke'}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
