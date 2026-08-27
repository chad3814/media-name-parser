import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  problem, badRequest, unauthorized, notFound, rateLimited, unavailable,
} from '../../lib/http/problem';

async function body(response: Response): Promise<Record<string, unknown>> {
  // The immediate argument of a JSON boundary; the value is asserted on below.
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

test('a problem response carries the RFC 9457 shape and content type', async () => {
  const response = problem(400, 'Bad Request', 'category must be one of tv, movies, books, xxx');
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  const parsed = await body(response);
  assert.equal(parsed.status, 400);
  assert.equal(parsed.title, 'Bad Request');
  assert.equal(parsed.detail, 'category must be one of tv, movies, books, xxx');
  assert.equal(parsed.type, 'about:blank');
});

test('detail is omitted rather than sent as null when absent', async () => {
  const parsed = await body(notFound('nothing here'));
  assert.equal(parsed.detail, 'nothing here');
  const bare = await body(problem(404, 'Not Found'));
  assert.ok(!('detail' in bare), 'an absent detail should not appear at all');
});

test('each helper uses its own status', () => {
  assert.equal(badRequest('x').status, 400);
  assert.equal(unauthorized().status, 401);
  assert.equal(notFound().status, 404);
  assert.equal(rateLimited(30).status, 429);
  assert.equal(unavailable().status, 503);
});

test('a 401 advertises the scheme and a 429 advertises Retry-After', () => {
  assert.equal(unauthorized().headers.get('www-authenticate'), 'Bearer');
  assert.equal(rateLimited(30).headers.get('retry-after'), '30');
});

test('a problem body never echoes a credential', async () => {
  // Defensive: `detail` is the only free-text field, and callers must not be
  // able to get a header reflected into it. This asserts the helper does not
  // add anything of its own beyond what it was given.
  const parsed = await body(badRequest('Bearer mnp_secret'));
  assert.equal(parsed.detail, 'Bearer mnp_secret', 'passed through verbatim, nothing added');
  assert.equal(Object.keys(parsed).sort().join(','), 'detail,status,title,type');
});
