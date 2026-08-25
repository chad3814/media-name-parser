import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getAuthTables } from 'better-auth/db';
import { admin } from 'better-auth/plugins';
import * as schema from '../../lib/db/schema';

test('every table named in the spec exists', () => {
  const expected = [
    'user', 'session', 'account', 'verification',
    'apiKeys', 'rateLimitWindows',
    'media', 'movieDetails', 'seriesDetails', 'seasonDetails', 'episodeDetails',
    'bookDetails', 'sceneDetails',
    'people', 'mediaPeople',
    'parses', 'lookups', 'lookupJobs', 'providerCalls',
  ];
  for (const name of expected) {
    assert.ok(name in schema, `schema is missing ${name}`);
  }
});

test('media has the natural key that makes upserts idempotent', () => {
  const config = getTableConfig(schema.media);
  const unique = config.uniqueConstraints.map((c) => c.columns.map((col) => col.name).sort().join(','));
  assert.ok(
    unique.includes('provider,provider_ref'),
    `expected a unique (provider, provider_ref); found ${JSON.stringify(unique)}`,
  );
});

test('lookups is unique on the literal input it was given', () => {
  const config = getTableConfig(schema.lookups);
  const unique = config.uniqueConstraints.map((c) => c.columns.map((col) => col.name).sort().join(','));
  assert.ok(unique.includes('category,name'), `found ${JSON.stringify(unique)}`);
});

test('the Better Auth tables match what the library expects', () => {
  // Better Auth owns these four tables' shape. Hand-writing them is a
  // deliberate trade (one migration, a real FK from api_keys), and this test
  // is what pays for it: a version bump that adds or renames a field fails
  // here rather than at runtime.
  const expected = getAuthTables({ plugins: [admin()] });
  // `unknown` here is the structural-comparison exception from Global
  // Constraints: these values only ever reach getTableConfig.
  const ours: Readonly<Record<string, unknown>> = {
    user: schema.user,
    session: schema.session,
    account: schema.account,
    verification: schema.verification,
  };
  const toSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  for (const [key, definition] of Object.entries(expected)) {
    const table = ours[key];
    assert.notEqual(table, undefined, `Better Auth expects a '${key}' table the schema does not define`);
    if (table === undefined) continue;
    const config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
    const columns = new Set(config.columns.map((c) => c.name));
    assert.ok(columns.has('id'), `${key} has no id column`);
    for (const [field, spec] of Object.entries(definition.fields)) {
      const column = toSnake(field);
      assert.ok(
        columns.has(column),
        `${key}.${field} (expected column '${column}', type ${String(spec.type)}) is missing`,
      );
    }
  }
});

test('user.role is text, not an enum, so the admin plugin can use it', () => {
  const config = getTableConfig(schema.user);
  const role = config.columns.find((c) => c.name === 'role');
  assert.notEqual(role, undefined, 'user has no role column');
  assert.equal(role?.getSQLType(), 'text');
});

test("api_keys.user_id matches Better Auth's text id type", () => {
  const config = getTableConfig(schema.apiKeys);
  const userId = config.columns.find((c) => c.name === 'user_id');
  assert.equal(userId?.getSQLType(), 'text');
});

test('parses is keyed on category and normalized_key together', () => {
  const config = getTableConfig(schema.parses);
  const pk = config.primaryKeys[0];
  assert.ok(pk !== undefined, 'parses has no composite primary key');
  const cols = pk.columns.map((c) => c.name).sort().join(',');
  assert.equal(cols, 'category,normalized_key');
});
