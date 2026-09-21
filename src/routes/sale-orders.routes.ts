import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  createOdooSaleOrderInvoice,
  enrichSaleOrderActionFlags,
  fetchOdooDeliveryPreviewsForOrder,
  fetchOdooInvoicePreviewsForOrder,
  fetchOdooSaleOrderDetailBundle,
  fetchOdooSaleOrders,
  fetchSaleOrderIdsWithValidatableDelivery,
  payOdooSaleOrderInvoice,
  validateOdooSaleOrderDelivery,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  mapSaleOrderDetail,
  mapSaleOrderSummary,
} from '../utils/sale-order-mapper.js';

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
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();

    const rows = await fetchOdooSaleOrders(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
      from: from || undefined,
      to: to || undefined,
    });
    // Opt-in: stock.picking enrichment is slow (~seconds). Only when list
    // selection / bulk validate is enabled (includeValidate=1).
    const includeValidateRaw = String(req.query.includeValidate ?? '')
      .trim()
      .toLowerCase();
    const includeValidate =
      includeValidateRaw === '1' || includeValidateRaw === 'true';
    const validatableIds = includeValidate
      ? await fetchSaleOrderIdsWithValidatableDelivery(
          req.user!.id,
          rows.map(row => row.id),
        )
      : new Set<number>();
    const data = rows.map(row => ({
      ...mapSaleOrderSummary(row),
      canValidateDelivery: validatableIds.has(row.id),
    }));

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
      error instanceof Error ? error.message : 'Failed to load sale orders.';
    console.error('[sale-orders]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid sale order id.' });
  }

  try {
    const bundle = await fetchOdooSaleOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'Sale order not found.' });
    }

    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      bundle.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load sale order.';
    console.error('[sale-orders]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id/deliveries', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid sale order id.' });
  }

  try {
    const data = await fetchOdooDeliveryPreviewsForOrder(
      req.user!.id,
      saleOrderId,
    );
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load delivery preview.';
    console.error('[sale-orders] deliveries', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id/invoices', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid sale order id.' });
  }

  try {
    const data = await fetchOdooInvoicePreviewsForOrder(
      req.user!.id,
      saleOrderId,
    );
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load invoices.';
    console.error('[sale-orders] invoices', message);
    return res.status(500).json({ message });
  }
});

router.post('/:id/validate-delivery', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid sale order id.' });
  }

  try {
    const pickingIdRaw = Number(
      (req.body as { pickingId?: string | number } | undefined)?.pickingId,
    );
    const pickingId =
      Number.isFinite(pickingIdRaw) && pickingIdRaw > 0
        ? pickingIdRaw
        : undefined;
    const result = await validateOdooSaleOrderDelivery(
      req.user!.id,
      saleOrderId,
      pickingId ? { pickingId } : undefined,
    );
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      result.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(result),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to validate delivery.';
    const status =
      /already validated|no delivery is ready|only confirmed sales orders/i.test(
        message,
      )
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[sale-orders] validate-delivery', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/create-invoice', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid sale order id.' });
  }

  try {
    const result = await createOdooSaleOrderInvoice(req.user!.id, saleOrderId);
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      result.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(result),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
        invoiceName: result.invoiceName,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create invoice.';
    const status =
      /already fully invoiced|not ready to invoice|nothing to invoice|only confirmed sales orders/i.test(
        message,
      )
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[sale-orders] create-invoice', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/pay', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid sale order id.' });
  }

  const paymentMethodLineIdRaw = Number(
    (req.body as { paymentMethodLineId?: unknown })?.paymentMethodLineId,
  );
  const paymentMethodLineId =
    Number.isFinite(paymentMethodLineIdRaw) && paymentMethodLineIdRaw > 0
      ? paymentMethodLineIdRaw
      : undefined;

  try {
    const result = await payOdooSaleOrderInvoice(req.user!.id, saleOrderId, {
      paymentMethodLineId,
    });
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      result.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(result),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
        invoiceName: result.invoiceName,
        paymentLabel: result.paymentLabel,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to register payment.';
    const status =
      /no unpaid invoice|only confirmed sales orders/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[sale-orders] pay', message);
    return res.status(status).json({ message });
  }
});

export default router;
