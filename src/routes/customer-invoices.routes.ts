import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  customerInvoicePaymentStateLabel,
  customerInvoiceStateLabel,
  fetchOdooCustomerInvoiceMonthGroups,
  fetchOdooCustomerInvoices,
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

function mapInvoice(
  row: Awaited<ReturnType<typeof fetchOdooCustomerInvoices>>[number],
) {
  const state = toStringValue(row.state);
  const paymentState = toStringValue(row.payment_state);
  const statusLabel =
    state === 'draft' || state === 'cancel'
      ? customerInvoiceStateLabel(state)
      : customerInvoicePaymentStateLabel(paymentState) ||
        customerInvoiceStateLabel(state);

  return {
    id: String(row.id),
    number: toStringValue(row.name),
    customerId: String(toRelationId(row.partner_id) || ''),
    customer: toRelationName(row.partner_id),
    reference: toStringValue(row.ref),
    origin: toStringValue(row.invoice_origin),
    invoiceDate: toStringValue(row.invoice_date),
    dueDate: toStringValue(row.invoice_date_due),
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

router.get('/months', async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const statusRaw = String(req.query.status ?? '').trim();
    const status = STATUS_FILTERS.includes(
      statusRaw as (typeof STATUS_FILTERS)[number],
    )
      ? statusRaw
      : '';

    const months = await fetchOdooCustomerInvoiceMonthGroups(req.user!.id, {
      q,
      status: status || undefined,
    });

    const totals = months.reduce(
      (acc, month) => {
        acc.count += month.count;
        acc.amountUntaxed += month.amountUntaxed;
        acc.amountTotal += month.amountTotal;
        acc.amountDue += month.amountDue;
        return acc;
      },
      { count: 0, amountUntaxed: 0, amountTotal: 0, amountDue: 0 },
    );

    return res.json({
      data: months,
      meta: {
        ...totals,
        currency: 'MMK',
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load customer invoice months.';
    console.error('[customer-invoices/months]', message);
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
    const month = String(req.query.month ?? '').trim();
    const statusRaw = String(req.query.status ?? '').trim();
    const status = STATUS_FILTERS.includes(
      statusRaw as (typeof STATUS_FILTERS)[number],
    )
      ? statusRaw
      : '';

    const rows = await fetchOdooCustomerInvoices(req.user!.id, {
      limit,
      offset,
      q,
      month: month || undefined,
      status: status || undefined,
    });
    const data = rows.map(mapInvoice);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        month: month || null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load customer invoices.';
    console.error('[customer-invoices]', message);
    return res.status(500).json({ message });
  }
});

export default router;
