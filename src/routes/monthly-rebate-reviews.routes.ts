import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import { fetchOdooMonthlyRebateReviews } from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

const STATUS_VALUES = [
  'To Review',
  'Approved',
  'Rejected',
  'Credit Note Created',
  'Paid',
] as const;

function mapRow(
  row: Awaited<ReturnType<typeof fetchOdooMonthlyRebateReviews>>[number],
) {
  return {
    id: String(row.id),
    displayName: toStringValue(row.x_studio_related_field_1mt_1jq8u17jc),
    reference: toStringValue(row.x_name),
    customerId: String(toRelationId(row.x_studio_customer) || ''),
    customer: toRelationName(row.x_studio_customer),
    month: toStringValue(row.x_studio_month),
    rebateRate: toNumberValue(row.x_studio_rebate_rate),
    paidSales: toNumberValue(row.x_studio_paid_sales),
    rebateAmount: toNumberValue(row.x_studio_rebate_amount),
    status: toStringValue(row.x_studio_status),
    name: toStringValue(row.x_studio_related_field_733_1jq8u2g7o),
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
    const statusRaw = String(req.query.status ?? '').trim();
    const status = STATUS_VALUES.includes(
      statusRaw as (typeof STATUS_VALUES)[number],
    )
      ? statusRaw
      : '';

    const rows = await fetchOdooMonthlyRebateReviews(req.user!.id, {
      limit,
      offset,
      q,
      status: status || undefined,
    });
    const data = rows.map(mapRow);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        statuses: STATUS_VALUES,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load monthly rebate reviews.';
    console.error('[monthly-rebate-reviews]', message);
    return res.status(500).json({ message });
  }
});

export default router;
