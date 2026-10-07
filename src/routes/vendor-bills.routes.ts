import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooVendorBills,
  vendorBillPaymentStateLabel,
  vendorBillStateLabel,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

const STATUS_FILTERS = ['draft', 'not_paid', 'paid', 'cancel'] as const;

function mapRow(row: Awaited<ReturnType<typeof fetchOdooVendorBills>>[number]) {
  const state = toStringValue(row.state);
  const paymentState = toStringValue(row.payment_state);
  const statusLabel =
    state === 'draft' || state === 'cancel'
      ? vendorBillStateLabel(state)
      : vendorBillPaymentStateLabel(paymentState) || vendorBillStateLabel(state);

  return {
    id: String(row.id),
    number: toStringValue(row.name),
    vendorId: String(toRelationId(row.partner_id) || ''),
    vendor: toRelationName(row.partner_id),
    billDate: toStringValue(row.invoice_date),
    dueDate: toStringValue(row.invoice_date_due),
    reference: toStringValue(row.ref),
    amountUntaxed: toNumberValue(row.amount_untaxed),
    amountTotal: toNumberValue(row.amount_total),
    amountDue: toNumberValue(row.amount_residual),
    currency: toRelationName(row.currency_id) || 'MMK',
    state,
    paymentState,
    statusLabel,
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

    const rows = await fetchOdooVendorBills(req.user!.id, {
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
      error instanceof Error ? error.message : 'Failed to load vendor bills.';
    console.error('[vendor-bills]', message);
    return res.status(500).json({ message });
  }
});

export default router;
