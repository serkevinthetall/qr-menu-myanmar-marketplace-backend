import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { createOdooQuotation, fetchOdooPaymentMethodLines, fetchOdooQuotationById, fetchOdooQuotationDetailBundle, fetchOdooQuotations, } from '../services/odoo.service.js';
const router = Router();
function toStringValue(value) {
    if (value === false || value === null || value === undefined) {
        return '';
    }
    return String(value);
}
function toNumberValue(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}
function toRelationName(value) {
    if (Array.isArray(value)) {
        return toStringValue(value[1]);
    }
    if (value && typeof value === 'object' && 'display_name' in value) {
        return toStringValue(value.display_name);
    }
    return toStringValue(value);
}
function toRelationId(value) {
    if (Array.isArray(value) && typeof value[0] === 'number') {
        return value[0];
    }
    return 0;
}
function mapQuotationSummary(quotation) {
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
router.use(authMiddleware);
router.get('/payment-methods', async (req, res) => {
    try {
        const methods = await fetchOdooPaymentMethodLines(req.user.id);
        const data = methods.map(method => ({
            id: String(method.id),
            name: method.name,
        }));
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load payment methods.';
        console.error('[quotations] Failed to load payment methods:', message);
        return res.status(500).json({ message });
    }
});
router.get('/', async (req, res) => {
    try {
        const [quotations, paymentMethods] = await Promise.all([
            fetchOdooQuotations(req.user.id),
            fetchOdooPaymentMethodLines(req.user.id),
        ]);
        const paymentMethodById = new Map(paymentMethods.map(method => [method.id, method.name]));
        const data = quotations.map(quotation => {
            const lineId = toRelationId(quotation.preferred_payment_method_line_id);
            const paymentMethod = (lineId > 0 ? paymentMethodById.get(lineId) : '') ||
                toRelationName(quotation.preferred_payment_method_line_id);
            return {
                ...mapQuotationSummary(quotation),
                paymentMethod,
            };
        });
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load quotations.';
        console.error('[quotations] Failed to load quotations:', message);
        return res.status(500).json({ message });
    }
});
router.post('/', async (req, res) => {
    const body = req.body;
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
        const created = await createOdooQuotation(req.user.id, {
            partnerId,
            shippingPartnerId,
            salePersonName,
            deliveryNotes: deliveryNote,
            preferredDeliveryDate,
            phoneNumber: toStringValue(body.phoneNumber),
            paymentMethodLineId,
            lines: parsedLines,
        }, req.odooSession);
        const quotation = await fetchOdooQuotationById(req.user.id, created.id);
        if (!quotation) {
            return res.status(201).json({
                data: {
                    id: String(created.id),
                    number: created.name,
                    createDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
                    customer: '',
                    total: 0,
                    status: 'draft',
                },
            });
        }
        return res.status(201).json({ data: mapQuotationSummary(quotation) });
    }
    catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Failed to save quotation.';
        const message = /access denied/i.test(rawMessage)
            ? 'Access denied in Odoo. Your user needs permission to create quotations (Sales Orders).'
            : rawMessage;
        console.error('[quotations] Failed to create quotation:', rawMessage);
        return res.status(500).json({ message });
    }
});
router.get('/:id', async (req, res) => {
    const quotationId = Number(req.params.id);
    if (!Number.isFinite(quotationId) || quotationId <= 0) {
        return res.status(400).json({ message: 'Invalid quotation id.' });
    }
    try {
        const bundle = await fetchOdooQuotationDetailBundle(req.user.id, quotationId);
        if (!bundle) {
            return res.status(404).json({ message: 'Quotation not found.' });
        }
        const { quotation, lines, partnerAddress } = bundle;
        const deliveryAddress = partnerAddress.formatted ||
            toRelationName(quotation.partner_shipping_id) ||
            toRelationName(quotation.partner_id);
        const studioDeliveryDate = toStringValue(quotation.x_studio_preferred_delivery_date);
        const commitmentDate = toStringValue(quotation.commitment_date);
        const paymentMethod = toRelationName(quotation.preferred_payment_method_line_id);
        const paymentTerms = toRelationName(quotation.payment_term_id);
        const studioPhone = toStringValue(quotation.x_studio_phonenumber);
        const data = {
            ...mapQuotationSummary(quotation),
            customerId: String(toRelationId(quotation.partner_id) || ''),
            paymentMethodLineId: String(toRelationId(quotation.preferred_payment_method_line_id) || ''),
            deliveryAddress,
            invoiceAddress: toRelationName(quotation.partner_invoice_id),
            expiration: toStringValue(quotation.validity_date),
            orderDate: toStringValue(quotation.date_order),
            untaxedAmount: toNumberValue(quotation.amount_untaxed),
            salesperson: toRelationName(quotation.user_id),
            pricelist: toRelationName(quotation.pricelist_id),
            paymentTerms,
            paymentMethod: paymentMethod || paymentTerms,
            membershipCouponTicket: toStringValue(quotation.x_studio_membership_coupon_ticket),
            membershipCouponStatus: toStringValue(quotation.x_studio_membership_coupon_status),
            phoneNumber: studioPhone || partnerAddress.phone,
            preferredDeliveryDate: studioDeliveryDate || commitmentDate,
            deliveryNotes: toStringValue(quotation.x_studio_delivery_notes),
            lines: lines.map(line => ({
                id: String(line.id),
                productId: String(toRelationId(line.product_id) || ''),
                product: toRelationName(line.product_id) || toStringValue(line.name) || '—',
                quantity: toNumberValue(line.product_uom_qty),
                unit: toRelationName(line.product_uom_id) || 'Units',
                unitPrice: toNumberValue(line.price_unit),
                discountPercent: toNumberValue(line.discount),
                amount: toNumberValue(line.price_subtotal),
            })),
        };
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load quotation.';
        console.error('[quotations] Failed to load quotation detail:', message);
        return res.status(500).json({ message });
    }
});
export default router;
