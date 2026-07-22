import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooPurchaseOrderDetailBundle,
  fetchOdooPurchaseOrders,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  mapPurchaseOrderDetail,
  mapPurchaseOrderSummary,
} from '../utils/purchase-order-mapper.js';

const router = Router();

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();

    const rows = await fetchOdooPurchaseOrders(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
    });
    const data = rows.map(mapPurchaseOrderSummary);

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
        : 'Failed to load purchase orders.';
    console.error('[purchase-orders]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const purchaseOrderId = Number(req.params.id);
  if (!Number.isFinite(purchaseOrderId) || purchaseOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid purchase order id.' });
  }

  try {
    const bundle = await fetchOdooPurchaseOrderDetailBundle(
      req.user!.id,
      purchaseOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'Purchase order not found.' });
    }

    return res.json({
      data: mapPurchaseOrderDetail(bundle),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load purchase order.';
    console.error('[purchase-orders]', message);
    return res.status(500).json({ message });
  }
});

export default router;
