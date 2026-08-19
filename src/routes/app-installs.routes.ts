/**
 * @temp-feature app-install-call-list
 * TEMPORARY routes — delete with Call List feature.
 */
import { Router } from 'express';

import { connectMongo, isMongoConfigured } from '../config/mongo.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  APP_INSTALL_REASONS,
  APP_INSTALL_STATUSES,
  AppInstallModel,
  appInstallReasonLabel,
  appInstallStatusLabel,
  isAppInstallReason,
  isAppInstallStatus,
  normalizeAppInstallStatus,
  type AppInstallReason,
} from '../models/app-install.model.js';
import {
  fetchOdooContactById,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function requireMongo(res: import('express').Response): boolean {
  if (!isMongoConfigured()) {
    res.status(503).json({
      message:
        'MongoDB is not configured. Set MONGODB_URI on the Vercel backend.',
    });
    return false;
  }
  return true;
}

function toStringValue(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function mapDoc(doc: {
  odooPartnerId: number;
  partnerName?: string | null;
  partnerPhone?: string | null;
  status: string;
  reason?: AppInstallReason | null;
  reasonNote?: string | null;
  requestedAt?: Date | null;
  updatedAt?: Date | null;
  updatedByEmail?: string | null;
  updatedByName?: string | null;
}) {
  const status = normalizeAppInstallStatus(doc.status);
  const reasonNote = toStringValue(doc.reasonNote);
  const reasonLabel =
    status === 'waiting'
      ? reasonNote
      : appInstallReasonLabel(doc.reason, reasonNote);
  return {
    id: String(doc.odooPartnerId),
    odooPartnerId: String(doc.odooPartnerId),
    name: doc.partnerName || '',
    phone: doc.partnerPhone || '',
    status,
    statusLabel: appInstallStatusLabel(status),
    reason: doc.reason ?? null,
    reasonNote,
    reasonLabel,
    requestedAt: doc.requestedAt?.toISOString?.() ?? null,
    updatedAt: doc.updatedAt?.toISOString?.() ?? null,
    updatedByEmail: doc.updatedByEmail || '',
    updatedByName: doc.updatedByName || '',
  };
}

router.get('/meta', (_req, res) => {
  return res.json({
    data: {
      statuses: APP_INSTALL_STATUSES.map(status => ({
        id: status,
        label: appInstallStatusLabel(status),
      })),
      reasons: APP_INSTALL_REASONS.map(reason => ({
        id: reason,
        label: appInstallReasonLabel(reason),
      })),
    },
  });
});

/** Sidebar badge: count of New call requests. */
router.get('/badge', async (_req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    const newCount = await AppInstallModel.countDocuments({
      status: 'new',
    });
    return res.json({
      data: {
        newCount,
        // Kept for older frontends during deploy overlap.
        notInstalledCount: newCount,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load call list badge.';
    console.error('[app-installs] badge', message);
    return res.status(500).json({ message });
  }
});

type AppUserListRange = 'today' | 'yesterday' | 'week' | 'month';

const YANGON_OFFSET_MS = 6.5 * 60 * 60 * 1000;

function toYangonLocal(date: Date): Date {
  return new Date(date.getTime() + YANGON_OFFSET_MS);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatYangonYMD(dateUtc: Date): string {
  const d = toYangonLocal(dateUtc);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate(),
  )}`;
}

function formatYangonHourBucket(dateUtc: Date): string {
  const d = toYangonLocal(dateUtc);
  return `${formatYangonYMD(dateUtc)}T${pad2(d.getUTCHours())}`;
}

function yangonStartOfDayUtc(dateUtc: Date): Date {
  const d = toYangonLocal(dateUtc);
  const startLocalMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  return new Date(startLocalMs - YANGON_OFFSET_MS);
}

function yangonStartOfWeekUtc(nowUtc: Date): Date {
  // Monday as week start.
  const d = toYangonLocal(nowUtc);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const startLocalMs =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0) +
    diff * 86400000;
  return new Date(startLocalMs - YANGON_OFFSET_MS);
}

function yangonStartOfMonthUtc(nowUtc: Date): Date {
  const d = toYangonLocal(nowUtc);
  const startLocalMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0);
  return new Date(startLocalMs - YANGON_OFFSET_MS);
}

function addDaysUtc(dateUtc: Date, days: number): Date {
  return new Date(dateUtc.getTime() + days * 86400000);
}

function parseAppUserListRange(raw: unknown): AppUserListRange {
  const value = String(raw ?? 'month').trim().toLowerCase();
  if (value === 'today') return 'today';
  if (value === 'yesterday') return 'yesterday';
  if (value === 'week') return 'week';
  return 'month';
}

function parseAppUserListAnalyticsStatus(raw: unknown): AppInstallStatus | 'all' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'all') return 'all';
  if (isAppInstallStatus(value)) return value;
  // Unknown status -> treat as installed to keep the UI useful.
  return 'installed';
}

function buildBucketsAndWindow(range: AppUserListRange, now = new Date()): {
  start: Date;
  end: Date;
  buckets: string[];
  bucketMode: 'day' | 'hour';
} {
  if (range === 'today') {
    const start = yangonStartOfDayUtc(now);
    const end = addDaysUtc(start, 1);
    const buckets: string[] = [];
    for (let h = 0; h < 24; h += 1) {
      const d = addDaysUtc(start, 0); // clone
      const bucketUtc = new Date(d.getTime() + h * 3600000);
      buckets.push(formatYangonHourBucket(bucketUtc));
    }
    return { start, end, buckets, bucketMode: 'hour' };
  }

  if (range === 'yesterday') {
    const start = addDaysUtc(yangonStartOfDayUtc(now), -1);
    const end = yangonStartOfDayUtc(now);
    const buckets: string[] = [];
    for (let h = 0; h < 24; h += 1) {
      const bucketUtc = new Date(start.getTime() + h * 3600000);
      buckets.push(formatYangonHourBucket(bucketUtc));
    }
    return { start, end, buckets, bucketMode: 'hour' };
  }

  if (range === 'week') {
    const start = yangonStartOfWeekUtc(now);
    const end = addDaysUtc(start, 7);
    const buckets: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const dayUtc = addDaysUtc(start, i);
      buckets.push(formatYangonYMD(dayUtc));
    }
    return { start, end, buckets, bucketMode: 'day' };
  }

  // month
  const start = yangonStartOfMonthUtc(now);
  const end = (() => {
    const d = toYangonLocal(now);
    const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0) - YANGON_OFFSET_MS);
    return nextMonth;
  })();
  const buckets: string[] = [];
  for (let cursor = new Date(start); cursor < end; cursor = addDaysUtc(cursor, 1)) {
    buckets.push(formatYangonYMD(cursor));
  }
  return { start, end, buckets, bucketMode: 'day' };
}

router.get('/analytics/summary', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    const range = parseAppUserListRange(req.query.range);
    const status = parseAppUserListAnalyticsStatus(req.query.status);
    const { start, end } = buildBucketsAndWindow(range);
    const match: Record<string, unknown> = {
      requestedAt: { $gte: start, $lt: end },
    };
    if (status !== 'all') {
      match.status = status;
    }

    const count = await AppInstallModel.countDocuments(match);
    return res.json({ data: { range, count } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load App User List summary.';
    console.error('[app-installs] analytics summary', message);
    return res.status(500).json({ message });
  }
});

router.get('/analytics/timeline', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    const range = parseAppUserListRange(req.query.range);
    const status = parseAppUserListAnalyticsStatus(req.query.status);
    const { start, end, buckets, bucketMode } = buildBucketsAndWindow(range);

    const keyFormat = bucketMode === 'hour' ? '%Y-%m-%dT%H' : '%Y-%m-%d';

    const match: Record<string, unknown> = {
      requestedAt: { $gte: start, $lt: end },
    };
    if (status !== 'all') {
      match.status = status;
    }

    const rows = await AppInstallModel.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: {
              format: keyFormat,
              date: '$requestedAt',
              timezone: 'Asia/Yangon',
            },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const byBucket = new Map<string, number>();
    for (const row of rows) {
      byBucket.set(row._id, row.count);
    }

    const total = buckets.reduce((sum, b) => sum + (byBucket.get(b) || 0), 0);

    return res.json({
      data: {
        range,
        count: total,
        buckets,
        series: [
          {
            name: status === 'all' ? 'App User List' : 'Installed users',
            total,
            points: buckets.map(bucket => ({
              bucket,
              value: byBucket.get(bucket) || 0,
            })),
          },
        ],
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load App User List timeline.';
    console.error('[app-installs] analytics timeline', message);
    return res.status(500).json({ message });
  }
});

/** Map of odooPartnerId -> install record (for Contact list badges). */
router.get('/map', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    const idsRaw = String(req.query.ids ?? '')
      .split(',')
      .map(part => Number(part.trim()))
      .filter(id => Number.isFinite(id) && id > 0);

    const query =
      idsRaw.length > 0 ? { odooPartnerId: { $in: idsRaw } } : {};
    const rows = await AppInstallModel.find(query).lean();
    const map: Record<string, ReturnType<typeof mapDoc>> = {};
    for (const row of rows) {
      map[String(row.odooPartnerId)] = mapDoc(row as never);
    }
    return res.json({ data: map });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load install map.';
    console.error('[app-installs] map', message);
    return res.status(500).json({ message });
  }
});

/** Call list: Mongo install records only (name/phone saved at Request time). */
router.get('/', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    const statusRaw = String(req.query.status ?? '').trim();
    const statuses = statusRaw
      .split(',')
      .map(value => value.trim())
      .filter(isAppInstallStatus);
    const q = String(req.query.q ?? '').trim().toLowerCase();

    const filter: Record<string, unknown> = {};
    if (statuses.length === 1) {
      filter.status = statuses[0];
    } else if (statuses.length > 1) {
      filter.status = { $in: statuses };
    }

    const rows = await AppInstallModel.find(filter)
      .sort({ updatedAt: -1 })
      .lean();

    let data = rows.map(row => mapDoc(row as never));

    if (q) {
      data = data.filter(
        row =>
          row.name.toLowerCase().includes(q) ||
          row.phone.toLowerCase().includes(q),
      );
    }

    return res.json({
      data,
      meta: {
        count: data.length,
        status: statuses.length === 1 ? statuses[0] : null,
        statuses,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load call list.';
    console.error('[app-installs] list', message);
    return res.status(500).json({ message });
  }
});

/** Add contact to Call list (Request). */
router.post('/:partnerId/request', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  const partnerId = Number(req.params.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  try {
    await connectMongo();
    const existing = await AppInstallModel.findOne({ odooPartnerId: partnerId });
    if (existing) {
      return res.json({
        data: mapDoc(existing.toObject() as never),
        meta: { created: false },
      });
    }

    const nameFromBody = toStringValue(req.body?.name).trim();
    const phoneFromBody = toStringValue(req.body?.phone).trim();
    let partnerName = nameFromBody;
    let partnerPhone = phoneFromBody;

    if (!partnerName) {
      const contact = await fetchOdooContactById(req.user!.id, partnerId);
      if (!contact) {
        return res.status(404).json({ message: 'Contact not found in Odoo.' });
      }
      partnerName = toStringValue(contact.name);
      if (!partnerPhone) {
        partnerPhone = toStringValue(contact.phone);
      }
    }

    const created = await AppInstallModel.create({
      odooPartnerId: partnerId,
      partnerName,
      partnerPhone,
      status: 'new',
      reason: null,
      requestedAt: new Date(),
      updatedByEmail: req.user?.email ?? '',
      updatedByName: req.user?.name ?? '',
    });

    return res.status(201).json({
      data: mapDoc(created.toObject() as never),
      meta: { created: true },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create install request.';
    console.error('[app-installs] request', message);
    return res.status(500).json({ message });
  }
});

/** Update install status / reason. */
router.put('/:partnerId', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  const partnerId = Number(req.params.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  const statusRaw = req.body?.status;
  if (!isAppInstallStatus(statusRaw)) {
    return res.status(400).json({
      message: `Invalid status. Use one of: ${APP_INSTALL_STATUSES.join(', ')}`,
    });
  }

  let reason: AppInstallReason | null = null;
  let reasonNote = '';
  if (statusRaw === 'not_installed') {
    // Reason optional when first requested; required only when a reason is sent.
    if (req.body?.reason != null && req.body.reason !== '') {
      if (!isAppInstallReason(req.body.reason)) {
        return res.status(400).json({
          message: `Invalid reason. Use one of: ${APP_INSTALL_REASONS.join(', ')}`,
        });
      }
      reason = req.body.reason;
      if (reason === 'other') {
        reasonNote = toStringValue(req.body?.reasonNote).trim().slice(0, 500);
        if (!reasonNote) {
          return res.status(400).json({
            message: 'Please type a reason when selecting Other.',
          });
        }
      }
    }
  } else if (statusRaw === 'waiting') {
    reasonNote = toStringValue(req.body?.reasonNote).trim().slice(0, 500);
    if (!reasonNote) {
      return res.status(400).json({
        message: 'Please type a note for Waiting.',
      });
    }
  }

  try {
    await connectMongo();
    let doc = await AppInstallModel.findOne({ odooPartnerId: partnerId });
    if (!doc) {
      const contact = await fetchOdooContactById(req.user!.id, partnerId);
      if (!contact) {
        return res.status(404).json({ message: 'Contact not found in Odoo.' });
      }
      doc = await AppInstallModel.create({
        odooPartnerId: partnerId,
        partnerName: toStringValue(contact.name),
        partnerPhone: toStringValue(contact.phone),
        status: statusRaw,
        reason,
        reasonNote,
        requestedAt: new Date(),
        updatedByEmail: req.user?.email ?? '',
        updatedByName: req.user?.name ?? '',
      });
    } else {
      doc.status = statusRaw;
      if (
        statusRaw === 'installed' ||
        statusRaw === 'please_come_and_install' ||
        statusRaw === 'not_pick_up' ||
        statusRaw === 'new'
      ) {
        doc.reason = null;
        doc.reasonNote = '';
      } else if (statusRaw === 'waiting') {
        doc.reason = null;
        doc.reasonNote = reasonNote;
      } else if (reason) {
        doc.reason = reason;
        doc.reasonNote = reason === 'other' ? reasonNote : '';
      }
      doc.updatedByEmail = req.user?.email ?? '';
      doc.updatedByName = req.user?.name ?? '';
      await doc.save();
    }

    return res.json({ data: mapDoc(doc.toObject() as never) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update install status.';
    console.error('[app-installs] update', message);
    return res.status(500).json({ message });
  }
});

/** Remove contact from Call List (undo accidental Request). */
router.delete('/:partnerId', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  const partnerId = Number(req.params.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  try {
    await connectMongo();
    // Native delete so legacy enum values (e.g. not_called) still match.
    const result = await AppInstallModel.collection.deleteOne({
      odooPartnerId: partnerId,
    });
    if (!result.deletedCount) {
      return res.status(404).json({ message: 'App User List entry not found.' });
    }
    return res.json({ data: { odooPartnerId: String(partnerId), removed: true } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to remove from App User List.';
    console.error('[app-installs] delete', message);
    return res.status(500).json({ message });
  }
});

export default router;
