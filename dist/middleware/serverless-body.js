import express from 'express';
function isParsedJsonObject(body) {
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
function parseJsonString(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // ignore
    }
    return null;
}
function readEventBody(event) {
    if (!event?.body) {
        return null;
    }
    if (event.isBase64Encoded && typeof event.body === 'string') {
        return Buffer.from(event.body, 'base64').toString('utf8');
    }
    return typeof event.body === 'string' ? event.body : null;
}
/** Parse JSON from serverless requests where Express leaves `req.body` as a Buffer. */
export function serverlessJsonBody(req, _res, next) {
    if (isParsedJsonObject(req.body)) {
        return next();
    }
    if (Buffer.isBuffer(req.body)) {
        const parsed = parseJsonString(req.body.toString('utf8'));
        if (parsed) {
            req.body = parsed;
            return next();
        }
    }
    const raw = readEventBody(req.apiGateway?.event);
    if (raw) {
        const parsed = parseJsonString(raw);
        if (parsed) {
            req.body = parsed;
        }
    }
    next();
}
/** JSON parser for local dev; skipped when body is already parsed. */
export function jsonBodyParser(req, res, next) {
    if (isParsedJsonObject(req.body)) {
        return next();
    }
    express.json({
        limit: '10mb',
        type: ['application/json', 'application/*+json', 'text/json', '*/*'],
    })(req, res, next);
}
