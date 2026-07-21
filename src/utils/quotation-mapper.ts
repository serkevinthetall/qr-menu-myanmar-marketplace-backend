import type {
  OdooOrderLine,
  OdooQuotation,
  OdooQuotationDetail,
} from '../services/odoo.service.js';

export function toStringValue(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function toNumberValue(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function toRelationName(value: unknown): string {
  if (Array.isArray(value)) {
    return toStringValue(value[1]);
  }
  if (value && typeof value === 'object' && 'display_name' in value) {
    return toStringValue((value as { display_name: unknown }).display_name);
  }
  return toStringValue(value);
}

export function toRelationId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') {
    return value[0];
  }
  return 0;
}

export function mapQuotationSummary(quotation: OdooQuotation) {
  return {
    id: String(quotation.id),
    number: quotation.name,
    createDate: toStringValue(quotation.create_date),
    customer: toRelationName(quotation.partner_id),
    total: toNumberValue(quotation.amount_total),
    status: toStringValue(quotation.state),
    paymentMethod: toRelationName(quotation.preferred_payment_method_line_id),
  };
}

/** Full detail payload shared by website and sales-rep app APIs. */
export function mapQuotationDetail(input: {
  quotation: OdooQuotationDetail;
  lines: OdooOrderLine[];
  partnerAddress: { formatted: string; phone: string };
}) {
  const { quotation, lines, partnerAddress } = input;

  const deliveryAddress =
    partnerAddress.formatted ||
    toRelationName(quotation.partner_shipping_id) ||
    toRelationName(quotation.partner_id);

  const studioDeliveryDate = toStringValue(
    quotation.x_studio_preferred_delivery_date,
  );
  const commitmentDate = toStringValue(quotation.commitment_date);
  const paymentMethod = toRelationName(
    quotation.preferred_payment_method_line_id,
  );
  const paymentTerms = toRelationName(quotation.payment_term_id);
  const studioPhone = toStringValue(quotation.x_studio_phonenumber);

  return {
    ...mapQuotationSummary(quotation),
    customerId: String(toRelationId(quotation.partner_id) || ''),
    paymentMethodLineId: String(
      toRelationId(quotation.preferred_payment_method_line_id) || '',
    ),
    deliveryAddress,
    invoiceAddress: toRelationName(quotation.partner_invoice_id),
    expiration: toStringValue(quotation.validity_date),
    orderDate: toStringValue(quotation.date_order),
    untaxedAmount: toNumberValue(quotation.amount_untaxed),
    salesperson: toRelationName(quotation.user_id),
    salePersonName: toStringValue(quotation.x_studio_sale_person_name),
    pricelist: toRelationName(quotation.pricelist_id),
    paymentTerms,
    paymentMethod: paymentMethod || paymentTerms,
    membershipCouponTicket: toStringValue(
      quotation.x_studio_membership_coupon_ticket,
    ),
    membershipCouponStatus: toStringValue(
      quotation.x_studio_membership_coupon_status,
    ),
    phoneNumber: studioPhone || partnerAddress.phone,
    preferredDeliveryDate: studioDeliveryDate || commitmentDate,
    deliveryNotes: toStringValue(quotation.x_studio_delivery_notes),
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
  };
}
