import express, { NextFunction, Request, Response } from 'express';

/** Default JSON body size for normal API routes (100kb–1mb range). */
export const DEFAULT_JSON_BODY_LIMIT = '1mb';

/** Larger limit for future upload / base64 payload routes only. */
export const UPLOAD_JSON_BODY_LIMIT = '10mb';

type ServerlessRequest = Request & {
  apiGateway?: {
    event?: {
      body?: string | null;
      isBase64Encoded?: boolean;
      headers?: Record<string, string | undefined>;
    };
  };
};

function limitToBytes(limit: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!match) return 1024 * 1024;
  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const mult =
    unit === 'gb'
      ? 1024 ** 3
      : unit === 'mb'
        ? 1024 ** 2
        : unit === 'kb'
          ? 1024
          : 1;
  return Math.floor(amount * mult);
}

const DEFAULT_MAX_BYTES = limitToBytes(DEFAULT_JSON_BODY_LIMIT);

function isParsedJsonObject(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    return false;
  }

  if (Buffer.isBuffer(body)) {
    return false;
  }

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return false;
  }

  // Buffers mistaken for objects expose numeric keys ("0", "1", ...).
  if (keys.every(key => /^\d+$/.test(key))) {
    return false;
  }

  return true;
}

function parseJsonString(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  return null;
}

function readEventBody(event: NonNullable<ServerlessRequest['apiGateway']>['event']) {
  if (!event?.body) {
    return null;
  }

  if (event.isBase64Encoded && typeof event.body === 'string') {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }

  return typeof event.body === 'string' ? event.body : null;
}

function rejectTooLarge(res: Response, next: NextFunction): void {
  const err = new Error('Request entity too large') as Error & {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  err.status = 413;
  err.statusCode = 413;
  err.type = 'entity.too.large';
  next(err);
}

/** Parse JSON from serverless requests where Express leaves `req.body` as a Buffer. */
export function serverlessJsonBody(
  req: ServerlessRequest,
  res: Response,
  next: NextFunction,
) {
  if (isParsedJsonObject(req.body)) {
    return next();
  }

  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > DEFAULT_MAX_BYTES) {
      return rejectTooLarge(res, next);
    }
    const parsed = parseJsonString(req.body.toString('utf8'));
    if (parsed) {
      req.body = parsed;
      return next();
    }
  }

  const raw = readEventBody(req.apiGateway?.event);
  if (raw) {
    if (Buffer.byteLength(raw, 'utf8') > DEFAULT_MAX_BYTES) {
      return rejectTooLarge(res, next);
    }
    const parsed = parseJsonString(raw);
    if (parsed) {
      req.body = parsed;
    }
  }

  next();
}

/** JSON parser for local / Vercel Express; skipped when body is already parsed. */
export function jsonBodyParser(req: Request, res: Response, next: NextFunction) {
  if (isParsedJsonObject(req.body)) {
    return next();
  }

  express.json({
    limit: DEFAULT_JSON_BODY_LIMIT,
    type: ['application/json', 'application/*+json', 'text/json', '*/*'],
  })(req, res, next);
}

/**
 * Use on upload-specific routes only (mount before the route handler).
 * Example: router.post('/upload', jsonBodyParserWithLimit(UPLOAD_JSON_BODY_LIMIT), ...)
 */
export function jsonBodyParserWithLimit(limit: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isParsedJsonObject(req.body)) {
      return next();
    }
    express.json({
      limit,
      type: ['application/json', 'application/*+json', 'text/json', '*/*'],
    })(req, res, next);
  };
}
