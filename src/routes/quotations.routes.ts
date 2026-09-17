import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  cancelOdooQuotation,
  confirmOdooQuotation,
  createOdooQuotation,
  createOdooSaleOrderInvoice,
  enrichSaleOrderActionFlags,
  fetchOdooDeliveryPreviewsForOrder,
  fetchOdooPaymentMethodLines,
  fetchOdooQuotationDetailBundle,
  fetchOdooQuotations,
  payOdooSaleOrderInvoice,
  validateOdooSaleOrderDelivery,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import { httpStatusForCaughtError } from '../utils/odoo-session-error.js';
import {
  mapQuotationDetail,
  mapQuotationSummary,
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

router.use(authMiddleware);

router.get('/payment-methods', async (req: AuthRequest, res) => {
  try {
    const methods = await fetchOdooPaymentMethodLines(req.user!.id);
    const data = methods.map(method => ({
      id: String(method.id),
      name: method.name,
    }));
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load payment methods.';
    console.error('[quotations] Failed to load payment methods:', message);
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

    const [quotations, paymentMethods] = await Promise.all([
      fetchOdooQuotations(req.user!.id, { limit, offset }),
      fetchOdooPaymentMethodLines(req.user!.id),
    ]);

    const paymentMethodById = new Map(
      paymentMethods.map(method => [method.id, method.name]),
    );

    const data = quotations.map(quotation => {
      const lineId = toRelationId(quotation.preferred_payment_method_line_id);
      const paymentMethod =
        (lineId > 0 ? paymentMethodById.get(lineId) : '') ||
        toRelationName(quotation.preferred_payment_method_line_id);

      return {
        ...mapQuotationSummary(quotation),
        paymentMethod,
      };
    });

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: quotations.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load quotations.';
    console.error('[quotations] Failed to load quotations:', message);
    return res.status(httpStatusForCaughtError(error)).json({ message });
  }
});

router.post('/', async (req: AuthRequest, res) => {
  const body = req.body as {
    customerId?: string;
    shippingPartnerId?: string;
    salePersonName?: string;
    deliveryNote?: string;
    preferredDeliveryDate?: string;
    phoneNumber?: string;
    paymentMethodLineId?: string;
    lines?: {
      productId?: string;
      quantity?: number;
      unitPrice?: number;
      discountPercent?: number;
    }[];
  };

  const partnerId = Number(body.customerId);
  const shippingPartnerId = Number(body.shippingPartnerId);
  const paymentMethodLineId = Number(body.paymentMethodLineId);
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return res.status(400).json({ message: 'A valid customer is required.' });
  }

  if (lines.length === 0) {
    return res.status(400).json({ message: 'Add at least one product before saving.' });
  }

  const preferredDeliveryDate = toStringValue(body.preferredDeliveryDate).trim();
  const deliveryNote = toStringValue(body.deliveryNote).trim();

  if (!preferredDeliveryDate) {
    return res.status(400).json({ message: 'Preferred delivery date is required.' });
  }

  if (!deliveryNote) {
    return res.status(400).json({ message: 'Delivery notes are required.' });
  }

  const salePersonName = toStringValue(body.salePersonName).trim();
  if (!salePersonName) {
    return res.status(400).json({ message: 'Sale person name is required.' });
  }

  if (!Number.isFinite(paymentMethodLineId) || paymentMethodLineId <= 0) {
    return res.status(400).json({ message: 'Payment method is required.' });
  }

  if (!Number.isFinite(shippingPartnerId) || shippingPartnerId <= 0) {
    return res.status(400).json({ message: 'Delivery location is required.' });
  }

  const parsedLines = lines.map((line, index) => {
    const productId = Number(line.productId);
    const quantity = toNumberValue(line.quantity);
    const unitPrice = toNumberValue(line.unitPrice);
    const discountPercent = toNumberValue(line.discountPercent);

    if (!Number.isFinite(productId) || productId <= 0) {
      throw new Error(`Line ${index + 1} is missing a valid product.`);
    }
    if (quantity <= 0) {
      throw new Error(`Line ${index + 1} must have a quantity greater than zero.`);
    }

    return {
      productId,
      quantity,
      unitPrice,
      discountPercent,
    };
  });

  try {
    const created = await createOdooQuotation(
      req.user!.id,
      {
        partnerId,
        shippingPartnerId,
        salePersonName,
        deliveryNotes: deliveryNote,
        preferredDeliveryDate,
        phoneNumber: toStringValue(body.phoneNumber),
        paymentMethodLineId,
        lines: parsedLines,
      },
      req.odooSession,
    );

    // Avoid a second Odoo read after create — return enough for the list UI.
    // The quotations list reloads in the background with full Odoo data.
    const total = parsedLines.reduce((sum, line) => {
      const base = line.quantity * line.unitPrice;
      const discount = Math.min(Math.max(line.discountPercent, 0), 100);
      return sum + base * (1 - discount / 100);
    }, 0);

    return res.status(201).json({
      data: {
        id: String(created.id),
        number: created.name,
        createDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
        customer: '',
        total,
        status: 'draft',
        paymentMethod: '',
        phoneNumber: toStringValue(body.phoneNumber),
        salePersonName,
      },
    });
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : 'Failed to save quotation.';
    const message = /access denied/i.test(rawMessage)
      ? 'Access denied in Odoo. Your user needs permission to create quotations (Sales Orders).'
      : rawMessage;
    console.error('[quotations] Failed to create quotation:', rawMessage);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    const bundle = await fetchOdooQuotationDetailBundle(
      req.user!.id,
      quotationId,
    );

    if (!bundle) {
      return res.status(404).json({ message: 'Quotation not found.' });
    }

    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      quotationId,
      bundle.quotation,
    );
    return res.json({
      data: {
        ...mapQuotationDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load quotation.';
    console.error('[quotations] Failed to load quotation detail:', message);
    return res.status(500).json({ message });
  }
});

router.post('/:id/cancel', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    await cancelOdooQuotation(req.user!.id, quotationId);
    const bundle = await fetchOdooQuotationDetailBundle(
      req.user!.id,
      quotationId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'Quotation not found after cancel.' });
    }
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      quotationId,
      bundle.quotation,
    );
    return res.json({
      data: {
        ...mapQuotationDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to cancel quotation.';
    const status = /only quotations in quotation status/i.test(message)
      ? 409
      : /not found/i.test(message)
        ? 404
        : 500;
    console.error('[quotations] Failed to cancel quotation:', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/confirm', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    await confirmOdooQuotation(req.user!.id, quotationId);
    const bundle = await fetchOdooQuotationDetailBundle(
      req.user!.id,
      quotationId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'Quotation not found after confirm.' });
    }
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      quotationId,
      bundle.quotation,
    );
    return res.json({
      data: {
        ...mapQuotationDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to confirm quotation.';
    const status =
      /only quotations in quotation or quotation sent status/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[quotations] Failed to confirm quotation:', message);
    return res.status(status).json({ message });
  }
});

router.get('/:id/deliveries', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    const data = await fetchOdooDeliveryPreviewsForOrder(
      req.user!.id,
      quotationId,
    );
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load delivery preview.';
    console.error('[quotations] Failed to load deliveries:', message);
    return res.status(500).json({ message });
  }
});

