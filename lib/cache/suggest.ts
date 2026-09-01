import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { ParsedVideo } from '../parse/types';

/** A name this deployment already knows, offered when a lookup found nothing. */
export interface SuggestedName {
  readonly name: string;
  readonly providerRef: string;
}

export interface SceneSuggestions {
  readonly site: SuggestedName | null;
  readonly performers: readonly SuggestedName[];
}

/** Longest window first, so `Maddie Wren` beats a performer called `Maddie`. */
const MAX_WINDOW_TOKENS = 3;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface Window {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Every 1- to 3-token run of the title, with its span, longest first. */
export function nameWindows(title: string): readonly Window[] {
  const tokens = normalize(title).split(' ').filter((t) => t.length > 0);
  const out: Window[] = [];
  for (let size = MAX_WINDOW_TOKENS; size >= 1; size -= 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      out.push({ text: tokens.slice(i, i + size).join(' '), start: i, end: i + size });
    }
  }
  return out;
}

/**
 * What this deployment recognises in a scene name that resolved to nothing.
 *
 * A lookup for brand-new content fails because the provider has not indexed it
 * yet, not because the name was unreadable. Answering with only
 * `state: unresolved` throws away everything the cache already knows -- that
 * the site is one we have resolved against before, and that a performer in the
 * title is one we have already seen credited. Those are the two facts that let
 * a caller tell "we parsed this wrong" apart from "this is simply too new".
 *
 * Matching is exact against a bounded candidate set rather than a scan: the
 * title yields at most a few dozen 1- to 3-token windows, and each is compared
 * for equality against `people.name` and its aliases. Single-token windows are
 * what make mononyms work, and they are the reason a corpus-mined dictionary
 * was rejected for the parser -- there, a one-token rule would have swallowed
 * title words, but here a false positive is a suggestion a human discards, not
 * a wrong answer written to the cache.
 *
 * Scoped to `provider = 'tpdb'` so the 90-odd TMDB actors in the same table
 * cannot match a scene title.
 */
export async function suggestForScene(
  tx: Tx, parsed: ParsedVideo | null,
): Promise<SceneSuggestions | null> {
  if (parsed === null || parsed.kind !== 'scene') return null;

  const site = parsed.site === null ? null : await siteFor(tx, parsed.site);
  const performers = await performersIn(tx, parsed.title);
  // Nothing recognised is better said with an absent field than an empty one.
  return site === null && performers.length === 0 ? null : { site, performers };
}

async function siteFor(tx: Tx, site: string): Promise<SuggestedName | null> {
  const result = await tx.execute(sql`
    SELECT name, provider_ref FROM provider_sites
     WHERE provider = 'tpdb' AND short_name = ${normalize(site).replaceAll(' ', '')}`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { name: String(row.name), providerRef: String(row.provider_ref) };
}

async function performersIn(tx: Tx, title: string): Promise<readonly SuggestedName[]> {
  const windows = nameWindows(title);
  if (windows.length === 0) return [];
  const texts = [...new Set(windows.map((w) => w.text))];

  // The candidate list travels as one jsonb parameter rather than a bound
  // array: the driver does not give `= ANY($1)` an inferable element type, and
  // interpolating the strings would put caller-controlled text into SQL.
  const candidates = JSON.stringify(texts);
  const result = await tx.execute(sql`
    WITH candidate(text) AS (SELECT jsonb_array_elements_text(${candidates}::jsonb))
    SELECT p.name, p.provider_ref, lower(p.name) AS matched
      FROM people p
     WHERE p.provider = 'tpdb' AND lower(p.name) IN (SELECT text FROM candidate)
    UNION
    SELECT p.name, p.provider_ref, lower(a) AS matched
      FROM people p, unnest(p.aliases) AS a
     WHERE p.provider = 'tpdb' AND lower(a) IN (SELECT text FROM candidate)`);

  const byText = new Map<string, SuggestedName>();
  for (const row of result.rows) {
    byText.set(String(row.matched), {
      name: String(row.name), providerRef: String(row.provider_ref),
    });
  }

  // Greedy over non-overlapping spans, longest first: a title containing
  // `Maddie Wren` should offer that performer once, not also a `Maddie`.
  const taken: Window[] = [];
  const out: SuggestedName[] = [];
  for (const window of windows) {
    const hit = byText.get(window.text);
    if (hit === undefined) continue;
    if (taken.some((t) => window.start < t.end && t.start < window.end)) continue;
    taken.push(window);
    out.push(hit);
  }
  return out;
}
