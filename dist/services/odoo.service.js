import { env } from '../config/env.js';
import { lastPhoneDigits, normalizeMyanmarPhone, } from '../utils/myanmar-phone.js';
import { deleteOdooSession, getOdooSession, setOdooSession, } from './odoo-session.store.js';
/** Standard res.partner fields fetched for the Contact module. */
const CONTACT_BASE_FIELDS = [
    'id',
    'name',
    'email',
    'phone',
    'city',
    'function',
    'is_company',
    'parent_id',
];
/** res.partner field linking to the custom Township model. */
export const PARTNER_TOWNSHIP_FIELD = 'x_studio_many2one_field_8u9_1jp4l7r0g';
const TOWNSHIP_FIELDS = [
    'x_name',
    'x_studio_state_link',
    'x_studio_postal_code',
    'x_studio_country_link',
];
/**
 * Custom Odoo Studio fields on res.partner. Technical name -> app key.
 * Add new fields here as they are created in Odoo.
 */
export const CONTACT_CUSTOM_FIELDS = {
    x_studio_monthly_activity: 'activity',
    x_studio_many2one_field_8u9_1jp4l7r0g: 'township',
    x_studio_customer_status: 'status',
    x_studio_last_month_sales: 'lastMonthSales',
    x_studio_this_month_sales: 'thisMonthSales',
    x_studio_this_month_percent: 'thisMonthPercent',
    x_studio_last_invoice_date: 'lastInvoiceDate',
    x_studio_expo_push_token: 'expoPushToken',
};
/** Fields fetched for the contact detail view. */
const CONTACT_DETAIL_FIELDS = [
    'name',
    'parent_id',
    'email',
    'phone',
    'street',
    'street2',
    'city',
    'state_id',
    'zip',
    'country_id',
    'category_id',
    'x_studio_member_code',
    PARTNER_TOWNSHIP_FIELD,
];
/** Extra ad-hoc fields configured via env, appended as raw strings. */
const CONTACT_EXTRA_FIELDS = env.odooContactExtraFields;
function extractSessionCookie(setCookieHeaders) {
    for (const header of setCookieHeaders) {
        const match = header.match(/session_id=([^;]+)/);
        if (match?.[1]) {
            return `session_id=${match[1]}`;
        }
    }
    return '';
}
export async function authenticateWithOdoo(login, password) {
    const response = await fetch(`${env.odooUrl}/web/session/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: {
                db: env.odooDb,
                login,
                password,
            },
            id: Date.now(),
        }),
    });
    const setCookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    const data = (await response.json());
    if (data.error) {
        throw new Error('Invalid email or password.');
    }
    const result = data.result;
    if (!result?.uid) {
        throw new Error('Invalid email or password.');
    }
    const cookie = extractSessionCookie(setCookie);
    if (!cookie) {
        throw new Error('Could not establish Odoo session.');
    }
    const userId = String(result.uid);
    setOdooSession(userId, {
        cookie,
        uid: result.uid,
        login,
        createdAt: Date.now(),
    });
    return {
        uid: result.uid,
        name: result.name || result.partner_display_name || login,
        email: result.username || login,
        cookie,
    };
}
export async function destroyOdooSession(userId, sessionOverride) {
    const session = sessionOverride ?? getOdooSession(userId);
    if (session) {
        try {
            await fetch(`${env.odooUrl}/web/session/destroy`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: session.cookie,
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'call',
                    params: {},
                    id: Date.now(),
                }),
            });
        }
        catch {
            // Ignore destroy errors — local session will still be cleared.
        }
    }
    deleteOdooSession(userId);
}
export async function fetchOdooProducts(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: session.cookie,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: {
                model: 'product.product',
                method: 'search_read',
                args: [
                    [],
                    [
                        'id',
                        'name',
                        'default_code',
                        'list_price',
                        'active',
                        'categ_id',
                        'uom_id',
                    ],
                ],
                kwargs: {
                    order: 'name asc',
                    // Avoid image_128 (huge payload) and qty_available (slow computed field).
                    limit: 500,
                },
            },
            id: Date.now(),
        }),
    });
    const data = (await response.json());
    if (data.error) {
        const message = data.error.data?.message ?? data.error.message ?? 'Failed to load products.';
        throw new Error(message);
    }
    return data.result ?? [];
}
const PARTNER_ADDRESS_FIELDS = [
    'street',
    'street2',
    'city',
    'zip',
    'phone',
    'state_id',
    'country_id',
    PARTNER_TOWNSHIP_FIELD,
];
const QUOTATION_LIST_FIELDS = [
    'id',
    'name',
    'create_date',
    'partner_id',
    'amount_total',
    'state',
    'preferred_payment_method_line_id',
];
const QUOTATION_DETAIL_FIELDS = [
    ...QUOTATION_LIST_FIELDS,
    'partner_shipping_id',
    'partner_invoice_id',
    'validity_date',
    'date_order',
    'amount_untaxed',
    'user_id',
    'pricelist_id',
    'payment_term_id',
    'preferred_payment_method_line_id',
    'x_studio_membership_coupon_ticket',
    'x_studio_membership_coupon_status',
    'x_studio_phonenumber',
    'x_studio_preferred_delivery_date',
    'x_studio_delivery_notes',
    'commitment_date',
];
const ORDER_LINE_FIELDS = [
    'id',
    'name',
    'product_id',
    'product_uom_qty',
    'product_uom_id',
    'price_unit',
    'discount',
    'price_subtotal',
];
async function odooCallKw(cookie, model, method, args = [], kwargs = {}) {
    const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: { model, method, args, kwargs },
            id: Date.now(),
        }),
    });
    const data = (await response.json());
    if (data.error) {
        const message = data.error.data?.message ?? data.error.message ?? 'Odoo request failed.';
        throw new Error(message);
    }
    return data.result;
}
async function odooExecuteKw(uid, model, method, args = [], kwargs = {}) {
    if (!env.odooApiKey) {
        throw new Error('ODOO_API_KEY is not configured.');
    }
    const response = await fetch(`${env.odooUrl}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: {
                service: 'object',
                method: 'execute_kw',
                args: [env.odooDb, uid, env.odooApiKey, model, method, args, kwargs],
            },
            id: Date.now(),
        }),
    });
    const data = (await response.json());
    if (data.error) {
        const message = data.error.data?.message ?? data.error.message ?? 'Odoo request failed.';
        throw new Error(message);
    }
    return data.result;
}
async function readOdooRecord(session, model, recordId, fields) {
    if (env.odooApiKey) {
        try {
            const rows = await odooExecuteKw(session.uid, model, 'read', [[recordId], fields]);
            if (Array.isArray(rows) && rows[0]) {
                return rows[0];
            }
        }
        catch {
            // API key read can fail; fall back to the login session.
        }
    }
    const rows = await odooCallKw(session.cookie, model, 'read', [[recordId], fields]);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
async function createOdooRecord(session, model, values) {
    if (env.odooApiKey) {
        try {
            return await odooExecuteKw(session.uid, model, 'create', [values]);
        }
        catch {
            // API key create can fail with Access Denied; use the login session instead.
        }
    }
    return odooCallKw(session.cookie, model, 'create', [values]);
}
/** Prefer the login cookie so Studio fields respect the user’s field access. */
async function writeOdooRecord(session, model, recordId, values) {
    await odooCallKw(session.cookie, model, 'write', [[recordId], values]);
}
export async function createOdooQuotation(userId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(input.partnerId) || input.partnerId <= 0) {
        throw new Error('A valid customer is required.');
    }
    if (input.lines.length === 0) {
        throw new Error('Add at least one product before saving.');
    }
    const orderLineCommands = input.lines.map(line => [
        0,
        0,
        {
            product_id: line.productId,
            product_uom_qty: line.quantity,
            price_unit: line.unitPrice,
            discount: line.discountPercent,
        },
    ]);
    const shippingPartnerId = input.shippingPartnerId !== undefined &&
        Number.isFinite(input.shippingPartnerId) &&
        input.shippingPartnerId > 0
        ? input.shippingPartnerId
        : input.partnerId;
    const values = {
        partner_id: input.partnerId,
        partner_invoice_id: input.partnerId,
        partner_shipping_id: shippingPartnerId,
        order_line: orderLineCommands,
    };
    if (input.paymentMethodLineId !== undefined &&
        Number.isFinite(input.paymentMethodLineId) &&
        input.paymentMethodLineId > 0) {
        values.preferred_payment_method_line_id = input.paymentMethodLineId;
    }
    // Studio fields are written after create via the login session. API-key create
    // often persists the order but silently drops x_studio_* fields.
    const studioValues = {};
    const deliveryNotes = input.deliveryNotes?.trim();
    if (deliveryNotes) {
        studioValues.x_studio_delivery_notes = deliveryNotes;
    }
    const preferredDeliveryDate = input.preferredDeliveryDate?.trim();
    if (preferredDeliveryDate) {
        studioValues.x_studio_preferred_delivery_date = preferredDeliveryDate;
    }
    const phoneNumber = input.phoneNumber?.trim();
    if (phoneNumber) {
        studioValues.x_studio_phonenumber = phoneNumber;
    }
    const salePersonName = input.salePersonName?.trim();
    if (salePersonName) {
        studioValues.x_studio_sale_person_name = salePersonName;
    }
    const quotationId = await createOdooRecord(session, 'sale.order', values);
    if (Object.keys(studioValues).length > 0) {
        await writeOdooRecord(session, 'sale.order', quotationId, studioValues);
    }
    if (salePersonName) {
        const verify = await readOdooRecord(session, 'sale.order', quotationId, ['x_studio_sale_person_name']);
        const saved = String(verify?.x_studio_sale_person_name || '').trim();
        if (saved !== salePersonName) {
            throw new Error(`Sale Person Name was not saved to Odoo (expected "${salePersonName}", got "${saved || '(empty)'}"). Check field access on x_studio_sale_person_name.`);
        }
    }
    const created = await readOdooRecord(session, 'sale.order', quotationId, ['id', 'name']);
    return {
        id: quotationId,
        name: created?.name ?? String(quotationId),
    };
}
async function searchReadOdooRecords(session, model, domain, fields, kwargs = {}) {
    if (env.odooApiKey) {
        try {
            const rows = await odooExecuteKw(session.uid, model, 'search_read', [domain, fields], kwargs);
            if (Array.isArray(rows)) {
                return rows;
            }
        }
        catch {
            // API key search_read can fail; fall back to the login session.
        }
    }
    return odooCallKw(session.cookie, model, 'search_read', [domain, fields], kwargs);
}
export async function fetchOdooQuotations(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: session.cookie,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: {
                model: 'sale.order',
                method: 'search_read',
                args: [[], QUOTATION_LIST_FIELDS],
                kwargs: {
                    order: 'create_date desc',
                    limit: 1000,
                },
            },
            id: Date.now(),
        }),
    });
    const data = (await response.json());
    if (data.error) {
        const message = data.error.data?.message ??
            data.error.message ??
            'Failed to load quotations.';
        throw new Error(message);
    }
    return data.result ?? [];
}
export async function fetchOdooQuotationById(userId, quotationId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const detail = await readOdooRecord(session, 'sale.order', quotationId, QUOTATION_DETAIL_FIELDS);
    if (detail) {
        return detail;
    }
    const summary = await readOdooRecord(session, 'sale.order', quotationId, QUOTATION_LIST_FIELDS);
    return summary;
}
export async function fetchOdooPaymentMethodLines(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    let rows = [];
    try {
        rows = await searchReadOdooRecords(session, 'account.payment.method.line', [['payment_type', '=', 'inbound']], ['id', 'name', 'payment_method_id', 'journal_id', 'payment_type'], { order: 'journal_id asc, id asc', limit: 500 });
    }
    catch {
        rows = await searchReadOdooRecords(session, 'account.payment.method.line', [], ['id', 'name', 'payment_method_id', 'journal_id', 'payment_type'], { order: 'journal_id asc, id asc', limit: 500 });
    }
    const byJournal = new Map();
    for (const row of rows) {
        if (row.payment_type && row.payment_type !== 'inbound') {
            continue;
        }
        const journalId = odooRelationId(row.journal_id);
        if (!journalId || byJournal.has(journalId)) {
            continue;
        }
        const journal = odooRelationLabel(row.journal_id);
        const methodName = odooString(row.name) || odooRelationLabel(row.payment_method_id);
        const name = journal || methodName || `Payment method ${row.id}`;
        byJournal.set(journalId, { id: row.id, name });
    }
    return Array.from(byJournal.values()).sort((a, b) => a.name.localeCompare(b.name));
}
function odooString(value) {
    if (value === false || value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
}
function odooRelationLabel(value) {
    if (Array.isArray(value) && value[1]) {
        return odooString(value[1]);
    }
    return '';
}
function odooRelationId(value) {
    if (Array.isArray(value) && typeof value[0] === 'number') {
        return value[0];
    }
    return 0;
}
/** Merges partner address with linked Township record (city/state/zip/country). */
export function resolvePartnerLocation(partner, township) {
    const townshipLabel = odooRelationLabel(partner[PARTNER_TOWNSHIP_FIELD]) ||
        (township ? odooString(township.x_name) : '');
    const city = odooString(partner.city) ||
        (township ? odooString(township.x_name) : '') ||
        townshipLabel;
    const state = odooRelationLabel(partner.state_id) ||
        odooRelationLabel(township?.x_studio_state_link);
    const stateId = odooRelationId(partner.state_id) ||
        odooRelationId(township?.x_studio_state_link) ||
        null;
    const zip = odooString(partner.zip) || odooString(township?.x_studio_postal_code);
    const country = odooRelationLabel(partner.country_id) ||
        odooRelationLabel(township?.x_studio_country_link);
    const countryId = odooRelationId(partner.country_id) ||
        odooRelationId(township?.x_studio_country_link) ||
        null;
    return {
        township: townshipLabel,
        city,
        state,
        stateId: stateId || null,
        zip,
        country,
        countryId: countryId || null,
    };
}
export async function fetchOdooTownships(userId) {
    if (!env.odooTownshipModel) {
        return [];
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    try {
        return await searchReadOdooRecords(session, env.odooTownshipModel, [], ['id', 'x_name'], { order: 'x_name asc', limit: 5000 });
    }
    catch {
        return [];
    }
}
export async function fetchOdooPartnerTags(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return searchReadOdooRecords(session, 'res.partner.category', [], ['id', 'name'], { order: 'name asc', limit: 1000 });
}
export async function resolveOdooPartnerTagIds(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const ids = new Set();
    for (const tagId of options.tagIds ?? []) {
        if (Number.isFinite(tagId) && tagId > 0) {
            ids.add(tagId);
        }
    }
    if (ids.size > 0) {
        const rows = await readOdooRecords(session, 'res.partner.category', [...ids], ['id']);
        return rows.map(row => row.id).filter(id => id > 0);
    }
    for (const tagName of options.tagNames ?? []) {
        const trimmed = tagName.trim();
        if (!trimmed) {
            continue;
        }
        const existing = await searchReadOdooRecords(session, 'res.partner.category', [[['name', '=', trimmed]]], ['id', 'name'], { limit: 1 });
        if (existing[0]?.id) {
            ids.add(existing[0].id);
        }
    }
    return [...ids];
}
export async function searchOdooContactsByPhone(userId, phone) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const normalized = normalizeMyanmarPhone(phone);
    const last7 = lastPhoneDigits(phone, 7);
    const rows = await searchReadOdooRecords(session, 'res.partner', [
        '|',
        ['phone', 'ilike', normalized],
        ['phone', 'ilike', last7],
    ], [
        'id',
        'name',
        'phone',
        'street',
        'street2',
        'city',
        'is_company',
        'parent_id',
        'type',
        PARTNER_TOWNSHIP_FIELD,
    ], { limit: 20, order: 'name asc' });
    return rows.filter(row => {
        const storedPhone = odooString(row.phone);
        if (!storedPhone) {
            return false;
        }
        const storedNormalized = normalizeMyanmarPhone(storedPhone);
        if (storedNormalized === normalized) {
            return true;
        }
        return (last7.length >= 7 &&
            lastPhoneDigits(storedNormalized, 7) === last7);
    });
}
export async function createOdooContact(userId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const name = input.name.trim();
    if (!name) {
        throw new Error('Name is required.');
    }
    const phone = input.phone?.trim();
    const isChildAddress = input.parentId !== undefined &&
        Number.isFinite(input.parentId) &&
        input.parentId > 0;
    if (phone && !isChildAddress) {
        const existing = await searchOdooContactsByPhone(userId, phone);
        if (existing.length > 0) {
            throw new Error('A contact with this phone number already exists. Open the existing contact instead of creating a new one.');
        }
    }
    const values = {
        name,
        customer_rank: isChildAddress ? 0 : 1,
    };
    if (isChildAddress) {
        values.parent_id = input.parentId;
        values.type = input.type ?? 'delivery';
    }
    const email = input.email?.trim();
    if (email) {
        values.email = email;
    }
    if (phone) {
        values.phone = phone;
    }
    const street = input.street?.trim();
    if (street) {
        values.street = street;
    }
    const street2 = input.street2?.trim();
    if (street2) {
        values.street2 = street2;
    }
    if (input.townshipId !== undefined &&
        Number.isFinite(input.townshipId) &&
        input.townshipId > 0) {
        values[PARTNER_TOWNSHIP_FIELD] = input.townshipId;
    }
    const tagIds = await resolveOdooPartnerTagIds(userId, {
        tagIds: input.tagIds,
        tagNames: input.tagIds?.length ? undefined : input.tagNames,
    });
    if (tagIds.length > 0) {
        values.category_id = [[6, 0, tagIds]];
    }
    const contactId = await createOdooRecord(session, 'res.partner', values);
    return {
        id: contactId,
        name,
    };
}
const ADDRESS_PARTNER_FIELDS = [
    'id',
    'name',
    'phone',
    'street',
    'street2',
    'city',
    'is_company',
    'parent_id',
    'type',
    PARTNER_TOWNSHIP_FIELD,
];
function buildAddressLabel(partner, township, isMain) {
    const place = [township, odooString(partner.city), odooString(partner.street)]
        .filter(Boolean)
        .join(' · ');
    const name = odooString(partner.name) || (isMain ? 'Main address' : 'Address');
    if (isMain) {
        return place ? `Main · ${name} (${place})` : `Main · ${name}`;
    }
    return place ? `${name} (${place})` : name;
}
async function mapAddressOption(userId, partner, isMain) {
    const townshipRecord = await fetchOdooTownshipForPartner(userId, partner);
    const location = resolvePartnerLocation(partner, townshipRecord);
    const township = location.township;
    const type = odooString(partner.type) || (isMain ? 'contact' : 'delivery');
    return {
        id: partner.id,
        name: odooString(partner.name),
        phone: odooString(partner.phone),
        street: odooString(partner.street),
        street2: odooString(partner.street2),
        city: location.city,
        township,
        parentId: odooRelationId(partner.parent_id) || null,
        isCompany: Boolean(partner.is_company),
        isMain,
        type,
        label: buildAddressLabel(partner, township, isMain),
    };
}
export async function fetchOdooPartnerAddressOptions(userId, partnerId) {
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        throw new Error('A valid customer is required.');
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const selected = await readOdooRecord(session, 'res.partner', partnerId, ADDRESS_PARTNER_FIELDS);
    if (!selected) {
        throw new Error('Contact not found.');
    }
    const parentId = odooRelationId(selected.parent_id);
    const companyId = parentId || selected.id;
    const company = companyId === selected.id
        ? selected
        : await readOdooRecord(session, 'res.partner', companyId, ADDRESS_PARTNER_FIELDS);
    if (!company) {
        throw new Error('Company contact not found.');
    }
    const children = await searchReadOdooRecords(session, 'res.partner', [['parent_id', '=', companyId]], ADDRESS_PARTNER_FIELDS, { order: 'name asc', limit: 200 });
    const deliveryChildren = children.filter(child => {
        const type = odooString(child.type).toLowerCase();
        return !type || type === 'delivery' || type === 'other' || type === 'contact';
    });
    const companyOption = await mapAddressOption(userId, company, true);
    const childOptions = await Promise.all(deliveryChildren.map(child => mapAddressOption(userId, child, false)));
    const addresses = [companyOption, ...childOptions];
    const defaultAddressId = addresses.some(item => item.id === partnerId)
        ? partnerId
        : companyId;
    return {
        companyId,
        companyName: companyOption.name,
        company: companyOption,
        defaultAddressId,
        addresses,
    };
}
export async function fetchOdooTownshipById(userId, townshipId) {
    if (!env.odooTownshipModel || !Number.isFinite(townshipId) || townshipId <= 0) {
        return null;
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    try {
        return await readOdooRecord(session, env.odooTownshipModel, townshipId, TOWNSHIP_FIELDS);
    }
    catch {
        return null;
    }
}
export async function fetchOdooTownshipForPartner(userId, partner) {
    const townshipId = odooRelationId(partner[PARTNER_TOWNSHIP_FIELD]);
    if (!townshipId) {
        return null;
    }
    return fetchOdooTownshipById(userId, townshipId);
}
export function formatOdooPartnerAddress(partner, location) {
    const parts = [
        odooString(partner.street),
        odooString(partner.street2),
        location.township || location.city,
        location.state,
        location.zip,
        location.country,
    ].filter(Boolean);
    return parts.join(', ');
}
export async function fetchOdooPartnerAddress(userId, partnerId) {
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        return { formatted: '', phone: '' };
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const partner = await readOdooRecord(session, 'res.partner', partnerId, PARTNER_ADDRESS_FIELDS);
    if (!partner) {
        return { formatted: '', phone: '' };
    }
    const township = await fetchOdooTownshipForPartner(userId, partner);
    const location = resolvePartnerLocation(partner, township);
    return {
        formatted: formatOdooPartnerAddress(partner, location),
        phone: odooString(partner.phone),
    };
}
export async function fetchOdooQuotationLines(userId, quotationId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return searchReadOdooRecords(session, 'sale.order.line', [['order_id', '=', quotationId]], ORDER_LINE_FIELDS, { order: 'sequence asc, id asc' });
}
export async function fetchOdooContacts(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const fields = [
        ...CONTACT_BASE_FIELDS,
        ...Object.keys(CONTACT_CUSTOM_FIELDS),
        ...CONTACT_EXTRA_FIELDS,
    ];
    const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: session.cookie,
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'call',
            params: {
                model: 'res.partner',
                method: 'search_read',
                args: [[], fields],
                kwargs: {
                    order: 'name asc',
                    limit: 1000,
                },
            },
            id: Date.now(),
        }),
    });
    const data = (await response.json());
    if (data.error) {
        const message = data.error.data?.message ?? data.error.message ?? 'Failed to load contacts.';
        throw new Error(message);
    }
    return data.result ?? [];
}
/** Lean contact list for New Quotation — fewer fields, customers only. */
export async function fetchOdooContactsForQuotation(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const fields = [...CONTACT_BASE_FIELDS, PARTNER_TOWNSHIP_FIELD];
    return searchReadOdooRecords(session, 'res.partner', [['customer_rank', '>', 0]], fields, {
        order: 'name asc',
        limit: 500,
    });
}
export async function fetchOdooContactById(userId, contactId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return readOdooRecord(session, 'res.partner', contactId, CONTACT_DETAIL_FIELDS);
}
export async function fetchOdooPartnerCategoryNames(userId, categoryIds) {
    const session = getOdooSession(userId);
    if (!session || categoryIds.length === 0) {
        return [];
    }
    const rows = await readOdooRecords(session, 'res.partner.category', categoryIds, ['name']);
    return rows.map(row => row.name).filter(Boolean);
}
async function readOdooRecords(session, model, recordIds, fields) {
    if (recordIds.length === 0) {
        return [];
    }
    if (env.odooApiKey) {
        try {
            const rows = await odooExecuteKw(session.uid, model, 'read', [recordIds, fields]);
            if (Array.isArray(rows)) {
                return rows;
            }
        }
        catch {
            // Fall back to the browser session below.
        }
    }
    return odooCallKw(session.cookie, model, 'read', [recordIds, fields]);
}
