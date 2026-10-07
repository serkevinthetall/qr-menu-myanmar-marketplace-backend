import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import { fetchOdooReconcileItems } from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

function mapRow(
  row: Awaited<ReturnType<typeof fetchOdooReconcileItems>>[number],
) {
  return {
    id: String(row.id),
    date: toStringValue(row.date),
    name: toStringValue(row.name),
    journal: toRelationName(row.journal_id),
    journalEntryId: String(toRelationId(row.move_id) || ''),
    journalEntry: toRelationName(row.move_id),
    accountId: String(toRelationId(row.account_id) || ''),
    account: toRelationName(row.account_id),
    partnerId: String(toRelationId(row.partner_id) || ''),
    partner: toRelationName(row.partner_id),
    reference: toStringValue(row.ref),
    product: toRelationName(row.product_id),
    debit: toNumberValue(row.debit),
    credit: toNumberValue(row.credit),
    residual: toNumberValue(row.amount_residual),
    dueDate: toStringValue(row.date_maturity),
    currency: toRelationName(row.currency_id) || 'MMK',
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

    const rows = await fetchOdooReconcileItems(req.user!.id, {
      limit,
      offset,
      q,
    });
    const data = rows.map(mapRow);
    const residualTotal = data.reduce(
      (sum, row) => sum + (Number(row.residual) || 0),
      0,
    );

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        residualTotal,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load journal items to reconcile.';
    console.error('[reconcile]', message);
    return res.status(500).json({ message });
  }
});

export default router;
