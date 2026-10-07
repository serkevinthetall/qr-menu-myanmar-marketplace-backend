import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooVendorPayments,
  vendorPaymentStateLabel,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

const STATUS_FILTERS = ['draft', 'in_process', 'paid', 'cancel'] as const;

function mapRow(
  row: Awaited<ReturnType<typeof fetchOdooVendorPayments>>[number],
) {
  const state = toStringValue(row.state);
  const paymentType = toStringValue(row.payment_type);
  const rawAmount = toNumberValue(row.amount);
  // Match Odoo vendor payment list: outbound amounts show as negative.
  const amount =
    paymentType === 'outbound' || paymentType === ''
      ? -Math.abs(rawAmount)
      : rawAmount;

  return {
    id: String(row.id),
    date: toStringValue(row.date),
    number: toStringValue(row.name),
    journal: toRelationName(row.journal_id),
    vendorId: String(toRelationId(row.partner_id) || ''),
    vendor: toRelationName(row.partner_id),
    paymentMethod: toRelationName(row.payment_method_line_id),
    amount,
    currency: toRelationName(row.currency_id) || 'MMK',
    state,
    statusLabel: vendorPaymentStateLabel(state),
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
    const status = STATUS_FILTERS.includes(
      statusRaw as (typeof STATUS_FILTERS)[number],
    )
      ? statusRaw
      : '';

    const rows = await fetchOdooVendorPayments(req.user!.id, {
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
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load vendor payments.';
    console.error('[vendor-payments]', message);
    return res.status(500).json({ message });
  }
});

export default router;