router.post('/:id/validate-delivery', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    await validateOdooSaleOrderDelivery(req.user!.id, quotationId);
    const bundle = await fetchOdooQuotationDetailBundle(
      req.user!.id,
      quotationId,
    );
    if (!bundle) {
      return res.status(404).json({
        message: 'Quotation not found after delivery validate.',
      });
    }
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      quotationId,
      bundle.quotation,
    );
    return res.json({
      data: {
        ...mapQuotationDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
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
    console.error('[quotations] Failed to validate delivery:', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/create-invoice', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    const result = await createOdooSaleOrderInvoice(req.user!.id, quotationId);
    const bundle = await fetchOdooQuotationDetailBundle(
      req.user!.id,
      quotationId,
    );
    if (!bundle) {
      return res.status(404).json({
        message: 'Quotation not found after invoice create.',
      });
    }
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      quotationId,
      bundle.quotation,
    );
    return res.json({
      data: {
        ...mapQuotationDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
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
    console.error('[quotations] Failed to create invoice:', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/pay', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);

  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  const paymentMethodLineIdRaw = Number(
    (req.body as { paymentMethodLineId?: unknown })?.paymentMethodLineId,
  );
  const paymentMethodLineId =
    Number.isFinite(paymentMethodLineIdRaw) && paymentMethodLineIdRaw > 0
      ? paymentMethodLineIdRaw
      : undefined;

  try {
    const result = await payOdooSaleOrderInvoice(req.user!.id, quotationId, {
      paymentMethodLineId,
    });
    const bundle = await fetchOdooQuotationDetailBundle(
      req.user!.id,
      quotationId,
    );
    if (!bundle) {
      return res.status(404).json({
        message: 'Quotation not found after payment.',
      });
    }
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      quotationId,
      bundle.quotation,
    );
    return res.json({
      data: {
        ...mapQuotationDetail(bundle),
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
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
    console.error('[quotations] Failed to register payment:', message);
    return res.status(status).json({ message });
  }
});

export default router;
