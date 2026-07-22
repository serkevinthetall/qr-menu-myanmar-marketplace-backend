import { Router } from 'express';

import { authMiddleware } from '../../middleware/auth.js';
import {
  cancelOdooQuotation,
  createOdooQuotation,
  fetchOdooPaymentMethodLines,
  fetchOdooQuotationById,
  fetchOdooQuotationDetailBundle,
  fetchOdooQuotations,
} from '../../services/odoo.service.js';
import { AuthRequest } from '../../types/auth.js';
import {
  mapQuotationDetail,
  mapQuotationSummary,
  toNumberValue,
  toStringValue,
} from '../../utils/quotation-mapper.js';

const router = Router();

router.use(authMiddleware);

router.get('/payment-methods', async (req: AuthRequest, res) => {
  try {
    const methods = await fetchOdooPaymentMethodLines(req.user!.id);
    return res.json({
      data: methods.map(method => ({ id: String(method.id), name: method.name })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load payment methods.';
    return res.status(500).json({ message });
  }
});

/** Compact list for handheld: number, status, total, customer. */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const quotations = await fetchOdooQuotations(req.user!.id);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    let data = quotations.map(mapQuotationSummary);
    if (q) {
      data = data.filter(item => {
        const hay = `${item.number} ${item.customer} ${item.status}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load quotations.';
    console.error('[app/quotations]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const quotationId = Number(req.params.id);
  if (!Number.isFinite(quotationId) || quotationId <= 0) {
    return res.status(400).json({ message: 'Invalid quotation id.' });
  }

  try {
    const bundle = await fetchOdooQuotationDetailBundle(req.user!.id, quotationId);
    if (!bundle) {
      return res.status(404).json({ message: 'Quotation not found.' });
    }

    // Same detail payload shape as website /api/quotations/:id
    return res.json({ data: mapQuotationDetail(bundle) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load quotation.';
    console.error('[app/quotations/:id]', message);
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
    const bundle = await fetchOdooQuotationDetailBundle(req.user!.id, quotationId);
    if (!bundle) {
      return res.status(404).json({ message: 'Quotation not found after cancel.' });
    }
    return res.json({ data: mapQuotationDetail(bundle) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to cancel quotation.';
    const status = /only quotations in quotation status/i.test(message)
      ? 409
      : /not found/i.test(message)
        ? 404
        : 500;
    console.error('[app/quotations/:id/cancel]', message);
    return res.status(status).json({ message });
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
  const salePersonName = toStringValue(body.salePersonName).trim();

  if (!preferredDeliveryDate) {
    return res.status(400).json({ message: 'Preferred delivery date is required.' });
  }
  if (!deliveryNote) {
    return res.status(400).json({ message: 'Delivery notes are required.' });
  }
  if (!salePersonName) {
    return res.status(400).json({ message: 'Sale person name is required.' });
  }
  if (!Number.isFinite(paymentMethodLineId) || paymentMethodLineId <= 0) {
    return res.status(400).json({ message: 'Payment method is required.' });
  }
  if (!Number.isFinite(shippingPartnerId) || shippingPartnerId <= 0) {
    return res.status(400).json({ message: 'Delivery location is required.' });
  }

  try {
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
      return { productId, quantity, unitPrice, discountPercent };
    });

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

    const quotation = await fetchOdooQuotationById(req.user!.id, created.id);
    return res.status(201).json({
      data: quotation
        ? mapQuotationSummary(quotation)
        : {
            id: String(created.id),
            number: created.name,
            createDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
            customer: '',
            total: 0,
            status: 'draft',
            paymentMethod: '',
          },
    });
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : 'Failed to save quotation.';
    const message = /access denied/i.test(rawMessage)
      ? 'Access denied in Odoo. Your user needs permission to create quotations.'
      : rawMessage;
    console.error('[app/quotations] create:', rawMessage);
    return res.status(500).json({ message });
  }
});

export default router;
