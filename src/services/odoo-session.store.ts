export type OdooSession = {
  cookie: string;
  uid: number;
  login: string;
  createdAt: number;
};

/** Per-request / per-instance cache keyed by user id (hydrated from auth session store). */
const sessions = new Map<string, OdooSession>();

export function setOdooSession(userId: string, session: OdooSession) {
  sessions.set(userId, session);
}

export function getOdooSession(userId: string) {
  return sessions.get(userId);
}

export function deleteOdooSession(userId: string) {
  sessions.delete(userId);
}
