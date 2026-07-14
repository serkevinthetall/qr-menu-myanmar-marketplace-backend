import os from 'os';
/** Prefer Wi‑Fi (en0), then fall back to any non-internal IPv4 address. */
export function getLanIPv4() {
    try {
        const interfaces = os.networkInterfaces();
        const preferred = ['en0', 'en1', 'wlan0', 'eth0'];
        for (const name of preferred) {
            const match = pickIPv4(interfaces[name]);
            if (match) {
                return match;
            }
        }
        for (const entries of Object.values(interfaces)) {
            const match = pickIPv4(entries);
            if (match) {
                return match;
            }
        }
    }
    catch {
        // Serverless (Vercel/Netlify) may restrict networkInterfaces().
    }
    return null;
}
function pickIPv4(entries) {
    if (!entries) {
        return null;
    }
    for (const entry of entries) {
        const family = String(entry.family);
        const isIPv4 = family === 'IPv4' || family === '4';
        if (isIPv4 && !entry.internal) {
            return entry.address;
        }
    }
    return null;
}
