import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

/**
 * These are shape tests over configuration, which is a weak form — but both
 * assertions encode a decision that has a failure mode nothing else can see,
 * and both fail if the decision is reversed.
 */

test('db:migrate keeps its strict env-file, so it cannot migrate an ambient database', async () => {
  // The reason two scripts exist. With `--env-file-if-exists`, running
  // `npm run db:migrate` on a machine with no .env.local would silently
  // migrate whatever DATABASE_URL happens to be in the shell -- possibly
  // production. The deploy variant drops the flag on purpose; this one must
  // not.
  const pkg = JSON.parse(await read('package.json')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const migrate = pkg.scripts['db:migrate'];
  assert.ok(migrate !== undefined, 'db:migrate must exist');
  assert.ok(
    migrate.includes('--env-file=.env.local'),
    `db:migrate must keep the strict env-file: ${migrate}`,
  );
  assert.equal(
    migrate.includes('--env-file-if-exists'),
    false,
    'the strict form is the point; if-exists would migrate an ambient DATABASE_URL',
  );
});

test('db:migrate:deploy reads its credentials from the environment', async () => {
  // Vercel has no .env.local, so the deploy variant must not ask for one.
  const pkg = JSON.parse(await read('package.json')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const deploy = pkg.scripts['db:migrate:deploy'];
  assert.ok(deploy !== undefined, 'db:migrate:deploy must exist');
  assert.equal(deploy.includes('--env-file'), false, `must take no env-file: ${deploy}`);
  assert.ok(deploy.includes('drizzle-kit'), 'must invoke drizzle-kit migrate');
});

test('the deploy build runs the build before the migration', async () => {
  // Ordering is the decision, not an accident. Migrating first means a failed
  // build leaves the schema ahead of the live code indefinitely -- old code
  // against a new schema until someone fixes the build. Building first
  // narrows that window to the seconds between the migration finishing and
  // traffic moving to the new deployment, and a failed migration still fails
  // the whole command so the built artifact is never promoted.
  const vercel = JSON.parse(await read('vercel.json')) as { readonly buildCommand?: string };
  const command = vercel.buildCommand;
  assert.ok(command !== undefined, 'vercel.json must set buildCommand');
  const build = command.indexOf('run build');
  const migrate = command.indexOf('db:migrate:deploy');
  assert.ok(build >= 0, `buildCommand must run the build: ${command}`);
  assert.ok(migrate >= 0, `buildCommand must run the migration: ${command}`);
  assert.ok(build < migrate, `the build must come first: ${command}`);
  // `&&` rather than `;` -- with `;` a failed migration would still exit 0 and
  // the deployment would be promoted against an unmigrated schema.
  assert.ok(command.includes('&&'), `the steps must be chained with &&: ${command}`);
});
