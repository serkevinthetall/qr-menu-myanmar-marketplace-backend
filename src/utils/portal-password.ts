/**
 * Require a non-empty portal / external account password.
 * Throws Error with a user-facing message when missing.
 */
export function assertPortalPassword(password: unknown): string {
  const pwd = typeof password === 'string' ? password : '';
  if (!pwd || !pwd.trim()) {
    throw new Error('Password is required.');
  }
  return pwd;
}
