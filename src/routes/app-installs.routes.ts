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
  fetchOdooContactsByIds,
  fetchAppOrderStatsByPartnerIds,
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

/** Call list: install records joined with live Odoo contact names/phones. */
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

    const partnerIds = rows.map(row => row.odooPartnerId);
    const [contacts, appOrderStats] = await Promise.all([
      fetchOdooContactsByIds(req.user!.id, partnerIds),
      fetchAppOrderStatsByPartnerIds(req.user!.id, partnerIds),
    ]);
    const contactById = new Map(contacts.map(c => [c.id, c]));

    let data = rows.map(row => {
      const contact = contactById.get(row.odooPartnerId);
      const name =
        (contact ? toStringValue(contact.name) : '') || row.partnerName || '';
      const phone =
        (contact ? toStringValue(contact.phone) : '') || row.partnerPhone || '';
      const orderStat = appOrderStats.get(row.odooPartnerId);
      return {
        ...mapDoc(row as never),
        name,
        phone,
        township: contact
          ? toStringValue(
              Array.isArray(contact.x_studio_many2one_field_8u9_1jp4l7r0g)
                ? contact.x_studio_many2one_field_8u9_1jp4l7r0g[1]
                : '',
            )
          : '',
        appOrderCount: orderStat?.count ?? 0,
        lastAppOrderNumber: orderStat?.lastOrderNumber ?? '',
        lastAppOrderDate: orderStat?.lastOrderDate ?? '',
      };
    });

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
    const contact = await fetchOdooContactById(req.user!.id, partnerId);
    if (!contact) {
      return res.status(404).json({ message: 'Contact not found in Odoo.' });
    }

    const existing = await AppInstallModel.findOne({ odooPartnerId: partnerId });
    if (existing) {
      return res.json({
        data: mapDoc(existing.toObject() as never),
        meta: { created: false },
      });
    }

    const created = await AppInstallModel.create({
      odooPartnerId: partnerId,
      partnerName: toStringValue(contact.name),
      partnerPhone: toStringValue(contact.phone),
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
