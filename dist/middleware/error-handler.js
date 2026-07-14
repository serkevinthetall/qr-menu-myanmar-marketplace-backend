import { ZodError } from 'zod';
import { env } from '../config/env.js';
export function errorHandler(err, _req, res, _next) {
    if (err instanceof ZodError) {
        return res.status(400).json({
            message: 'Validation failed.',
            errors: err.flatten().fieldErrors,
        });
    }
    if (err instanceof Error) {
        const message = env.nodeEnv === 'production' ? 'Internal server error.' : err.message;
        return res.status(500).json({ message });
    }
    return res.status(500).json({ message: 'Unexpected server error.' });
}
