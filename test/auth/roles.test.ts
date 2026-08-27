import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_ROLE, parseRoles, hasRole, withRole, withoutRole,
} from '../../lib/auth/roles';

test('parseRoles splits a comma-separated column and trims each entry', () => {
  assert.deepEqual(parseRoles('admin'), ['admin']);
  assert.deepEqual(parseRoles('support,admin'), ['support', 'admin']);
  assert.deepEqual(parseRoles(' admin , support '), ['admin', 'support']);
});

test('parseRoles yields an empty list for absent or empty input', () => {
  assert.deepEqual(parseRoles(null), []);
  assert.deepEqual(parseRoles(undefined), []);
  assert.deepEqual(parseRoles(''), []);
  assert.deepEqual(parseRoles(',,  ,'), []);
});

test('hasRole matches a whole entry, never a substring', () => {
  // The two bugs this module exists to prevent, as assertions.
  assert.equal(hasRole('support,admin', ADMIN_ROLE), true, 'multi-role admin must pass');
  assert.equal(hasRole('administrator-readonly', ADMIN_ROLE), false, 'substring must not pass');
  assert.equal(hasRole('adminx', ADMIN_ROLE), false);
  assert.equal(hasRole('user', ADMIN_ROLE), false);
});

test('withRole appends without disturbing existing roles', () => {
  assert.equal(withRole('support', ADMIN_ROLE), 'support,admin');
  assert.equal(withRole('user', ADMIN_ROLE), 'user,admin');
});

test('withRole is idempotent', () => {
  assert.equal(withRole('support,admin', ADMIN_ROLE), 'support,admin');
  assert.equal(withRole('admin', ADMIN_ROLE), 'admin');
});

test('withRole on an empty column yields just the role', () => {
  assert.equal(withRole(null, ADMIN_ROLE), 'admin');
  assert.equal(withRole('', ADMIN_ROLE), 'admin');
});

test('withoutRole removes only the named role', () => {
  assert.equal(withoutRole('support,admin', ADMIN_ROLE), 'support');
  assert.equal(withoutRole('admin,support', ADMIN_ROLE), 'support');
});

test('withoutRole is idempotent', () => {
  assert.equal(withoutRole('support', ADMIN_ROLE), 'support');
});

test('removing the last role falls back to user, never an empty string', () => {
  // The column is NOT NULL DEFAULT 'user'. Writing '' would satisfy the
  // constraint while meaning something no other code understands.
  assert.equal(withoutRole('admin', ADMIN_ROLE), 'user');
  assert.equal(withoutRole(null, ADMIN_ROLE), 'user');
});
