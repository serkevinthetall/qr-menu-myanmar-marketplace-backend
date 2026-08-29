/**
 * Inventory APIs for accounting: On Hand quantities + Moves History.
 */
import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooOnHandProducts,
  fetchOdooStockMoveLines,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function odooStatus(message: string): number {
  if (/session expired/i.test(message)) return 401;
  return 502;
}

function parseBool(raw: unknown): boolean {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** GET /api/inventory/on-hand?q=&category=&hideZero=&limit=&offset= */
router.get('/on-hand', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : 500;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const q = String(req.query.q ?? '').trim();
    const category = String(req.query.category ?? '').trim();
    const hideZero = parseBool(req.query.hideZero);

    const rows = await fetchOdooOnHandProducts(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
      category: category || undefined,
      hideZero,
    });

    const totalOnHand = rows.reduce((sum, row) => sum + (row.onHand || 0), 0);

    return res.json({
      data: rows.map(row => ({
        id: String(row.id),
        name: row.name,
        sku: row.sku,
        category: row.category,
        onHand: row.onHand,
        unit: row.unit,
      })),
      meta: {
        limit,
        offset,
        count: rows.length,
        totalOnHand,
        hasMore: rows.length >= limit,
        hideZero,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load on-hand quantities.';
    console.error('[inventory/on-hand]', message);
    return res.status(odooStatus(message)).json({ message });
  }
});

/** GET /api/inventory/moves?month=YYYY-MM&q=&limit=&offset= */
router.get('/moves', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : 200;
    const offset =
      Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const month = String(req.query.month ?? '').trim();
    const q = String(req.query.q ?? '').trim();

    const rows = await fetchOdooStockMoveLines(req.user!.id, {
      limit,
      offset,
      month: month || undefined,
      q: q || undefined,
    });

    const totalQuantity = rows.reduce(
      (sum, row) => sum + (Number(row.quantity) || 0),
      0,
    );

    return res.json({
      data: rows.map(row => ({
        id: String(row.id),
        date: row.date,
        reference: row.reference,
        productId: row.productId > 0 ? String(row.productId) : '',
        productName: row.productName,
        category: row.category,
        fromLocation: row.fromLocation,
        toLocation: row.toLocation,
        quantity: row.quantity,
        unit: row.unit,
        state: row.state,
      })),
      meta: {
        limit,
        offset,
        count: rows.length,
        totalQuantity,
        hasMore: rows.length >= limit,
        month: month || null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load stock move history.';
    console.error('[inventory/moves]', message);
    return res.status(odooStatus(message)).json({ message });
  }
});

export default router;
