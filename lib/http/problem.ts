/**
 * RFC 9457 problem responses.
 *
 * `type` is `about:blank` throughout, which the RFC defines as "no further
 * information beyond the status code". Inventing a URI namespace before anyone
 * needs to dereference one would be documentation nobody reads.
 */
export function problem(status: number, title: string, detail?: string): Response {
  const body: Record<string, string | number> = { type: 'about:blank', title, status };
  // Omitted rather than null: a client checking `'detail' in body` should get a
  // straight answer, and `exactOptionalPropertyTypes` discourages the alternative.
  if (detail !== undefined) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export function badRequest(detail?: string): Response {
  return problem(400, 'Bad Request', detail);
}

export function unauthorized(detail?: string): Response {
  const response = problem(401, 'Unauthorized', detail);
  // Without this a client cannot tell which scheme to retry with.
  response.headers.set('www-authenticate', 'Bearer');
  return response;
}

export function forbidden(detail?: string): Response {
  return problem(403, 'Forbidden', detail);
}

export function notFound(detail?: string): Response {
  return problem(404, 'Not Found', detail);
}

export function rateLimited(retryAfterSeconds: number, detail?: string): Response {
  const response = problem(429, 'Too Many Requests', detail);
  response.headers.set('retry-after', String(retryAfterSeconds));
  return response;
}

export function unavailable(detail?: string): Response {
  return problem(503, 'Service Unavailable', detail);
}
