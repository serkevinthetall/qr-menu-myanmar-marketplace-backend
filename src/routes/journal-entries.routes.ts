import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooJournalEntries,
  fetchOdooJournalEntryDetail,
  journalEntryPaymentStateLabel,
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

function taxGridLabel(
  tags: unknown,
  taxTagLabels: Record<number, string>,
): string {
  if (!Array.isArray(tags) || tags.length === 0) return '';
  const labels: string[] = [];
  for (const tag of tags) {
    if (typeof tag === 'number') {
      const label = taxTagLabels[tag];
      if (label) labels.push(label);
    } else if (Array.isArray(tag) && tag.length >= 2) {
      labels.push(String(tag[1]));
    }
  }
  return labels.join(', ');
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

router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const entryId = Number(req.params.id);
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return res.status(400).json({ message: 'Invalid journal entry id.' });
    }

    const bundle = await fetchOdooJournalEntryDetail(req.user!.id, entryId);
    if (!bundle) {
      return res.status(404).json({ message: 'Journal entry not found.' });
    }

    const { entry, lines, taxTagLabels } = bundle;
    const state = toStringValue(entry.state);
    const paymentState = toStringValue(entry.payment_state);
    const debitTotal = lines.reduce(
      (sum, line) => sum + (toNumberValue(line.debit) || 0),
      0,
    );
    const creditTotal = lines.reduce(
      (sum, line) => sum + (toNumberValue(line.credit) || 0),
      0,
    );

    return res.json({
      data: {
        id: String(entry.id),
        date: toStringValue(entry.date),
        number: toStringValue(entry.name),
        partnerId: String(toRelationId(entry.partner_id) || ''),
        partner: toRelationName(entry.partner_id),
        reference: toStringValue(entry.ref),
        origin: toStringValue(entry.invoice_origin),
        journal: toRelationName(entry.journal_id),
        invoiceDate: toStringValue(entry.invoice_date),
        dueDate: toStringValue(entry.invoice_date_due),
        amountUntaxed: toNumberValue(entry.amount_untaxed),
        amountTotal: toNumberValue(entry.amount_total),
        amountDue: toNumberValue(entry.amount_residual),
        currency: toRelationName(entry.currency_id) || 'MMK',
        state,
        statusLabel: journalEntryStateLabel(state),
        paymentState,
        paymentStateLabel: journalEntryPaymentStateLabel(paymentState),
        moveType: toStringValue(entry.move_type),
        debitTotal,
        creditTotal,
        lines: lines.map(line => ({
          id: String(line.id),
          account: toRelationName(line.account_id),
          label: toStringValue(line.name),
          debit: toNumberValue(line.debit),
          credit: toNumberValue(line.credit),
          taxGrids: taxGridLabel(line.tax_tag_ids, taxTagLabels),
        })),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load journal entry detail.';
    console.error('[journal-entries/:id]', message);
    return res.status(500).json({ message });
  }
});

export default router;
