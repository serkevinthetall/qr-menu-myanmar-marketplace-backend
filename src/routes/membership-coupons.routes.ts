import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooMembershipCouponTicketById,
  fetchOdooMembershipCouponTickets,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

function mapCouponTicket(
  row: Awaited<ReturnType<typeof fetchOdooMembershipCouponTickets>>[number],
) {
  return {
    id: String(row.id),
    name: toStringValue(row.x_name),
    membershipId: String(toRelationId(row.x_studio_membership) || ''),
    membership: toRelationName(row.x_studio_membership),
    customerId: String(toRelationId(row.x_studio_customer) || ''),
    customer: toRelationName(row.x_studio_customer),
    usedDate: toStringValue(row.x_studio_used_date),
    contactId: String(toRelationId(row.x_studio_partner_id) || ''),
    contact: toRelationName(row.x_studio_partner_id),
    currency: toRelationName(row.x_studio_currency) || toRelationName(row.x_studio_currency_id),
    usedSaleOrderId: String(toRelationId(row.x_studio_used_sale_order) || ''),
    usedSaleOrder: toRelationName(row.x_studio_used_sale_order),
    status: toStringValue(row.x_studio_status),
    couponProgram: toStringValue(row.x_studio_coupon_program),
    couponAmount: toNumberValue(row.x_studio_coupon_amount),
    ticketMonth: toStringValue(row.x_studio_ticket_month),
    couponCode: toStringValue(row.x_studio_coupon_code),
  };
}

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const membershipIdRaw = Number(req.query.membershipId);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();
    const membershipId =
      Number.isFinite(membershipIdRaw) && membershipIdRaw > 0
        ? membershipIdRaw
        : undefined;

    const rows = await fetchOdooMembershipCouponTickets(req.user!.id, {
      limit,
      offset,
      q,
      membershipId,
    });
    const data = rows.map(mapCouponTicket);

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
      error instanceof Error
        ? error.message
        : 'Failed to load membership coupon tickets.';
    console.error('[membership-coupons]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return res.status(400).json({ message: 'Invalid coupon ticket id.' });
  }

  try {
    const row = await fetchOdooMembershipCouponTicketById(req.user!.id, ticketId);
    if (!row) {
      return res.status(404).json({ message: 'Membership coupon ticket not found.' });
    }
    return res.json({ data: mapCouponTicket(row) });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load membership coupon ticket.';
    console.error('[membership-coupons/:id]', message);
    return res.status(500).json({ message });
  }
});

export default router;
