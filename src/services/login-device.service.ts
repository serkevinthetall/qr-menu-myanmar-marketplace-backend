import { createHash, randomUUID } from 'node:crypto';

import {
  connectMongo,
  isMongoConfigured,
} from '../config/mongo.js';
import { LoginDeviceModel } from '../models/login-device.model.js';

export type LoginDeviceInfo = {
  id: string;
  sessionId: string;
  label: string;
  platform: string;
  browser: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

export type DeviceClientMeta = {
  userAgent?: string;
  ip?: string;
};

type MemoryDevice = {
  sessionId: string;
  userId: string;
  userEmail: string;
  userName: string;
  label: string;
  platform: string;
  browser: string;
  userAgent: string;
  ip: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
};

/** Fallback when MongoDB is not configured (local/dev only — not shared across Vercel instances). */
const memoryDevices = new Map<string, MemoryDevice>();

export function describeUserAgent(userAgent: string): {
  label: string;
  platform: string;
  browser: string;
} {
  const ua = userAgent || '';
  const lower = ua.toLowerCase();

  let platform = 'Unknown';
  if (/iphone|ipad|ipod/.test(lower)) platform = 'iOS';
  else if (/android/.test(lower)) platform = 'Android';
  else if (/mac os|macintosh/.test(lower)) platform = 'macOS';
  else if (/windows/.test(lower)) platform = 'Windows';
  else if (/linux/.test(lower)) platform = 'Linux';

  let browser = 'Browser';
  if (/edg\//.test(lower)) browser = 'Edge';
  else if (/chrome\//.test(lower) && !/edg\//.test(lower)) browser = 'Chrome';
  else if (/safari\//.test(lower) && !/chrome\//.test(lower)) browser = 'Safari';
  else if (/firefox\//.test(lower)) browser = 'Firefox';
  else if (/opr\//.test(lower) || /opera/.test(lower)) browser = 'Opera';

  return {
    label: `${browser} on ${platform}`,
    platform,
    browser,
  };
}

export function clientIpFromRequest(req: {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || '';
  }
  if (Array.isArray(forwarded) && typeof forwarded[0] === 'string') {
    return forwarded[0].split(',')[0]?.trim() || '';
  }
  return String(req.ip || req.socket?.remoteAddress || '').trim();
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
}

export async function recordLoginDevice(input: {
  userId: string;
  userEmail: string;
  userName: string;
  meta: DeviceClientMeta;
}): Promise<string | null> {
  const sessionId = randomUUID();
  const userAgent = String(input.meta.userAgent || '').slice(0, 500);
  const ip = String(input.meta.ip || '').slice(0, 64);
  const described = describeUserAgent(userAgent);
  const now = new Date();

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      await LoginDeviceModel.create({
        sessionId,
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        label: described.label,
        platform: described.platform,
        browser: described.browser,
        userAgent,
        ip,
        lastSeenAt: now,
        revokedAt: null,
      });
      return sessionId;
    } catch (error) {
      console.error(
        '[login-devices] Failed to persist device session:',
        error instanceof Error ? error.message : error,
      );
      // Do not put an unpersisted sid in the JWT (other instances would revoke it).
      return null;
    }
  }

  memoryDevices.set(sessionId, {
    sessionId,
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    label: described.label,
    platform: described.platform,
    browser: described.browser,
    userAgent,
    ip,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  return sessionId;
}

export async function touchLoginDevice(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      await LoginDeviceModel.updateOne(
        { sessionId, revokedAt: null },
        { $set: { lastSeenAt: new Date() } },
      );
      return;
    } catch {
      // ignore touch failures
    }
  }

  const row = memoryDevices.get(sessionId);
  if (row && !row.revokedAt) {
    row.lastSeenAt = new Date();
  }
}

export async function isLoginDeviceRevoked(
  sessionId: string | undefined,
): Promise<boolean> {
  if (!sessionId) {
    // Legacy tokens without sid remain valid.
    return false;
  }

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      const row = await LoginDeviceModel.findOne({ sessionId })
        .select({ revokedAt: 1 })
        .lean();
      if (!row) {
        // Unknown sid (DB wiped) — treat as revoked for safety on new tokens.
        return true;
      }
      return Boolean(row.revokedAt);
    } catch {
      return false;
    }
  }

  const row = memoryDevices.get(sessionId);
  if (!row) return true;
  return Boolean(row.revokedAt);
}

export async function listLoginDevices(
  userId: string,
  currentSessionId?: string,
): Promise<LoginDeviceInfo[]> {
  if (isMongoConfigured()) {
    try {
      await connectMongo();
      const rows = await LoginDeviceModel.find({
        userId,
        revokedAt: null,
      })
        .sort({ lastSeenAt: -1 })
        .limit(50)
        .lean();

      return rows.map(row => ({
        id: String(row._id),
        sessionId: row.sessionId,
        label: row.label || 'Unknown device',
        platform: row.platform || 'Unknown',
        browser: row.browser || 'Browser',
        ip: row.ip || '',
        createdAt: new Date(row.createdAt as Date).toISOString(),
        lastSeenAt: new Date(row.lastSeenAt as Date).toISOString(),
        current: Boolean(currentSessionId && row.sessionId === currentSessionId),
      }));
    } catch (error) {
      console.error(
        '[login-devices] list failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  return [...memoryDevices.values()]
    .filter(row => row.userId === userId && !row.revokedAt)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map(row => ({
      id: hashSessionId(row.sessionId),
      sessionId: row.sessionId,
      label: row.label,
      platform: row.platform,
      browser: row.browser,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      current: Boolean(currentSessionId && row.sessionId === currentSessionId),
    }));
}

export async function revokeLoginDevice(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) return false;

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      const result = await LoginDeviceModel.updateOne(
        { userId, sessionId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      return (result.modifiedCount ?? 0) > 0;
    } catch (error) {
      console.error(
        '[login-devices] revoke failed:',
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  const row = memoryDevices.get(sessionId);
  if (!row || row.userId !== userId || row.revokedAt) {
    return false;
  }
  row.revokedAt = new Date();
  return true;
}

export async function revokeLoginDeviceById(
  userId: string,
  deviceId: string,
  currentSessionId?: string,
): Promise<{ ok: boolean; revokedCurrent: boolean }> {
  if (isMongoConfigured()) {
    try {
      await connectMongo();
      const row = await LoginDeviceModel.findOne({
        _id: deviceId,
        userId,
        revokedAt: null,
      }).lean();
      if (!row) {
        return { ok: false, revokedCurrent: false };
      }
      await LoginDeviceModel.updateOne(
        { _id: row._id },
        { $set: { revokedAt: new Date() } },
      );
      return {
        ok: true,
        revokedCurrent: Boolean(
          currentSessionId && row.sessionId === currentSessionId,
        ),
      };
    } catch {
      return { ok: false, revokedCurrent: false };
    }
  }

  const match = [...memoryDevices.values()].find(
    row =>
      row.userId === userId &&
      !row.revokedAt &&
      (row.sessionId === deviceId || hashSessionId(row.sessionId) === deviceId),
  );
  if (!match) {
    return { ok: false, revokedCurrent: false };
  }
  match.revokedAt = new Date();
  return {
    ok: true,
    revokedCurrent: Boolean(
      currentSessionId && match.sessionId === currentSessionId,
    ),
  };
}
