/** Parse jsonwebtoken-style expiresIn (e.g. 1d, 12h, 30m, 60) to milliseconds. */
export function parseJwtExpiresInMs(expiresIn: string): number {
  const trimmed = expiresIn.trim();
  const match = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs =
      unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
    return amount * unitMs;
  }

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return asSeconds * 1000;
  }

  // Safe default: 1 day
  return 24 * 60 * 60 * 1000;
}

export function jwtExpiresAtIso(expiresIn: string): string {
  return new Date(Date.now() + parseJwtExpiresInMs(expiresIn)).toISOString();
}
