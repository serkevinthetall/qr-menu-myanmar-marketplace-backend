/** Odoo returns this when the session cookie is dead but our JWT may still be valid. */
export function isOdooSessionLostMessage(message: string): boolean {
  const text = message.trim().toLowerCase();
  return (
    text.includes('user is not connected') ||
    text.includes('session expired') ||
    text.includes('odoo session expired')
  );
}

export function normalizeOdooErrorMessage(message: string): string {
  if (isOdooSessionLostMessage(message)) {
    return 'Session expired. Please log in again.';
  }
  return message;
}

export function httpStatusForCaughtError(
  error: unknown,
  fallbackStatus = 500,
): number {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return isOdooSessionLostMessage(message) ? 401 : fallbackStatus;
}
