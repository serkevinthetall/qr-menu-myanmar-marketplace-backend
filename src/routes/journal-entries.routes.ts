import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooJournalEntries,
  journalEntryStateLabel,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

const STATUS_FILTERS = ['draft', 'posted', 'cancel'] as const;

function mapRow(
  row: Awaited<ReturnType<typeof fetchOdooJournalEntries>>[number],
) {
  const state = toStringValue(row.state);
  return {
    id: String(row.id),
    date: toStringValue(row.date),
    number: toStringValue(row.name),
    partnerId: String(toRelationId(row.partner_id) || ''),
    partner: toRelationName(row.partner_id),
    reference: toStringValue(row.ref),
    journal: toRelationName(row.journal_id),
    amountTotal: toNumberValue(row.amount_total),
    currency: toRelationName(row.currency_id) || 'MMK',
    state,
    statusLabel: journalEntryStateLabel(state),
    moveType: toStringValue(row.move_type),
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

    const rows = await fetchOdooJournalEntries(req.user!.id, {
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
        : 'Failed to load journal entries.';
    console.error('[journal-entries]', message);
    return res.status(500).json({ message });
  }
});

export default router;
