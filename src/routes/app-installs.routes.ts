/**
 * @temp-feature app-install-call-list
 * TEMPORARY routes — delete with Call List feature.
 */
import { Router } from 'express';

import { connectMongo, httpStatusForMongoError, isMongoConfigured } from '../config/mongo.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  APP_INSTALL_REASONS,
  APP_INSTALL_STATUSES,
  AppInstallModel,
  appInstallReasonLabel,
  appInstallStatusLabel,
  type AppInstallStatus,
  isAppInstallReason,
  isAppInstallStatus,
  normalizeAppInstallStatus,
  type AppInstallReason,
} from '../models/app-install.model.js';
import {
  fetchOdooContactById,
  fetchOdooPartnerEnrichmentByContactIds,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function requireMongo(res: import('express').Response): boolean {
  if (!isMongoConfigured()) {
    res.status(503).json({
      message:
        'MongoDB is not configured. Set MONGODB_URI on the Vercel backend project.',
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

type MappedInstall = ReturnType<typeof mapDoc>;

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
    township: '',
    street: '',
    street2: '',
    city: '',
    address: '',
    status,
    statusLabel: appInstallStatusLabel(status),
    reason: doc.reason ?? null,
    reasonNote,
    reasonLabel,
    requestedAt: doc.requestedAt?.toISOString?.() ?? null,
    updatedAt: doc.updatedAt?.toISOString?.() ?? null,
    updatedByEmail: doc.updatedByEmail || '',
    updatedByName: doc.updatedByName || '',
    tags: [] as { id: string; name: string }[],
  };
}

async function enrichWithOdooPartnerMeta(
  userId: string,
  rows: ReturnType<typeof mapDoc>[],
): Promise<MappedInstall[]> {
  const partnerIds = rows
    .map(row => Number(row.odooPartnerId))
    .filter(id => Number.isFinite(id) && id > 0);
  if (partnerIds.length === 0) {
    return rows;
  }

  try {
    const metaByPartner = await fetchOdooPartnerEnrichmentByContactIds(
      userId,
      partnerIds,
    );
    return rows.map(row => {
      const partnerId = Number(row.odooPartnerId);
      const meta = metaByPartner.get(partnerId);
      if (!meta) {
        return row;
      }
      return {
        ...row,
        township: meta.township,
        street: meta.street,
        street2: meta.street2,
        city: meta.city,
        address: meta.address,
        tags: meta.tags.map(tag => ({
          id: String(tag.id),
          name: tag.name,
        })),
      };
    });
  } catch (error) {
    console.error(
      '[app-installs] Failed to load Odoo partner meta:',
      error instanceof Error ? error.message : error,
    );
    return rows;
  }
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
    return res.status(httpStatusForMongoError(error)).json({ message });
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
    return res.status(httpStatusForMongoError(error)).json({ message });
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
    return res.status(httpStatusForMongoError(error)).json({ message });
  }
});

/**
 * Status pie + township/tag bars for Overview App User List detail.
 * Township and tags come from Odoo (not Mongo).
 */
router.get('/analytics/breakdown', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    const range = parseAppUserListRange(req.query.range);
    const status = parseAppUserListAnalyticsStatus(req.query.status);
    const { start, end } = buildBucketsAndWindow(range);

    const rangeMatch: Record<string, unknown> = {
      requestedAt: { $gte: start, $lt: end },
    };

    const statusRows = await AppInstallModel.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: rangeMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const statusCount = new Map<string, number>();
    for (const row of statusRows) {
      const key = normalizeAppInstallStatus(row._id);
      statusCount.set(key, (statusCount.get(key) ?? 0) + Number(row.count || 0));
    }

    const byStatus = APP_INSTALL_STATUSES.map(id => ({
      id,
      label: appInstallStatusLabel(id),
      count: statusCount.get(id) ?? 0,
    })).filter(row => row.count > 0);

    const metaMatch: Record<string, unknown> = { ...rangeMatch };
    // Township/tag “who installed” defaults to installed; honor explicit status filter.
    if (status !== 'all') {
      metaMatch.status = status;
    } else {
      metaMatch.status = 'installed';
    }

    const docs = await AppInstallModel.find(metaMatch)
      .select({ odooPartnerId: 1 })
      .lean();
    const partnerIds = docs
      .map(doc => Number(doc.odooPartnerId))
      .filter(id => Number.isFinite(id) && id > 0);

    const townshipCount = new Map<string, number>();
    const tagCount = new Map<string, { id: string; label: string; count: number }>();
    let unknownTownship = 0;
    let unknownTag = 0;

    if (partnerIds.length > 0) {
      try {
        const metaByPartner = await fetchOdooPartnerEnrichmentByContactIds(
          req.user!.id,
          partnerIds,
        );
        for (const partnerId of partnerIds) {
          const meta = metaByPartner.get(partnerId);
          const township = (meta?.township ?? '').trim();
          if (!township) {
            unknownTownship += 1;
          } else {
            townshipCount.set(township, (townshipCount.get(township) ?? 0) + 1);
          }

          const tags = meta?.tags ?? [];
          if (tags.length === 0) {
            unknownTag += 1;
          } else {
            for (const tag of tags) {
              const key = String(tag.id);
              const existing = tagCount.get(key);
              if (existing) {
                existing.count += 1;
              } else {
                tagCount.set(key, {
                  id: key,
                  label: tag.name,
                  count: 1,
                });
              }
            }
          }
        }
      } catch (error) {
        console.error(
          '[app-installs] breakdown Odoo enrichment failed:',
          error instanceof Error ? error.message : error,
        );
        unknownTownship = partnerIds.length;
        unknownTag = partnerIds.length;
      }
    }

    const byTownship = [...townshipCount.entries()]
      .map(([name, count]) => ({
        id: name,
        label: name,
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    if (unknownTownship > 0) {
      byTownship.push({
        id: '__unknown__',
        label: 'No township',
        count: unknownTownship,
      });
    }

    const byTag = [...tagCount.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    );

    if (unknownTag > 0) {
      byTag.push({
        id: '__unknown__',
        label: 'No tag',
        count: unknownTag,
      });
    }

    const metaStatus = status === 'all' ? 'installed' : status;

    return res.json({
      data: {
        range,
        status,
        byStatus,
        byTownship,
        byTag,
        townshipStatus: metaStatus,
        tagStatus: metaStatus,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load App User List breakdown.';
    console.error('[app-installs] analytics breakdown', message);
    return res.status(httpStatusForMongoError(error)).json({ message });
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
    return res.status(httpStatusForMongoError(error)).json({ message });
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

    let data = await enrichWithOdooPartnerMeta(
      req.user!.id,
      rows.map(row => mapDoc(row as never)),
    );

    const tagOptions = new Map<string, { id: string; name: string }>();
    const townshipOptions = new Set<string>();
    for (const row of data) {
      for (const tag of row.tags) {
        if (!tagOptions.has(tag.id)) {
          tagOptions.set(tag.id, tag);
        }
      }
      if (row.township) {
        townshipOptions.add(row.township);
      }
    }

    if (q) {
      data = data.filter(
        row =>
          row.name.toLowerCase().includes(q) ||
          row.phone.toLowerCase().includes(q) ||
          row.township.toLowerCase().includes(q) ||
          row.address.toLowerCase().includes(q) ||
          row.tags.some(tag => tag.name.toLowerCase().includes(q)),
      );
    }

    return res.json({
      data,
      meta: {
        count: data.length,
        status: statuses.length === 1 ? statuses[0] : null,
        statuses,
        tags: [...tagOptions.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
        townships: [...townshipOptions].sort((a, b) => a.localeCompare(b)),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load call list.';
    console.error('[app-installs] list', message);
    return res.status(httpStatusForMongoError(error)).json({ message });
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
    return res.status(httpStatusForMongoError(error)).json({ message });
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
    return res.status(httpStatusForMongoError(error)).json({ message });
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
    return res.status(httpStatusForMongoError(error)).json({ message });
  }
});

export default router;
