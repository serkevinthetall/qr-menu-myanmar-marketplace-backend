/**
 * App Promoter Commission list from Odoo (x_app_promoter_commiss).
 */
import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import { fetchOdooAppPromoterCommissions } from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function mapCommission(row: {
  id: number;
  title: string;
  date: string;
  promoterId: number;
  promoterName: string;
  customerId: number;
  customerName: string;
  amount: number;
  updatedAt: string | null;
  saleOrderId: number;
  saleOrderName: string;
}) {
  return {
    id: String(row.id),
    title: row.title,
    date: row.date,
    promoterId: row.promoterId > 0 ? String(row.promoterId) : '',
    promoterName: row.promoterName,
    customerId: row.customerId > 0 ? String(row.customerId) : '',
    customerName: row.customerName,
    amount: row.amount,
    updatedAt: row.updatedAt,
    saleOrderId: row.saleOrderId > 0 ? String(row.saleOrderId) : '',
    saleOrderName: row.saleOrderName,
  };
}

function odooStatus(message: string): number {
  if (/session expired/i.test(message)) return 401;
  return 502;
}

/** ?month=YYYY-MM&promoterId=&q= */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const promoterIdRaw = Number(req.query.promoterId);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 500;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const month = String(req.query.month ?? '').trim();
    const q = String(req.query.q ?? '').trim();
    const promoterId =
      Number.isFinite(promoterIdRaw) && promoterIdRaw > 0
        ? promoterIdRaw
        : undefined;

    const rows = await fetchOdooAppPromoterCommissions(req.user!.id, {
      limit,
      offset,
      month: month || undefined,
      promoterId,
      q: q || undefined,
    });

    const data = rows.map(mapCommission);
    const totalAmount = data.reduce(
      (sum, row) => sum + (Number.isFinite(row.amount) ? row.amount : 0),
      0,
    );

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        totalAmount,
        hasMore: data.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load App Promoter commissions.';
    console.error('[app-promoter-commissions]', message);
    return res.status(odooStatus(message)).json({ message });
  }
});

export default router;
