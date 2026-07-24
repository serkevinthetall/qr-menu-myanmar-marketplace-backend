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
} from './quotation-mapper.js';

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
