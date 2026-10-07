import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  chartAccountTypeLabel,
  fetchOdooChartAccounts,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import { toStringValue } from '../utils/quotation-mapper.js';

const router = Router();

const TYPE_FILTERS = [
  'reconcilable',
  'asset_receivable',
  'liability_payable',
  'asset_cash',
  'asset_current',
  'income',
  'expense',
] as const;

function mapRow(
  row: Awaited<ReturnType<typeof fetchOdooChartAccounts>>[number],
) {
  const accountType = toStringValue(row.account_type);
  return {
    id: String(row.id),
    code: toStringValue(row.code),
    name: toStringValue(row.name),
    accountType,
    typeLabel: chartAccountTypeLabel(accountType),
    reconcile: Boolean(row.reconcile),
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
    const filterRaw = String(req.query.filter ?? '').trim();
    const filter = TYPE_FILTERS.includes(
      filterRaw as (typeof TYPE_FILTERS)[number],
    )
      ? filterRaw
      : '';

    const rows = await fetchOdooChartAccounts(req.user!.id, {
      limit,
      offset,
      q,
      filter: filter || undefined,
    });
    const data = rows.map(mapRow);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        reconcilableCount: data.filter(row => row.reconcile).length,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load chart of accounts.';
    console.error('[chart-of-accounts]', message);
    return res.status(500).json({ message });
  }
});

export default router;
