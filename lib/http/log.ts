/**
 * Records a caught error before it becomes a 5xx.
 *
 * The spec forbids swallowing: a response saying "unavailable" with nothing in
 * the log is a failure nobody can diagnose. `context` should name the
 * operation and, where there is one, the lookup or media id -- never a
 * credential, a bearer header, or a connection string.
 */
export function logFailure(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[media-name-parser] ${context}: ${message}`, stack ?? '');
}
