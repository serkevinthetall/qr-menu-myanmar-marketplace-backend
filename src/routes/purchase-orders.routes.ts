import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  createOdooPurchaseOrder,
  fetchOdooPurchaseOrderDetailBundle,
  fetchOdooPurchaseOrders,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  mapPurchaseOrderDetail,
  mapPurchaseOrderSummary,
} from '../utils/purchase-order-mapper.js';
import { toNumberValue, toStringValue } from '../utils/quotation-mapper.js';

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

/**
 * Create a Purchase RFQ (optionally confirm to Purchase Order).
 * Body: { partnerId, dateOrder?, datePlanned?, partnerRef?, confirm?, lines: [{ productId, quantity, unitPrice }] }
 */
router.post('/', async (req: AuthRequest, res) => {
  const body = req.body ?? {};
  const partnerId = Number(body.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return res.status(400).json({ message: 'A valid vendor is required.' });
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    return res
      .status(400)
      .json({ message: 'Add at least one product before saving.' });
  }

  let parsedLines;
  try {
    parsedLines = rawLines.map((line: Record<string, unknown>, index: number) => {
      const productId = Number(line.productId);
      const quantity = toNumberValue(line.quantity);
      const unitPrice = toNumberValue(line.unitPrice);
      if (!Number.isFinite(productId) || productId <= 0) {
        throw new Error(`Line ${index + 1} is missing a valid product.`);
      }
      if (quantity <= 0) {
        throw new Error(`Line ${index + 1} must have a quantity greater than zero.`);
      }
      return { productId, quantity, unitPrice };
    });
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Invalid order lines.',
    });
  }

  try {
    const created = await createOdooPurchaseOrder(req.user!.id, {
      partnerId,
      dateOrder: toStringValue(body.dateOrder) || undefined,
      datePlanned: toStringValue(body.datePlanned) || undefined,
      partnerRef: toStringValue(body.partnerRef) || undefined,
      confirm: Boolean(body.confirm),
      lines: parsedLines,
    });

    const total = parsedLines.reduce(
      (sum: number, line: { quantity: number; unitPrice: number }) =>
        sum + line.quantity * line.unitPrice,
      0,
    );

    return res.status(201).json({
      data: {
        id: String(created.id),
        number: created.name,
        orderDate: toStringValue(body.dateOrder) || new Date().toISOString(),
        vendorId: String(partnerId),
        vendor: '',
        total,
        status: created.state,
        buyer: '',
      },
    });
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : 'Failed to create purchase order.';
    const message = /access denied/i.test(rawMessage)
      ? 'Access denied in Odoo. Your user needs permission to create purchase orders.'
      : rawMessage;
    console.error('[purchase-orders] create', rawMessage);
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
