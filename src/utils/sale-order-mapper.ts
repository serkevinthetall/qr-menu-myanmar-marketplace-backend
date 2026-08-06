import type {
  OdooSaleOrder,
  OdooSaleOrderDetail,
  OdooSaleOrderLine,
} from '../services/odoo.service.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
  toStudioPhoneNumber,
} from './quotation-mapper.js';

/** Strip HTML from Odoo html/char notes for ERP display. */
function htmlToPlainText(value: string): string {
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Odoo sale.order `note` is often Terms & Conditions HTML — hide that boilerplate
 * so Customer Note only shows real free-text notes.
 */
function toCustomerNote(raw: unknown): string {
  const plain = htmlToPlainText(toStringValue(raw));
  if (!plain) return '';
  const lower = plain.toLowerCase();
  const looksLikeTerms =
    lower.includes('terms') &&
    lower.includes('condition') &&
    (lower.includes('ezytoshop.com/terms') ||
      lower.includes('http://') ||
      lower.includes('https://'));
  if (looksLikeTerms) return '';
  return plain;
}

export function mapSaleOrderSummary(order: OdooSaleOrder) {
  return {
    id: String(order.id),
    number: toStringValue(order.name),
    orderDate: toStringValue(order.date_order),
    customerId: String(toRelationId(order.partner_id) || ''),
    customer: toRelationName(order.partner_id),
    total: toNumberValue(order.amount_total),
    status: toStringValue(order.state),
    salesperson: toRelationName(order.user_id),
    phoneNumber: toStudioPhoneNumber(order),
    // Studio Sale Person Name only — do not fall back to user_id / x_studio_salesperson.
    salePersonName: toStringValue(order.x_studio_sale_person_name),
  };
}

export function mapSaleOrderDetail(input: {
  saleOrder: OdooSaleOrderDetail;
  lines: OdooSaleOrderLine[];
}) {
  const { saleOrder, lines } = input;

  return {
    ...mapSaleOrderSummary(saleOrder),
    untaxedAmount: toNumberValue(saleOrder.amount_untaxed),
    currency: toRelationName(saleOrder.currency_id),
    commitmentDate: toStringValue(saleOrder.commitment_date),
    customerReference: toStringValue(saleOrder.client_order_ref),
    deliveryAddress: toRelationName(saleOrder.partner_shipping_id),
    // Prefer Studio Preferred Delivery Date; fall back to Odoo commitment_date.
    preferredDeliveryDate:
      toStringValue(saleOrder.x_studio_preferred_delivery_date) ||
      toStringValue(saleOrder.commitment_date),
    customerNote: toCustomerNote(saleOrder.note),
    deliveryNotes: toStringValue(saleOrder.x_studio_delivery_notes),
    lines: lines.map(line => ({
      id: String(line.id),
      productId: String(toRelationId(line.product_id) || ''),
      product:
        toRelationName(line.product_id) || toStringValue(line.name) || '—',
      quantity: toNumberValue(line.product_uom_qty),
      unit: 'Units',
      unitPrice: toNumberValue(line.price_unit),
      amount: toNumberValue(line.price_subtotal),
    })),
  };
}
