import { createApp } from './app.js';
import { env } from './config/env.js';
const app = createApp();
app.listen(env.port, env.host, () => {
    const local = `http://localhost:${env.port}`;
    const lan = `http://${env.lanHost}:${env.port}`;
    console.log(`QR Shop ERP API listening on ${env.host}:${env.port}`);
    console.log(`  Local:    ${local}`);
    console.log(`  LAN:      ${lan}`);
    console.log(`  Health:   ${lan}/api/health`);
    console.log('');
    console.log('  Other laptops on the same Wi‑Fi:');
    console.log(`    App →  http://${env.lanHost}:8081`);
    console.log(`    API →  ${lan}/api/health`);
    if (env.detectedLanHost && env.detectedLanHost !== env.lanHost) {
        console.log('');
        console.log(`  Note: detected IP is ${env.detectedLanHost} (LAN_HOST in .env is ${env.lanHost})`);
    }
});
