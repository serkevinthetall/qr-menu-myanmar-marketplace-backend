import { createApp } from '../src/app.js';

/**
 * Vercel serverless entry — Express app is exported directly.
 * Routes stay under /api/* (see createApp + vercel.json rewrites).
 */
export default createApp();
