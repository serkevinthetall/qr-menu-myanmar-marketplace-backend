import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  listReadAppOrderIds,
  setAppOrderRead,
} from '../services/app-order-read.store.js';
import {
  fetchOdooOnlineOrderDetailBundle,
  fetchOdooOnlineOrders,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  mapSaleOrderDetail,
  mapSaleOrderSummary,
} from '../utils/sale-order-mapper.js';

const router = Router();

router.use(authMiddleware);

router.get('/unread-count', async (req: AuthRequest, res) => {
  try {
    const rows = await fetchOdooOnlineOrders(req.user!.id, {
      limit: 500,
      offset: 0,
    });
    const readIds = await listReadAppOrderIds();
    const unreadCount = rows.reduce(
      (count, row) => count + (readIds.has(row.id) ? 0 : 1),
      0,
    );
    return res.json({ data: { unreadCount } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load unread count.';
    console.error('[online-orders] unread-count', message);
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
    const readFilterRaw = String(req.query.read ?? '').trim().toLowerCase();
    const readFilter =
      readFilterRaw === 'read' || readFilterRaw === 'unread'
        ? readFilterRaw
        : undefined;

    const rows = await fetchOdooOnlineOrders(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
    });
    const readIds = await listReadAppOrderIds();

    let data = rows.map(row => {
      const summary = mapSaleOrderSummary(row);
      const unread = !readIds.has(row.id);
      return { ...summary, unread };
    });

    if (readFilter === 'read') {
      data = data.filter(row => !row.unread);
    } else if (readFilter === 'unread') {
      data = data.filter(row => row.unread);
    }

    const unreadCount = rows.reduce(
      (count, row) => count + (readIds.has(row.id) ? 0 : 1),
      0,
    );

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        unreadCount,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load app orders.';
    console.error('[online-orders]', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id/read', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  const read = Boolean(req.body?.read);
  try {
    // Ensure order is a valid App Order before mutating shared state.
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    await setAppOrderRead(saleOrderId, read);
    return res.json({
      data: { id: String(saleOrderId), unread: !read },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update read state.';
    console.error('[online-orders] read', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    // Opening detail marks the order read for the whole team.
    await setAppOrderRead(saleOrderId, true);
    const detail = mapSaleOrderDetail(bundle);

    return res.json({
      data: { ...detail, unread: false },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load app order.';
    console.error('[online-orders]', message);
    return res.status(500).json({ message });
  }
});

export default router;
