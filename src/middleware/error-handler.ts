import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { env } from '../config/env.js';

function isPayloadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
  return (
    e.status === 413 ||
    e.statusCode === 413 ||
    e.type === 'entity.too.large' ||
    /too large/i.test(String(e.message ?? ''))
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: 'Validation failed.',
      errors: err.flatten().fieldErrors,
    });
  }

  if (isPayloadTooLarge(err)) {
    return res.status(413).json({
      message: 'Request body is too large.',
    });
  }

  if (err instanceof Error) {
    const message =
      env.nodeEnv === 'production' ? 'Internal server error.' : err.message;
    return res.status(500).json({ message });
  }

  return res.status(500).json({ message: 'Unexpected server error.' });
}
