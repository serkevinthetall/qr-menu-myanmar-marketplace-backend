const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'admin123',
  'welcome1',
  'letmein1',
  '11111111',
  '00000000',
]);

/**
 * Portal / external account password rules.
 * Throws Error with a user-facing message when invalid.
 */
export function assertPortalPassword(password: unknown): string {
  const pwd = typeof password === 'string' ? password : '';
  if (!pwd || !pwd.trim()) {
    throw new Error('Password is required.');
  }
  if (pwd.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (WEAK_PASSWORDS.has(pwd.toLowerCase())) {
    throw new Error('Choose a stronger password.');
  }
  return pwd;
}
