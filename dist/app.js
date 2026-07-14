import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { jsonBodyParser, serverlessJsonBody, } from './middleware/serverless-body.js';
import routes from './routes/index.js';
export function createApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(cors({
        // In dev, reflect any origin so LAN IP changes (8081/19006) don't break fetch.
        origin: env.nodeEnv === 'development'
            ? true
            : env.corsOrigins,
        credentials: true,
    }));
    app.use(serverlessJsonBody);
    app.use(jsonBodyParser);
    app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
    // Root → health so visiting the Vercel domain shows API status.
    app.get('/', (_req, res) => {
        res.redirect(302, '/api/health');
    });
    app.use('/api', routes);
    app.use(errorHandler);
    return app;
}
/** Default export required by Vercel Express framework (`src/app.ts`). */
const app = createApp();
export default app;
