import { Router } from 'express';

import { authMiddleware } from '../../middleware/auth.js';
import {
  createOdooQuotation,
  fetchOdooPaymentMethodLines,
  fetchOdooQuotationById,
  fetchOdooQuotationDetailBundle,
  fetchOdooQuotations,
} from '../../services/odoo.service.js';
import { AuthRequest } from '../../types/auth.js';

const router = Router();

function toStringValue(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function toNumberValue(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function toRelationName(value: unknown): string {
  if (Array.isArray(value)) {
    return toStringValue(value[1]);
  }
  if (value && typeof value === 'object' && 'display_name' in value) {
    return toStringValue((value as { display_name: unknown }).display_name);
  }
  return toStringValue(value);
}

function toRelationId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') {
    return value[0];
  }
  return 0;
}

function mapQuotationSummary(quotation: {
  id: number;
  name: string;
  create_date: string | false;
  partner_id: [number, string] | false;
  amount_total: number;
  state: string;
}) {
  return {
    id: String(quotation.id),
    number: quotation.name,
    createDate: toStringValue(quotation.create_date),
    customer: toRelationName(quotation.partner_id),
    total: toNumberValue(quotation.amount_total),
    status: toStringValue(quotation.state),
  };
}

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

    const { quotation, lines, partnerAddress } = bundle;
    const studioPhone = toStringValue(quotation.x_studio_phonenumber);

    return res.json({
      data: {
        ...mapQuotationSummary(quotation),
        customerId: String(toRelationId(quotation.partner_id) || ''),
        paymentMethodLineId: String(
          toRelationId(quotation.preferred_payment_method_line_id) || '',
        ),
        deliveryAddress:
          partnerAddress.formatted ||
          toRelationName(quotation.partner_shipping_id) ||
          toRelationName(quotation.partner_id),
        phoneNumber: studioPhone || partnerAddress.phone,
        preferredDeliveryDate:
          toStringValue(quotation.x_studio_preferred_delivery_date) ||
          toStringValue(quotation.commitment_date),
        deliveryNotes: toStringValue(quotation.x_studio_delivery_notes),
        paymentMethod: toRelationName(quotation.preferred_payment_method_line_id),
        orderDate: toStringValue(quotation.date_order),
        lines: lines.map(line => ({
          id: String(line.id),
          productId: String(toRelationId(line.product_id) || ''),
          product:
            toRelationName(line.product_id) || toStringValue(line.name) || '—',
          quantity: toNumberValue(line.product_uom_qty),
          unit: toRelationName(line.product_uom_id) || 'Units',
          unitPrice: toNumberValue(line.price_unit),
          discountPercent: toNumberValue(line.discount),
          amount: toNumberValue(line.price_subtotal),
        })),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load quotation.';
    console.error('[app/quotations/:id]', message);
    return res.status(500).json({ message });
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
