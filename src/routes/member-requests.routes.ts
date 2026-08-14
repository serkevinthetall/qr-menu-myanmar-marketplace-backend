import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  countOdooMembershipApplications,
  fetchOdooMembershipApplicationById,
  fetchOdooMembershipApplications,
  isMemberRequestStatus,
  MEMBER_REQUEST_PLANS,
  MEMBER_REQUEST_STATUSES,
  normalizeMemberRequestStatus,
  updateOdooMembershipApplicationStatus,
  type OdooMembershipApplication,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

function mapMemberRequest(row: OdooMembershipApplication) {
  return {
    id: String(row.id),
    customerId: String(toRelationId(row.x_studio_customer) || ''),
    customer: toRelationName(row.x_studio_customer),
    requestedPlan: toStringValue(row.x_studio_selection_field_2c0_1jvv3u0te),
    name: toStringValue(row.x_studio_name),
    phone: toStringValue(row.x_studio_phone),
    email: toStringValue(row.x_studio_email),
    status: normalizeMemberRequestStatus(row.x_studio_status),
    requestedAt: toStringValue(row.x_studio_requested_at),
    notes: toStringValue(row.x_studio_notes_1),
  };
}

router.use(authMiddleware);

router.get('/meta', (_req, res) => {
  return res.json({
    data: {
      statuses: MEMBER_REQUEST_STATUSES.map(status => ({
        id: status,
        label: status,
      })),
      plans: MEMBER_REQUEST_PLANS.map(plan => ({ id: plan, label: plan })),
    },
  });
});

/** Badge: count of Requested member applications. */
router.get('/badge', async (req: AuthRequest, res) => {
  try {
    const requestedCount = await countOdooMembershipApplications(req.user!.id, {
      status: 'Requested',
    });
    return res.json({ data: { requestedCount } });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load member request badge.';
    console.error('[member-requests] badge', message);
    return res.status(500).json({ message });
  }
});

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();
    const status = String(req.query.status ?? '').trim();

    const rows = await fetchOdooMembershipApplications(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
      status: status || undefined,
    });
    const data = rows.map(mapMemberRequest);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        status: status || null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load member requests.';
    console.error('[member-requests]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid member request id.' });
  }

  try {
    const row = await fetchOdooMembershipApplicationById(req.user!.id, id);
    if (!row) {
      return res.status(404).json({ message: 'Member request not found.' });
    }
    return res.json({ data: mapMemberRequest(row) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load member request.';
    console.error('[member-requests/:id]', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id/status', async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid member request id.' });
  }

  const statusRaw = req.body?.status;
  if (!isMemberRequestStatus(statusRaw)) {
    return res.status(400).json({
      message: `Invalid status. Use one of: ${MEMBER_REQUEST_STATUSES.join(', ')}`,
    });
  }

  try {
    const updated = await updateOdooMembershipApplicationStatus(
      req.user!.id,
      id,
      statusRaw,
    );
    return res.json({ data: mapMemberRequest(updated) });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to update member request status.';
    console.error('[member-requests] status', message);
    return res.status(500).json({ message });
  }
});

export default router;
