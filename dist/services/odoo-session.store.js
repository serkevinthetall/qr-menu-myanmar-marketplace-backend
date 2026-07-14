const sessions = new Map();
export function setOdooSession(userId, session) {
    sessions.set(userId, session);
}
export function getOdooSession(userId) {
    return sessions.get(userId);
}
export function deleteOdooSession(userId) {
    sessions.delete(userId);
}
/** Resolve Odoo session from JWT claims (serverless) or in-memory store (local dev). */
export function resolveOdooSession(payload) {
    if (payload.odooCookie && payload.odooUid) {
        return {
            cookie: payload.odooCookie,
            uid: payload.odooUid,
            login: payload.email,
            createdAt: Date.now(),
        };
    }
    return getOdooSession(payload.sub) ?? null;
}
