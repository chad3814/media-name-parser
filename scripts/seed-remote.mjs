#!/usr/bin/env node
// Seeds a deployment's cache from a file of filenames, one per line.
//
//   MNP_API_KEY=mnp_... node scripts/seed-remote.mjs <category> <file>
//
// Plain Node, no dependencies, no build step.
//
// Environment:
//   MNP_API_KEY    required. An API key minted from the signed-in UI.
//   MNP_ORIGIN     default https://openmetadata.nexus
//   MNP_BATCH      default 20. Items per request; the server caps it at 100.
//   MNP_RESUME     default 1. Skip names recorded in <file>.done and append to it.
//
// Two facts about the service shape the defaults.
//
// The rate limit is counted PER REQUEST, not per item, in a fixed one-minute
// window. So one request carrying 20 names costs the same allowance as one
// carrying one, and batching is what keeps a long run under the limit.
//
// A batch is resolved sequentially server-side, each item with its own
// deadline (8s by default). An item that runs out of time answers 202 and
// leaves a durable job for the sweeper -- which drains 6 jobs a minute. So a
// batch large enough to overrun the request is a false economy: the work
// lands in a queue that takes hours to clear. 20 completes comfortably inside
// the request budget while still spending one unit of rate limit.

import { readFile, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

const CATEGORIES = ['tv', 'movies', 'books', 'xxx'];
const ORIGIN = process.env.MNP_ORIGIN ?? 'https://openmetadata.nexus';
const KEY = process.env.MNP_API_KEY ?? '';
const BATCH = Math.max(1, Math.min(100, Number(process.env.MNP_BATCH ?? '20') || 20));
const RESUME = process.env.MNP_RESUME !== '0';

const [category, file] = process.argv.slice(2);

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (KEY.length === 0) die('MNP_API_KEY is not set');
if (category === undefined || file === undefined) {
  die('usage: node scripts/seed-remote.mjs <category> <file>');
}
if (!CATEGORIES.includes(category)) {
  die(`category must be one of ${CATEGORIES.join(', ')}, got ${JSON.stringify(category)}`);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Names already seeded, so an interrupted run resumes instead of restarting. */
const donePath = `${file}.done`;
const alreadyDone = RESUME && existsSync(donePath)
  ? new Set(readFileSync(donePath, 'utf8').split('\n').filter((l) => l.length > 0))
  : new Set();

const raw = (await readFile(file, 'utf8')).split('\n').map((l) => l.trim());
const nonEmpty = raw.filter((l) => l.length > 0);
const unique = [...new Set(nonEmpty)];
const todo = unique.filter((n) => !alreadyDone.has(n));

process.stdout.write(
  `${file}: ${nonEmpty.length} lines, ${unique.length} unique`
  + `${alreadyDone.size > 0 ? `, ${alreadyDone.size} already done` : ''}`
  + ` -> ${todo.length} to send, ${Math.ceil(todo.length / BATCH)} requests of ${BATCH}\n`
  + `origin ${ORIGIN}, category ${category}\n\n`,
);
if (todo.length === 0) process.exit(0);

const tally = { resolved: 0, unresolved: 0, refused: 0, queued: 0, failed: 0 };
const failures = [];

/**
 * One request, retrying only what retrying can fix.
 *
 * A 429 is honoured with the server's own `Retry-After`, because the window is
 * fixed to the minute and guessing shorter just burns another unit of the
 * allowance. A 5xx or a dropped connection is retried with backoff. A 400 or
 * 401 is not: the body or the credential is wrong and will be wrong again.
 */
async function send(items, attempt = 1) {
  let response;
  try {
    response = await fetch(`${ORIGIN}/api/v1/lookup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ items }),
    });
  } catch (error) {
    if (attempt > 4) return { fatal: `network: ${String(error)}` };
    await sleep(2000 * attempt);
    return send(items, attempt + 1);
  }

  if (response.status === 429) {
    const wait = Number(response.headers.get('retry-after') ?? '30') || 30;
    process.stdout.write(`  rate limited, waiting ${wait}s\n`);
    await sleep((wait + 1) * 1000);
    return send(items, attempt);
  }
  if (response.status === 401 || response.status === 403) {
    return { fatal: `credential rejected (${response.status})` };
  }
  if (response.status >= 500) {
    if (attempt > 4) return { fatal: `server error ${response.status}` };
    await sleep(2000 * attempt);
    return send(items, attempt + 1);
  }
  if (!response.ok) {
    const detail = await response.text();
    return { fatal: `${response.status}: ${detail.slice(0, 200)}` };
  }
  return { body: await response.json() };
}

for (let i = 0; i < todo.length; i += BATCH) {
  const names = todo.slice(i, i + BATCH);
  const result = await send(names.map((name) => ({ category, name })));

  if (result.fatal !== undefined) {
    // A rejected credential or a malformed body will not improve on the next
    // batch, so stop rather than grinding through the whole file failing.
    process.stderr.write(`\nstopped: ${result.fatal}\n`);
    tally.failed += names.length;
    for (const name of names) failures.push([name, result.fatal]);
    break;
  }

  // The service answers a batch with one result per item, in order.
  const results = Array.isArray(result.body?.results) ? result.body.results : [];
  const settled = [];
  for (const [index, name] of names.entries()) {
    const item = results[index];
    if (item === undefined) {
      tally.failed += 1;
      failures.push([name, 'no result returned for this item']);
      continue;
    }
    if (item.status === 202 || item.partial === true) {
      // Accepted, finishing in the background. Not recorded as done: the
      // sweeper owns it now, and a later run should not skip it.
      tally.queued += 1;
      continue;
    }
    if (item.refusal !== null && item.refusal !== undefined) {
      tally.refused += 1;
    } else if (item.state === 'resolved') {
      tally.resolved += 1;
    } else {
      tally.unresolved += 1;
    }
    settled.push(name);
  }

  if (RESUME && settled.length > 0) {
    await appendFile(donePath, `${settled.join('\n')}\n`);
  }

  const done = Math.min(i + BATCH, todo.length);
  const pct = Math.floor((done / todo.length) * 100);
  process.stdout.write(
    `  ${String(done).padStart(6)}/${todo.length} (${String(pct).padStart(3)}%)`
    + `  resolved ${tally.resolved}  unresolved ${tally.unresolved}`
    + `  refused ${tally.refused}  queued ${tally.queued}  failed ${tally.failed}\n`,
  );
}

process.stdout.write(
  `\nresolved   ${tally.resolved}\nunresolved ${tally.unresolved}\n`
  + `refused    ${tally.refused}\nqueued     ${tally.queued}`
  + `${tally.queued > 0 ? '  (the sweeper drains about 6 a minute)' : ''}\n`
  + `failed     ${tally.failed}\n`,
);
if (RESUME) process.stdout.write(`\nprogress recorded in ${donePath}\n`);

if (failures.length > 0) {
  process.stderr.write('\nfailures:\n');
  for (const [name, why] of failures.slice(0, 20)) {
    process.stderr.write(`  ${name}\n    ${why}\n`);
  }
  if (failures.length > 20) {
    process.stderr.write(`  ... and ${failures.length - 20} more\n`);
  }
}
process.exit(tally.failed > 0 ? 1 : 0);
