import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooMembershipById,
  fetchOdooMemberships,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

function mapMembership(row: Awaited<ReturnType<typeof fetchOdooMemberships>>[number]) {
  return {
    id: String(row.id),
    name: toStringValue(row.x_name),
    customerId: String(toRelationId(row.x_studio_customer) || ''),
    customer: toRelationName(row.x_studio_customer),
    membershipLevel: toStringValue(row.x_studio_membership_level),
    pricelistId: String(toRelationId(row.x_studio_pricelist) || ''),
    pricelist: toRelationName(row.x_studio_pricelist),
    startDate: toStringValue(row.x_studio_start_date),
    endDate: toStringValue(row.x_studio_end_date),
    status: toStringValue(row.x_studio_status),
    monthlyCouponAmount: toNumberValue(row.x_studio_monthly_coupon_amount),
    totalTickets: toNumberValue(row.x_studio_total_tickets),
    usedTickets: toNumberValue(row.x_studio_used_tickets),
    missedTickets: toNumberValue(row.x_studio_missed_tickets),
    remainingTickets: toNumberValue(row.x_studio_remaining_tickets),
    benefitsSummary: toStringValue(row.x_studio_benefits_summary),
  };
}

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();

    const rows = await fetchOdooMemberships(req.user!.id, { limit, offset, q });
    const data = rows.map(mapMembership);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load memberships.';
    console.error('[memberships]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const membershipId = Number(req.params.id);
  if (!Number.isFinite(membershipId) || membershipId <= 0) {
    return res.status(400).json({ message: 'Invalid membership id.' });
  }

  try {
    const row = await fetchOdooMembershipById(req.user!.id, membershipId);
    if (!row) {
      return res.status(404).json({ message: 'Membership not found.' });
    }
    return res.json({ data: mapMembership(row) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load membership.';
    console.error('[memberships/:id]', message);
    return res.status(500).json({ message });
  }
});

export default router;
