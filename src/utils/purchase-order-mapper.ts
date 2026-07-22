import type {
  OdooPurchaseOrder,
  OdooPurchaseOrderDetail,
  OdooPurchaseOrderLine,
} from '../services/odoo.service.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from './quotation-mapper.js';

export function mapPurchaseOrderSummary(order: OdooPurchaseOrder) {
  return {
    id: String(order.id),
    number: toStringValue(order.name),
    orderDate: toStringValue(order.date_order),
    vendorId: String(toRelationId(order.partner_id) || ''),
    vendor: toRelationName(order.partner_id),
    total: toNumberValue(order.amount_total),
    status: toStringValue(order.state),
    buyer: toRelationName(order.user_id),
  };
}

export function mapPurchaseOrderDetail(input: {
  purchaseOrder: OdooPurchaseOrderDetail;
  lines: OdooPurchaseOrderLine[];
}) {
  const { purchaseOrder, lines } = input;

  return {
    ...mapPurchaseOrderSummary(purchaseOrder),
    untaxedAmount: toNumberValue(purchaseOrder.amount_untaxed),
    currency: toRelationName(purchaseOrder.currency_id),
    scheduledDate: toStringValue(purchaseOrder.date_planned),
    origin: toStringValue(purchaseOrder.origin),
    lines: lines.map(line => ({
      id: String(line.id),
      productId: String(toRelationId(line.product_id) || ''),
      product:
        toRelationName(line.product_id) || toStringValue(line.name) || '—',
      quantity: toNumberValue(line.product_qty),
      unit: toRelationName(line.product_uom) || 'Units',
      unitPrice: toNumberValue(line.price_unit),
      amount: toNumberValue(line.price_subtotal),
    })),
  };
}
