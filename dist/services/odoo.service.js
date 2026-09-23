import { env } from '../config/env.js';
import { lastPhoneDigits, normalizeMyanmarPhone, } from '../utils/myanmar-phone.js';
import { normalizeOdooErrorMessage } from '../utils/odoo-session-error.js';
import { assertPortalPassword } from '../utils/portal-password.js';
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
/** Studio char — App Promoter name set from website install Request. */
export const PARTNER_APP_PROMOTER_FIELD = 'x_studio_app_promoter';
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
    PARTNER_APP_PROMOTER_FIELD,
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
    let response;
    try {
        response = await fetch(`${env.odooUrl}/web/session/authenticate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    db: env.odooDb,
                    login: login.trim(),
                    password,
                },
                id: Date.now(),
            }),
        });
    }
    catch {
        throw new Error('Could not reach Odoo. Check ODOO_URL on the server and try again.');
    }
    if (!response.ok) {
        throw new Error(`Odoo authentication failed (HTTP ${response.status}). Check ODOO_URL / ODOO_DB.`);
    }
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
export async function fetchOdooProducts(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 500;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const q = String(options?.q ?? '').trim();
    const category = String(options?.category ?? '').trim();
    const domain = [['active', '=', true]];
    if (options?.filter === 'qrApp') {
        // sale_ok / website_published / product_tag_ids live on product.template;
        // use template paths so product.product search_read stays reliable.
        domain.push(['sale_ok', '=', true]);
        domain.push(['product_tmpl_id.website_published', '=', true]);
        domain.push(['product_tmpl_id.product_tag_ids.name', 'ilike', 'QR App']);
    }
    if (q) {
        domain.push('|');
        domain.push(['name', 'ilike', q]);
        domain.push(['default_code', 'ilike', q]);
    }
    if (category) {
        domain.push(['categ_id.name', '=', category]);
    }
    const fields = [
        'id',
        'name',
        'default_code',
        'list_price',
        'qty_available',
        'active',
        'categ_id',
        'uom_id',
        'product_tmpl_id',
    ];
    // Odoo Product Kanban stars use product.template.priority.
    const favoriteField = await resolveProductFavoriteField(session);
    if (favoriteField?.model === 'product.product') {
        fields.push(favoriteField.name);
    }
    const callSearchRead = async (searchDomain) => {
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
                    args: [searchDomain, fields],
                    kwargs: {
                        order: favoriteField?.model === 'product.product'
                            ? `${favoriteField.name} desc, name asc`
                            : favoriteField?.model === 'product.template'
                                ? `product_tmpl_id.${favoriteField.name} desc, name asc`
                                : 'name asc',
                        // Avoid image_128 (huge payload). qty_available is included for Stock / On Hand.
                        limit,
                        offset,
                    },
                },
                id: Date.now(),
            }),
        });
        return (await response.json());
    };
    let data = await callSearchRead(domain);
    // Fallback when website_published / tags are directly on product.product.
    if (data.error && options?.filter === 'qrApp') {
        const fallbackDomain = [
            ['active', '=', true],
            ['sale_ok', '=', true],
            ['website_published', '=', true],
            ['product_tag_ids.name', 'ilike', 'QR App'],
        ];
        if (q) {
            fallbackDomain.push('|');
            fallbackDomain.push(['name', 'ilike', q]);
            fallbackDomain.push(['default_code', 'ilike', q]);
        }
        if (category) {
            fallbackDomain.push(['categ_id.name', '=', category]);
        }
        data = await callSearchRead(fallbackDomain);
    }
    // If related order path fails on older Odoo, retry with plain name order.
    if (data.error && favoriteField?.model === 'product.template') {
        const retry = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
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
                    args: [domain, fields],
                    kwargs: { order: 'name asc', limit, offset },
                },
                id: Date.now(),
            }),
        });
        data = (await retry.json());
    }
    if (data.error) {
        const message = data.error.data?.message ?? data.error.message ?? 'Failed to load products.';
        throw new Error(message);
    }
    return attachProductFavorites(session, data.result ?? [], favoriteField);
}
const PRODUCT_DETAIL_FIELDS = [
    'id',
    'name',
    'default_code',
    'list_price',
    'qty_available',
    'active',
    'categ_id',
    'uom_id',
    'barcode',
    'description_sale',
    'type',
    'standard_price',
];
const PRODUCT_DETAIL_FIELDS_MIN = [
    'id',
    'name',
    'default_code',
    'list_price',
    'active',
    'categ_id',
    'uom_id',
];
export async function fetchOdooProductById(userId, productId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const favoriteField = await resolveProductFavoriteField(session);
    const extraFields = ['product_tmpl_id'];
    if (favoriteField?.model === 'product.product') {
        extraFields.push(favoriteField.name);
    }
    const detailFields = [...PRODUCT_DETAIL_FIELDS, ...extraFields];
    const minFields = [...PRODUCT_DETAIL_FIELDS_MIN, ...extraFields];
    try {
        const detail = await readOdooRecordAsUser(session, 'product.product', productId, detailFields);
        if (detail) {
            const [withFav] = await attachProductFavorites(session, [detail], favoriteField);
            return withFav;
        }
    }
    catch (error) {
        console.warn('[products] Detail fields failed, falling back to minimal fields:', error instanceof Error ? error.message : error);
    }
    try {
        const detail = await readOdooRecordAsUser(session, 'product.product', productId, minFields);
        if (!detail)
            return null;
        const [withFav] = await attachProductFavorites(session, [detail], favoriteField);
        return withFav;
    }
    catch (error) {
        console.error('[products] Failed to read product:', error instanceof Error ? error.message : error);
        throw error instanceof Error
            ? error
            : new Error('Failed to load product.');
    }
}
/**
 * Toggle product favorite.
 * Uses Odoo product.template.priority (Kanban star) when available;
 * otherwise returns false so the caller can persist in the ERP store.
 */
export async function updateOdooProductFavorite(userId, productId, favorite) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const favoriteField = await resolveProductFavoriteField(session);
    if (!favoriteField) {
        return false;
    }
    const value = odooValueFromFavorite(favorite, favoriteField.kind);
    if (favoriteField.model === 'product.product') {
        await writeOdooRecordAsUser(session, 'product.product', productId, {
            [favoriteField.name]: value,
        });
        return true;
    }
    const product = await readOdooRecordAsUser(session, 'product.product', productId, ['product_tmpl_id']);
    const tmplId = templateIdFromProduct(product ?? {});
    if (!tmplId) {
        throw new Error('Could not resolve product template for favorite.');
    }
    await writeOdooRecordAsUser(session, 'product.template', tmplId, {
        [favoriteField.name]: value,
    });
    return true;
}
const QR_APP_TAG_NAME = 'QR App';
/** Avoid re-searching product.tag "QR App" on every Visible-to-app toggle. */
let cachedQrAppTagId = null;
async function resolveProductTemplateId(session, productId) {
    const product = await readOdooRecordAsUser(session, 'product.product', productId, ['product_tmpl_id']);
    const tmplId = templateIdFromProduct(product ?? {});
    if (!tmplId) {
        throw new Error('Could not resolve product template.');
    }
    return tmplId;
}
export async function fetchOdooProductTags(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const rows = await searchReadOdooRecords(session, 'product.tag', [], ['id', 'name'], { order: 'name asc', limit: 500 });
    return rows
        .map(row => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name.trim() : '',
    }))
        .filter(row => row.id > 0 && row.name);
}
/** Find an existing product.tag by name — does not create. */
async function findOdooProductTagIdByName(session, name) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error('Tag name is required.');
    }
    const existing = await searchReadOdooRecords(session, 'product.tag', [['name', '=ilike', trimmed]], ['id', 'name'], { limit: 10 });
    const exact = existing.find(row => String(row.name || '')
        .trim()
        .toLowerCase() === trimmed.toLowerCase());
    if (exact?.id) {
        return exact.id;
    }
    if (existing[0]?.id) {
        return existing[0].id;
    }
    throw new Error(`Product tag "${trimmed}" was not found in Odoo. Create it under Product Tags first (same name as the contact tag).`);
}
async function ensureOdooProductTagIdByName(session, name) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error('Tag name is required.');
    }
    try {
        return await findOdooProductTagIdByName(session, trimmed);
    }
    catch (error) {
        if (error instanceof Error && /was not found/i.test(error.message)) {
            return createOdooRecord(session, 'product.tag', { name: trimmed });
        }
        throw error;
    }
}
async function ensureOdooQrAppTagId(session) {
    if (cachedQrAppTagId && cachedQrAppTagId > 0) {
        return cachedQrAppTagId;
    }
    const id = await ensureOdooProductTagIdByName(session, QR_APP_TAG_NAME);
    cachedQrAppTagId = id;
    return id;
}
/** Match product tag names to contact tags without loading the full contact-tag list. */
async function fetchForYouTagsMatchingProductTags(session, productTags) {
    const names = [
        ...new Set(productTags
            .map(tag => tag.name.trim())
            .filter(name => Boolean(name) &&
            name.toLowerCase() !== QR_APP_TAG_NAME.toLowerCase())),
    ];
    if (names.length === 0) {
        return [];
    }
    const rows = await searchReadOdooRecords(session, 'res.partner.category', [['name', 'in', names]], ['id', 'name'], { limit: Math.max(50, names.length * 2) });
    const wanted = new Set(names.map(name => name.toLowerCase()));
    return rows
        .map(row => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name.trim() : '',
    }))
        .filter(row => row.id > 0 && row.name && wanted.has(row.name.toLowerCase()));
}
export async function fetchOdooProductAppAccess(userId, productId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(productId) || productId <= 0) {
        throw new Error('Invalid product id.');
    }
    const tmplId = options?.templateId && options.templateId > 0
        ? options.templateId
        : await resolveProductTemplateId(session, productId);
    const template = await readOdooRecordAsUser(session, 'product.template', tmplId, [
        'id',
        'sale_ok',
        'website_published',
        'product_tag_ids',
        'public_categ_ids',
    ]);
    if (!template) {
        throw new Error('Product template not found.');
    }
    const tagIds = Array.isArray(template.product_tag_ids)
        ? template.product_tag_ids.filter(id => Number.isFinite(id) && id > 0)
        : [];
    const categIds = Array.isArray(template.public_categ_ids)
        ? template.public_categ_ids.filter(id => Number.isFinite(id) && id > 0)
        : [];
    const [tagRows, categRows] = await Promise.all([
        tagIds.length
            ? readOdooRecords(session, 'product.tag', tagIds, ['id', 'name'])
            : Promise.resolve([]),
        categIds.length
            ? readOdooRecords(session, 'product.public.category', categIds, ['id', 'name'])
            : Promise.resolve([]),
    ]);
    const tags = tagRows
        .map(row => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name.trim() : '',
    }))
        .filter(row => row.id > 0 && row.name);
    const ecommerceCategories = categRows
        .map(row => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name.trim() : '',
    }))
        .filter(row => row.id > 0 && row.name);
    const forYouTags = await fetchForYouTagsMatchingProductTags(session, tags);
    const saleOk = Boolean(template.sale_ok);
    const websitePublished = Boolean(template.website_published);
    const hasQrAppTag = tags.some(tag => tag.name.toLowerCase() === QR_APP_TAG_NAME.toLowerCase());
    const hasEcommerceCategory = ecommerceCategories.length > 0;
    return {
        templateId: tmplId,
        saleOk,
        websitePublished,
        hasQrAppTag,
        hasEcommerceCategory,
        tagIds,
        tags,
        ecommerceCategories,
        forYouTags,
        readyForApp: saleOk && websitePublished && hasQrAppTag && hasEcommerceCategory,
    };
}
export async function updateOdooProductAppAccess(userId, productId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(productId) || productId <= 0) {
        throw new Error('Invalid product id.');
    }
    const tmplId = await resolveProductTemplateId(session, productId);
    const values = {};
    if (typeof input.enableQrApp === 'boolean') {
        const [qrAppTagId, current] = await Promise.all([
            ensureOdooQrAppTagId(session),
            readOdooRecordAsUser(session, 'product.template', tmplId, ['product_tag_ids']),
        ]);
        const currentIds = Array.isArray(current?.product_tag_ids)
            ? current.product_tag_ids.filter(id => Number.isFinite(id) && id > 0)
            : [];
        if (input.enableQrApp) {
            const nextIds = currentIds.includes(qrAppTagId)
                ? currentIds
                : [...currentIds, qrAppTagId];
            values.website_published = true;
            values.sale_ok = true;
            values.product_tag_ids = [[6, 0, nextIds]];
        }
        else {
            values.website_published = false;
            values.product_tag_ids = [
                [6, 0, currentIds.filter(id => id !== qrAppTagId)],
            ];
        }
    }
    else if (Array.isArray(input.forYouTagIds)) {
        const selectedPartnerIds = input.forYouTagIds.filter(id => Number.isFinite(id) && id > 0);
        const [selectedPartnerRows, current] = await Promise.all([
            selectedPartnerIds.length
                ? readOdooRecords(session, 'res.partner.category', selectedPartnerIds, ['id', 'name'])
                : Promise.resolve([]),
            readOdooRecordAsUser(session, 'product.template', tmplId, ['product_tag_ids']),
        ]);
        const selectedNames = selectedPartnerRows
            .map(row => (typeof row.name === 'string' ? row.name.trim() : ''))
            .filter(Boolean);
        const currentTagIds = Array.isArray(current?.product_tag_ids)
            ? current.product_tag_ids.filter(id => Number.isFinite(id) && id > 0)
            : [];
        const [syncedProductTagIds, tagRows] = await Promise.all([
            Promise.all(selectedNames.map(name => ensureOdooProductTagIdByName(session, name))),
            currentTagIds.length
                ? readOdooRecords(session, 'product.tag', currentTagIds, ['id', 'name'])
                : Promise.resolve([]),
        ]);
        const currentProductTags = tagRows
            .map(row => ({
            id: row.id,
            name: typeof row.name === 'string' ? row.name.trim() : '',
        }))
            .filter(row => row.id > 0 && row.name);
        const matchedForYou = await fetchForYouTagsMatchingProductTags(session, currentProductTags);
        const managedNames = new Set([
            ...matchedForYou.map(tag => tag.name),
            ...selectedNames,
        ].map(name => name.toLowerCase()));
        // Keep tags that are not "For you" contact-tag mirrors (e.g. QR App).
        const keptIds = currentProductTags
            .filter(row => {
            const name = row.name.toLowerCase();
            if (name === QR_APP_TAG_NAME.toLowerCase())
                return true;
            return !managedNames.has(name);
        })
            .map(row => row.id);
        const nextTagIds = [...keptIds];
        for (const id of syncedProductTagIds) {
            if (!nextTagIds.includes(id))
                nextTagIds.push(id);
        }
        values.product_tag_ids = [[6, 0, nextTagIds]];
    }
    else {
        if (typeof input.websitePublished === 'boolean') {
            values.website_published = input.websitePublished;
        }
        if (input.tagIds) {
            const tagIds = input.tagIds.filter(id => Number.isFinite(id) && id > 0);
            values.product_tag_ids = [[6, 0, tagIds]];
        }
    }
    if (Object.keys(values).length === 0) {
        throw new Error('No app settings to update.');
    }
    await writeOdooRecordAsUser(session, 'product.template', tmplId, values);
    return fetchOdooProductAppAccess(userId, productId, { templateId: tmplId });
}
/**
 * Create a product.template (Odoo 19.2) and return the main product.product variant id.
 * General Information + eCommerce fields; ecommerce extras soft-fail if website_sale fields missing.
 */
export async function createOdooProduct(userId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const name = String(input.name ?? '').trim();
    if (!name) {
        throw new Error('Product name is required.');
    }
    const typeRaw = String(input.type ?? 'consu').trim().toLowerCase();
    const type = typeRaw === 'service' || typeRaw === 'combo' ? typeRaw : 'consu';
    const coreValues = {
        name,
        type,
        sale_ok: input.saleOk !== false,
        purchase_ok: input.purchaseOk !== false,
    };
    if (type === 'consu') {
        coreValues.is_storable = input.trackInventory !== false;
    }
    if (input.invoicePolicy === 'delivery' || input.invoicePolicy === 'order') {
        coreValues.invoice_policy = input.invoicePolicy;
    }
    if (input.listPrice !== undefined &&
        Number.isFinite(input.listPrice) &&
        input.listPrice >= 0) {
        coreValues.list_price = input.listPrice;
    }
    if (input.cost !== undefined &&
        Number.isFinite(input.cost) &&
        input.cost >= 0) {
        coreValues.standard_price = input.cost;
    }
    if (input.categoryId !== undefined &&
        Number.isFinite(input.categoryId) &&
        input.categoryId > 0) {
        coreValues.categ_id = input.categoryId;
    }
    const sku = input.sku?.trim();
    if (sku) {
        coreValues.default_code = sku;
    }
    const barcode = input.barcode?.trim();
    if (barcode) {
        coreValues.barcode = barcode;
    }
    const notes = input.internalNotes?.trim();
    if (notes) {
        coreValues.description = notes;
    }
    const ecommerceValues = {};
    if (typeof input.websitePublished === 'boolean') {
        ecommerceValues.website_published = input.websitePublished;
    }
    if (input.websiteSequence !== undefined &&
        Number.isFinite(input.websiteSequence)) {
        ecommerceValues.website_sequence = Math.floor(input.websiteSequence);
    }
    if (Array.isArray(input.publicCategoryIds)) {
        const ids = input.publicCategoryIds.filter(id => Number.isFinite(id) && id > 0);
        ecommerceValues.public_categ_ids = [[6, 0, ids]];
    }
    if (Array.isArray(input.tagIds)) {
        const ids = input.tagIds.filter(id => Number.isFinite(id) && id > 0);
        ecommerceValues.product_tag_ids = [[6, 0, ids]];
    }
    if (typeof input.sellWhenOutOfStock === 'boolean') {
        ecommerceValues.allow_out_of_stock_order = input.sellWhenOutOfStock;
    }
    if (typeof input.showAvailableQty === 'boolean') {
        ecommerceValues.show_availability = input.showAvailableQty;
    }
    const oosMsg = input.outOfStockMessage?.trim();
    if (oosMsg) {
        ecommerceValues.out_of_stock_message = oosMsg;
    }
    const longDesc = input.longDescription?.trim();
    if (longDesc) {
        ecommerceValues.description_ecommerce = longDesc;
    }
    let templateId;
    try {
        templateId = await createOdooRecordAsUser(session, 'product.template', {
            ...coreValues,
            ...ecommerceValues,
        });
    }
    catch (fullError) {
        // Core create first when website_sale fields are missing / invalid.
        templateId = await createOdooRecordAsUser(session, 'product.template', coreValues);
        if (Object.keys(ecommerceValues).length > 0) {
            try {
                await writeOdooRecordAsUser(session, 'product.template', templateId, ecommerceValues);
            }
            catch (ecomError) {
                // Retry without description_ecommerce (field name varies by Odoo version).
                const { description_ecommerce: _drop, ...rest } = ecommerceValues;
                if (longDesc) {
                    rest.website_description = longDesc;
                }
                try {
                    if (Object.keys(rest).length > 0) {
                        await writeOdooRecordAsUser(session, 'product.template', templateId, rest);
                    }
                }
                catch {
                    console.warn('[products] ecommerce fields partial fail:', ecomError instanceof Error ? ecomError.message : ecomError, '| first create error:', fullError instanceof Error ? fullError.message : fullError);
                }
            }
        }
    }
    const variants = await searchReadOdooRecords(session, 'product.product', [['product_tmpl_id', '=', templateId]], ['id'], { limit: 1 });
    const productId = variants[0]?.id;
    if (!productId || !Number.isFinite(productId) || productId <= 0) {
        throw new Error('Product created but no variant was returned.');
    }
    return { id: productId, templateId };
}
/** Internal product categories (product.category) with ids for create forms. */
export async function fetchOdooProductCategoryOptions(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    let rows = [];
    try {
        rows = await searchReadOdooRecords(session, 'product.category', [], ['id', 'name', 'display_name'], { order: 'complete_name asc', limit: 500 });
    }
    catch {
        rows = await searchReadOdooRecords(session, 'product.category', [], ['id', 'name'], { order: 'name asc', limit: 500 });
    }
    return rows
        .map(row => ({
        id: row.id,
        name: odooString(row.display_name) || odooString(row.name),
    }))
        .filter(row => row.id > 0 && row.name);
}
/** Website eCommerce public categories (product.public.category). */
export async function fetchOdooPublicCategories(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const rows = await searchReadOdooRecords(session, 'product.public.category', [], ['id', 'name'], {
        order: 'sequence asc, name asc',
        limit: 500,
    });
    return rows
        .map(row => ({
        id: row.id,
        name: typeof row.name === 'string' ? row.name.trim() : '',
    }))
        .filter(row => row.id > 0 && row.name);
}
function parseYearMonthKey(month) {
    const match = /^(\d{4})-(\d{2})$/.exec(month.trim());
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const monthNum = Number(match[2]);
    if (!Number.isFinite(year) || monthNum < 1 || monthNum > 12) {
        return null;
    }
    const mm = String(monthNum).padStart(2, '0');
    const lastDay = new Date(year, monthNum, 0).getDate();
    const endDay = String(lastDay).padStart(2, '0');
    return {
        start: `${year}-${mm}-01`,
        end: `${year}-${mm}-${endDay}`,
        startDt: `${year}-${mm}-01 00:00:00`,
        endDt: `${year}-${mm}-${endDay} 23:59:59`,
    };
}
/** List product category names for inventory filters. */
export async function fetchOdooProductCategories(userId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    let rows = [];
    try {
        rows = await searchReadOdooRecords(session, 'product.category', [], ['id', 'name', 'display_name'], { order: 'name asc', limit: 500 });
    }
    catch {
        rows = await searchReadOdooRecords(session, 'product.category', [], ['id', 'name'], { order: 'name asc', limit: 500 });
    }
    const names = rows
        .map(row => odooString(row.display_name) || odooString(row.name))
        .filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
/** Current on-hand quantities for stockable products (accounting stock check). */
export async function fetchOdooOnHandProducts(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 500;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const q = String(options?.q ?? '').trim();
    const category = String(options?.category ?? '').trim();
    const baseDomain = [['active', '=', true]];
    // q = product name / SKU only (category is a separate filter).
    if (q) {
        baseDomain.push('|');
        baseDomain.push(['name', 'ilike', q]);
        baseDomain.push(['default_code', 'ilike', q]);
    }
    if (category) {
        baseDomain.push('|');
        baseDomain.push(['categ_id.name', '=', category]);
        baseDomain.push(['categ_id.complete_name', 'ilike', category]);
    }
    const fields = [
        'id',
        'name',
        'default_code',
        'categ_id',
        'qty_available',
        'uom_id',
    ];
    const stockableDomain = [
        ...baseDomain,
        ['type', 'in', ['product', 'consu']],
    ];
    let rows = [];
    try {
        rows = await searchReadOdooRecords(session, 'product.product', stockableDomain, fields, { order: 'name asc', limit, offset });
    }
    catch {
        // Fallback without complete_name / type filters if Studio/Odoo version differs.
        const fallbackDomain = [['active', '=', true]];
        if (q) {
            fallbackDomain.push('|');
            fallbackDomain.push(['name', 'ilike', q]);
            fallbackDomain.push(['default_code', 'ilike', q]);
        }
        if (category) {
            fallbackDomain.push(['categ_id.name', 'ilike', category]);
        }
        rows = await searchReadOdooRecords(session, 'product.product', fallbackDomain, fields, { order: 'name asc', limit, offset });
    }
    let mapped = rows.map(row => ({
        id: row.id,
        name: odooString(row.name) || `Product #${row.id}`,
        sku: odooString(row.default_code),
        category: odooRelationLabel(row.categ_id),
        onHand: Number(row.qty_available) || 0,
        unit: odooRelationLabel(row.uom_id) || 'Units',
    }));
    if (options?.hideZero) {
        mapped = mapped.filter(row => row.onHand !== 0);
    }
    // Prefer exact category label match when dropdown sent a name.
    if (category) {
        const needle = category.toLowerCase();
        mapped = mapped.filter(row => {
            const label = (row.category || '').toLowerCase();
            return label === needle || label.endsWith(`/${needle}`) || label.includes(needle);
        });
    }
    return mapped;
}
/** Done stock move lines (Moves History) for a month — accounting audit trail. */
export async function fetchOdooStockMoveLines(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset >= 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [['state', '=', 'done']];
    const monthRange = options?.month ? parseYearMonthKey(options.month) : null;
    if (monthRange) {
        domain.push(['date', '>=', monthRange.startDt]);
        domain.push(['date', '<=', monthRange.endDt]);
    }
    const category = String(options?.category ?? '').trim();
    if (category) {
        let productIdsInCategory = [];
        try {
            const products = await searchReadOdooRecords(session, 'product.product', [
                '|',
                ['categ_id.name', '=', category],
                ['categ_id.complete_name', 'ilike', category],
            ], ['id'], { limit: 2000 });
            productIdsInCategory = products.map(row => row.id);
        }
        catch {
            const products = await searchReadOdooRecords(session, 'product.product', [['categ_id.name', 'ilike', category]], ['id'], { limit: 2000 });
            productIdsInCategory = products.map(row => row.id);
        }
        if (productIdsInCategory.length === 0) {
            return [];
        }
        domain.push(['product_id', 'in', productIdsInCategory]);
    }
    // q = product name / reference only (category is a separate filter).
    const q = String(options?.q ?? '').trim();
    if (q) {
        domain.push('|');
        domain.push(['reference', 'ilike', q]);
        domain.push(['product_id', 'ilike', q]);
    }
    const fieldsWithQty = [
        'id',
        'date',
        'reference',
        'product_id',
        'location_id',
        'location_dest_id',
        'quantity',
        'uom_id',
        'state',
    ];
    const fieldsWithQtyDone = [
        'id',
        'date',
        'reference',
        'product_id',
        'location_id',
        'location_dest_id',
        'qty_done',
        'product_uom_id',
        'state',
    ];
    let rows = [];
    try {
        rows = await searchReadOdooRecords(session, 'stock.move.line', domain, fieldsWithQty, { order: 'date desc, id desc', limit, offset });
    }
    catch {
        rows = await searchReadOdooRecords(session, 'stock.move.line', domain, fieldsWithQtyDone, { order: 'date desc, id desc', limit, offset });
    }
    const productIds = [
        ...new Set(rows
            .map(row => odooRelationId(row.product_id))
            .filter(id => id > 0)),
    ];
    const categoryByProductId = new Map();
    if (productIds.length > 0) {
        try {
            const products = await searchReadOdooRecords(session, 'product.product', [['id', 'in', productIds]], ['id', 'categ_id'], { limit: productIds.length });
            for (const product of products) {
                categoryByProductId.set(product.id, odooRelationLabel(product.categ_id));
            }
        }
        catch {
            // Category enrichment is optional.
        }
    }
    return rows.map(row => {
        const productId = odooRelationId(row.product_id);
        const qty = typeof row.quantity === 'number' && Number.isFinite(row.quantity)
            ? row.quantity
            : typeof row.qty_done === 'number' && Number.isFinite(row.qty_done)
                ? row.qty_done
                : 0;
        const dateRaw = typeof row.date === 'string' ? row.date : '';
        return {
            id: row.id,
            date: dateRaw,
            reference: odooString(row.reference),
            productId,
            productName: odooRelationLabel(row.product_id),
            category: categoryByProductId.get(productId) || '',
            fromLocation: odooRelationLabel(row.location_id),
            toLocation: odooRelationLabel(row.location_dest_id),
            quantity: qty,
            unit: odooRelationLabel(row.uom_id) ||
                odooRelationLabel(row.product_uom_id) ||
                'Units',
            state: odooString(row.state) || 'done',
        };
    });
}
const pricelistIdCache = new Map();
function relationId(value) {
    return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null;
}
function itemFixedPrice(row) {
    const fixed = Number(row.fixed_price);
    if (Number.isFinite(fixed)) {
        return fixed;
    }
    const legacy = Number(row.price);
    return Number.isFinite(legacy) ? legacy : null;
}
async function findPricelistIdByName(session, nameQuery) {
    const key = nameQuery.trim().toLowerCase();
    if (!key)
        return null;
    if (pricelistIdCache.has(key)) {
        return pricelistIdCache.get(key) ?? null;
    }
    const rows = await searchReadOdooRecords(session, 'product.pricelist', [['name', 'ilike', nameQuery], ['active', '=', true]], ['id', 'name'], { limit: 5, order: 'id asc' });
    // Prefer an exact (case-insensitive) match, else first ilike hit.
    const exact = rows.find(row => row.name.trim().toLowerCase() === key);
    const chosen = exact ?? rows[0] ?? null;
    const id = chosen?.id ?? null;
    pricelistIdCache.set(key, id);
    return id;
}
async function findPricelistItemForProduct(session, pricelistId, productId, templateId) {
    const rows = await searchReadOdooRecords(session, 'product.pricelist.item', [
        '&',
        ['pricelist_id', '=', pricelistId],
        '|',
        ['product_id', '=', productId],
        ['product_tmpl_id', '=', templateId],
    ], [
        'id',
        'pricelist_id',
        'product_tmpl_id',
        'product_id',
        'min_quantity',
        'compute_price',
        'fixed_price',
        'price',
    ], { limit: 20, order: 'min_quantity asc, id asc' });
    if (!rows.length)
        return null;
    const variantExact = rows.find(row => relationId(row.product_id) === productId);
    if (variantExact)
        return variantExact;
    const templateExact = rows.find(row => relationId(row.product_tmpl_id) === templateId && !relationId(row.product_id));
    return templateExact ?? rows[0] ?? null;
}
async function loadMembershipPrice(session, pricelistName, productId, templateId) {
    const pricelistId = await findPricelistIdByName(session, pricelistName);
    if (!pricelistId) {
        return {
            pricelistId: null,
            pricelistName,
            itemId: null,
            price: null,
        };
    }
    const item = await findPricelistItemForProduct(session, pricelistId, productId, templateId);
    return {
        pricelistId,
        pricelistName,
        itemId: item?.id ?? null,
        price: item ? itemFixedPrice(item) : null,
    };
}
/**
 * Sales list_price + Premium / Pro membership pricelist fixed prices.
 */
export async function fetchOdooProductPrices(userId, productId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const product = await readOdooRecordAsUser(session, 'product.product', productId, ['list_price', 'product_tmpl_id']);
    if (!product)
        return null;
    const templateId = templateIdFromProduct(product);
    if (!templateId) {
        throw new Error('Could not resolve product template for prices.');
    }
    const [premium, pro] = await Promise.all([
        loadMembershipPrice(session, env.odooPricelistPremiumName, productId, templateId),
        loadMembershipPrice(session, env.odooPricelistProName, productId, templateId),
    ]);
    return {
        salesPrice: Number(product.list_price) || 0,
        premium,
        pro,
    };
}
async function upsertMembershipFixedPrice(session, pricelistName, productId, templateId, price) {
    const pricelistId = await findPricelistIdByName(session, pricelistName);
    if (!pricelistId) {
        throw new Error(`Pricelist "${pricelistName}" was not found in Odoo. Check the name or set ODOO_PRICELIST_* env vars.`);
    }
    const existing = await findPricelistItemForProduct(session, pricelistId, productId, templateId);
    if (existing) {
        try {
            await writeOdooRecordAsUser(session, 'product.pricelist.item', existing.id, {
                compute_price: 'fixed',
                fixed_price: price,
                min_quantity: existing.min_quantity > 0 ? existing.min_quantity : 1,
            });
        }
        catch {
            // Older DBs may use `price` instead of `fixed_price`.
            await writeOdooRecordAsUser(session, 'product.pricelist.item', existing.id, {
                compute_price: 'fixed',
                price,
                min_quantity: existing.min_quantity > 0 ? existing.min_quantity : 1,
            });
        }
        return {
            pricelistId,
            pricelistName,
            itemId: existing.id,
            price,
        };
    }
    let itemId;
    try {
        itemId = await createOdooRecordAsUser(session, 'product.pricelist.item', {
            pricelist_id: pricelistId,
            applied_on: '1_product',
            product_tmpl_id: templateId,
            compute_price: 'fixed',
            fixed_price: price,
            min_quantity: 1,
        });
    }
    catch {
        itemId = await createOdooRecordAsUser(session, 'product.pricelist.item', {
            pricelist_id: pricelistId,
            applied_on: '1_product',
            product_tmpl_id: templateId,
            compute_price: 'fixed',
            price,
            min_quantity: 1,
        });
    }
    return {
        pricelistId,
        pricelistName,
        itemId,
        price,
    };
}
export async function updateOdooProductPrices(userId, productId, updates) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const product = await readOdooRecordAsUser(session, 'product.product', productId, ['list_price', 'product_tmpl_id']);
    if (!product) {
        throw new Error('Product not found.');
    }
    const templateId = templateIdFromProduct(product);
    if (!templateId) {
        throw new Error('Could not resolve product template for prices.');
    }
    if (updates.salesPrice !== undefined) {
        if (!Number.isFinite(updates.salesPrice) || updates.salesPrice < 0) {
            throw new Error('Invalid sales price.');
        }
        await writeOdooRecordAsUser(session, 'product.template', templateId, {
            list_price: updates.salesPrice,
        });
    }
    if (updates.premiumPrice !== undefined) {
        if (!Number.isFinite(updates.premiumPrice) || updates.premiumPrice < 0) {
            throw new Error('Invalid Premium Membership price.');
        }
        await upsertMembershipFixedPrice(session, env.odooPricelistPremiumName, productId, templateId, updates.premiumPrice);
    }
    if (updates.proPrice !== undefined) {
        if (!Number.isFinite(updates.proPrice) || updates.proPrice < 0) {
            throw new Error('Invalid Pro Membership price.');
        }
        await upsertMembershipFixedPrice(session, env.odooPricelistProName, productId, templateId, updates.proPrice);
    }
    const prices = await fetchOdooProductPrices(userId, productId);
    if (!prices) {
        throw new Error('Failed to reload product prices.');
    }
    return prices;
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
    'x_studio_phonenumber_1',
    'x_studio_phonenumber',
    'x_studio_sale_person_name',
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
    'x_studio_preferred_delivery_date',
    'x_studio_delivery_notes',
    'commitment_date',
    'invoice_status',
];
const ORDER_LINE_FIELDS = [
    'id',
    'name',
    'product_id',
    'product_uom_qty',
    'product_uom_id',
    'qty_delivered',
    'qty_invoiced',
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
        const message = normalizeOdooErrorMessage(data.error.data?.message ?? data.error.message ?? 'Odoo request failed.');
        throw new Error(message);
    }
    return data.result;
}
export async function callOdooKwForUser(userId, model, method, args = [], kwargs = {}) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    try {
        return await odooCallKw(session.cookie, model, method, args, kwargs);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes('session expired')) {
            deleteOdooSession(userId);
        }
        throw error;
    }
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
        const message = normalizeOdooErrorMessage(data.error.data?.message ?? data.error.message ?? 'Odoo request failed.');
        throw new Error(message);
    }
    return data.result;
}
async function readOdooRecordAsUser(session, model, recordId, fields) {
    const rows = await odooCallKw(session.cookie, model, 'read', [
        [recordId],
        fields,
    ]);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
/** Tiny product image fetch for the /products/:id/image proxy. */
export async function fetchOdooProductImageBase64(userId, productId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const row = await readOdooRecordAsUser(session, 'product.product', productId, ['image_128', 'product_tmpl_id']);
    const onVariant = row?.image_128;
    if (typeof onVariant === 'string' && onVariant.trim()) {
        return onVariant.trim();
    }
    // Many Odoo setups keep the photo on product.template only.
    const templateId = Array.isArray(row?.product_tmpl_id)
        ? Number(row.product_tmpl_id[0])
        : 0;
    if (Number.isFinite(templateId) && templateId > 0) {
        const template = await readOdooRecordAsUser(session, 'product.template', templateId, ['image_128']);
        const onTemplate = template?.image_128;
        if (typeof onTemplate === 'string' && onTemplate.trim()) {
            return onTemplate.trim();
        }
    }
    return null;
}
async function createOdooRecordAsUser(session, model, values) {
    return odooCallKw(session.cookie, model, 'create', [values]);
}
async function writeOdooRecordAsUser(session, model, recordId, values) {
    await odooCallKw(session.cookie, model, 'write', [[recordId], values]);
}
const PRODUCT_FAVORITE_FIELD_CANDIDATES = [
    'priority',
    'x_studio_favorite',
    'x_studio_priority',
    'x_favorite',
];
let cachedProductFavoriteField;
function isFavoriteOdooValue(value, kind) {
    if (kind === 'boolean') {
        return Boolean(value);
    }
    return String(value ?? '0') === '1' || String(value ?? '') === 'true';
}
function odooValueFromFavorite(favorite, kind) {
    return kind === 'boolean' ? favorite : favorite ? '1' : '0';
}
function templateIdFromProduct(row) {
    const raw = row.product_tmpl_id;
    if (Array.isArray(raw) && typeof raw[0] === 'number') {
        return raw[0];
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    return null;
}
async function pickFavoriteFieldOnModel(session, model) {
    try {
        const fields = await odooCallKw(session.cookie, model, 'fields_get', [
            [...PRODUCT_FAVORITE_FIELD_CANDIDATES],
            ['type', 'store', 'readonly'],
        ]);
        for (const name of PRODUCT_FAVORITE_FIELD_CANDIDATES) {
            const meta = fields?.[name];
            if (!meta)
                continue;
            if (meta.readonly)
                continue;
            if (meta.store === false)
                continue;
            if (meta.type === 'boolean') {
                return { name, kind: 'boolean' };
            }
            if (meta.type === 'selection') {
                return { name, kind: 'selection' };
            }
        }
    }
    catch (error) {
        console.warn(`[products] Could not resolve favorite field on ${model}:`, error instanceof Error ? error.message : error);
    }
    return null;
}
/**
 * Detect Odoo product favorite/star field.
 * Odoo Product Kanban stars use product.template.priority ('1' = favorite).
 */
export async function resolveProductFavoriteField(session) {
    if (cachedProductFavoriteField !== undefined) {
        return cachedProductFavoriteField;
    }
    const onProduct = await pickFavoriteFieldOnModel(session, 'product.product');
    if (onProduct) {
        cachedProductFavoriteField = { ...onProduct, model: 'product.product' };
        return cachedProductFavoriteField;
    }
    const onTemplate = await pickFavoriteFieldOnModel(session, 'product.template');
    if (onTemplate) {
        cachedProductFavoriteField = { ...onTemplate, model: 'product.template' };
        return cachedProductFavoriteField;
    }
    cachedProductFavoriteField = null;
    return null;
}
async function attachProductFavorites(session, rows, favoriteField) {
    if (!favoriteField || rows.length === 0) {
        return rows;
    }
    if (favoriteField.model === 'product.product') {
        return rows.map(row => {
            const raw = row[favoriteField.name];
            return {
                ...row,
                __favorite: isFavoriteOdooValue(raw, favoriteField.kind),
            };
        });
    }
    const tmplIds = [
        ...new Set(rows
            .map(row => templateIdFromProduct(row))
            .filter((id) => id !== null)),
    ];
    if (tmplIds.length === 0) {
        return rows.map(row => ({ ...row, __favorite: false }));
    }
    const templates = await odooCallKw(session.cookie, 'product.template', 'search_read', [
        [['id', 'in', tmplIds]],
        ['id', favoriteField.name],
    ], { limit: tmplIds.length });
    const favoriteByTmpl = new Map();
    for (const tmpl of templates ?? []) {
        favoriteByTmpl.set(tmpl.id, isFavoriteOdooValue(tmpl[favoriteField.name], favoriteField.kind));
    }
    return rows.map(row => {
        const tmplId = templateIdFromProduct(row);
        return {
            ...row,
            __favorite: tmplId ? Boolean(favoriteByTmpl.get(tmplId)) : false,
        };
    });
}
/**
 * Resolve the live Studio field name for Sale Person Name.
 * Prefer the known technical name; fall back to ir.model.fields lookup.
 * Cached for the process lifetime — fields_get on every save was a slow extra RTT.
 */
let cachedSalePersonFieldName;
async function resolveSalePersonFieldName(session) {
    if (cachedSalePersonFieldName) {
        return cachedSalePersonFieldName;
    }
    const known = 'x_studio_sale_person_name';
    try {
        const fields = await odooCallKw(session.cookie, 'sale.order', 'fields_get', [
            [known],
            ['type', 'string', 'store', 'readonly'],
        ]);
        const meta = fields?.[known];
        if (meta) {
            if (meta.readonly) {
                throw new Error(`Sale Person Name field "${known}" is read-only in Odoo. Uncheck Readonly in Studio.`);
            }
            if (meta.store === false) {
                throw new Error(`Sale Person Name field "${known}" is not stored. In Studio, enable Stored so API can save it.`);
            }
            cachedSalePersonFieldName = known;
            return known;
        }
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('Sale Person Name field')) {
            throw error;
        }
        // fields_get may fail for missing fields; try ir.model.fields next.
    }
    try {
        const rows = await odooCallKw(session.cookie, 'ir.model.fields', 'search_read', [
            [
                ['model', '=', 'sale.order'],
                '|',
                ['name', '=', known],
                '&',
                ['name', 'ilike', 'sale_person'],
                ['ttype', '=', 'char'],
            ],
            ['name', 'field_description', 'store'],
        ], { limit: 10 });
        const exact = rows?.find(row => row.name === known);
        if (exact) {
            if (exact.store === false) {
                throw new Error(`Sale Person Name field "${known}" is not stored. In Studio, enable Stored so API can save it.`);
            }
            cachedSalePersonFieldName = exact.name;
            return exact.name;
        }
        const byLabel = rows?.find(row => String(row.field_description || '')
            .toLowerCase()
            .includes('sale person'));
        if (byLabel) {
            cachedSalePersonFieldName = byLabel.name;
            return byLabel.name;
        }
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('Sale Person Name field')) {
            throw error;
        }
        // Fall through to the known Studio name.
    }
    cachedSalePersonFieldName = known;
    return known;
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
export async function createOdooQuotation(userId, input, sessionOverride) {
    const session = sessionOverride ?? getOdooSession(userId);
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
    const salePersonField = salePersonName
        ? await resolveSalePersonFieldName(session)
        : '';
    if (salePersonName && salePersonField) {
        studioValues[salePersonField] = salePersonName;
    }
    // Always create via the login session when Studio fields are present so they
    // are not dropped by the API-key path.
    let quotationId;
    let studioWrittenOnCreate = false;
    if (Object.keys(studioValues).length > 0) {
        try {
            quotationId = await createOdooRecordAsUser(session, 'sale.order', {
                ...values,
                ...studioValues,
            });
            studioWrittenOnCreate = true;
        }
        catch {
            quotationId = await createOdooRecordAsUser(session, 'sale.order', values);
            for (const [field, value] of Object.entries(studioValues)) {
                try {
                    await writeOdooRecordAsUser(session, 'sale.order', quotationId, {
                        [field]: value,
                    });
                    if (field === salePersonField) {
                        studioWrittenOnCreate = true;
                    }
                }
                catch (error) {
                    if (field === salePersonField) {
                        throw error instanceof Error
                            ? error
                            : new Error(`Failed to write Sale Person Name (${field}).`);
                    }
                    console.error(`[quotations] Failed to write studio field ${field}:`, error instanceof Error ? error.message : error);
                }
            }
        }
    }
    else {
        quotationId = await createOdooRecord(session, 'sale.order', values);
    }
    // Only force-write + verify when create did not already include Studio fields.
    // The old path added 2–3 Odoo RTTs on every save.
    if (salePersonName && salePersonField && !studioWrittenOnCreate) {
        await writeOdooRecordAsUser(session, 'sale.order', quotationId, {
            [salePersonField]: salePersonName,
        });
        const verify = await readOdooRecordAsUser(session, 'sale.order', quotationId, [salePersonField]);
        const saved = String(verify?.[salePersonField] || '').trim();
        if (saved !== salePersonName) {
            throw new Error(`Sale Person Name was not saved to Odoo field "${salePersonField}" (expected "${salePersonName}", got "${saved || '(empty)'}"). Ask an Odoo admin to confirm the field is stored (not related) and writable for your user.`);
        }
    }
    const created = await readOdooRecordAsUser(session, 'sale.order', quotationId, ['id', 'name']);
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
export async function fetchOdooQuotations(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 1000;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [];
    appendOrderDateDomain(domain, options?.from, options?.to, 'create_date');
    const states = (options?.states ?? []).map(state => state.trim()).filter(Boolean);
    if (states.length > 0) {
        domain.push(['state', 'in', states]);
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
                args: [domain, QUOTATION_LIST_FIELDS],
                kwargs: {
                    order: 'create_date desc',
                    limit,
                    offset,
                },
            },
            id: Date.now(),
        }),
    });
    const data = (await response.json());
    if (data.error) {
        const message = normalizeOdooErrorMessage(data.error.data?.message ??
            data.error.message ??
            'Failed to load quotations.');
        throw new Error(message);
    }
    return data.result ?? [];
}
export async function fetchOdooQuotationById(userId, quotationId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    // Prefer the login session to avoid API-key timeout + cookie fallback latency.
    const detail = await readOdooRecordAsUser(session, 'sale.order', quotationId, QUOTATION_DETAIL_FIELDS);
    if (detail) {
        return detail;
    }
    return readOdooRecordAsUser(session, 'sale.order', quotationId, QUOTATION_LIST_FIELDS);
}
/** Header + lines + shipping address for the detail screen (parallelized). */
export async function fetchOdooQuotationDetailBundle(userId, quotationId) {
    const quotation = await fetchOdooQuotationById(userId, quotationId);
    if (!quotation) {
        return null;
    }
    const shippingPartnerId = odooRelationId(quotation.partner_shipping_id) ||
        odooRelationId(quotation.partner_id);
    const [lines, partnerAddress] = await Promise.all([
        fetchOdooQuotationLines(userId, quotationId),
        shippingPartnerId
            ? fetchOdooPartnerAddress(userId, shippingPartnerId, {
                resolveTownship: false,
            })
            : Promise.resolve({ formatted: '', phone: '' }),
    ]);
    return { quotation, lines, partnerAddress };
}
/**
 * Cancel a draft quotation in Odoo (`action_cancel`).
 * Only allowed when state is `draft` (UI label: Quotation).
 */
export async function cancelOdooQuotation(userId, quotationId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const existing = await fetchOdooQuotationById(userId, quotationId);
    if (!existing) {
        throw new Error('Quotation not found.');
    }
    const state = String(existing.state || '');
    if (state !== 'draft') {
        throw new Error('Only quotations in Quotation status can be cancelled.');
    }
    try {
        await odooCallKw(session.cookie, 'sale.order', 'action_cancel', [
            [quotationId],
        ]);
    }
    catch (cookieError) {
        try {
            await odooExecuteKw(session.uid, 'sale.order', 'action_cancel', [
                [quotationId],
            ]);
        }
        catch {
            throw cookieError instanceof Error
                ? cookieError
                : new Error('Failed to cancel quotation in Odoo.');
        }
    }
    const updated = await fetchOdooQuotationById(userId, quotationId);
    if (!updated) {
        throw new Error('Quotation was cancelled but could not be reloaded.');
    }
    return updated;
}
/**
 * Confirm a quotation in Odoo (`action_confirm`) → Sales Order.
 * Allowed for `draft` (Quotation) and `sent` (Quotation Sent).
 */
export async function confirmOdooQuotation(userId, quotationId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const existing = await fetchOdooQuotationById(userId, quotationId);
    if (!existing) {
        throw new Error('Quotation not found.');
    }
    const state = String(existing.state || '');
    if (state !== 'draft' && state !== 'sent') {
        throw new Error('Only quotations in Quotation or Quotation Sent status can be confirmed.');
    }
    try {
        await odooCallKw(session.cookie, 'sale.order', 'action_confirm', [
            [quotationId],
        ]);
    }
    catch (cookieError) {
        try {
            await odooExecuteKw(session.uid, 'sale.order', 'action_confirm', [
                [quotationId],
            ]);
        }
        catch {
            throw cookieError instanceof Error
                ? cookieError
                : new Error('Failed to confirm quotation in Odoo.');
        }
    }
    const updated = await fetchOdooQuotationById(userId, quotationId);
    if (!updated) {
        throw new Error('Quotation was confirmed but could not be reloaded.');
    }
    return updated;
}
const VALIDATABLE_PICKING_STATES = new Set([
    'draft',
    'waiting',
    'confirmed',
    'assigned',
]);
function pickingStateLabel(state) {
    switch (state) {
        case 'draft':
            return 'Draft';
        case 'waiting':
        case 'confirmed':
            return 'Waiting';
        case 'assigned':
            return 'Ready';
        case 'done':
            return 'Done';
        case 'cancel':
            return 'Cancelled';
        default:
            return state || '—';
    }
}
export function saleOrderHasValidatableDelivery(pickings) {
    return pickings.some(p => VALIDATABLE_PICKING_STATES.has(String(p.state || '')));
}
/**
 * Batch: which sale orders have at least one outgoing picking ready to validate.
 * One Odoo search for list enrichment (avoids N+1).
 */
export async function fetchSaleOrderIdsWithValidatableDelivery(userId, saleOrderIds) {
    const ready = new Set();
    const ids = saleOrderIds.filter(id => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
        return ready;
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const validStates = Array.from(VALIDATABLE_PICKING_STATES);
    try {
        const rows = await searchReadOdooRecords(session, 'stock.picking', [
            ['sale_id', 'in', ids],
            ['picking_type_code', '=', 'outgoing'],
            ['state', 'in', validStates],
        ], ['id', 'sale_id', 'state'], { limit: Math.min(ids.length * 5, 2000) });
        for (const row of rows) {
            const saleId = odooRelationId(row.sale_id);
            if (saleId) {
                ready.add(saleId);
            }
        }
        return ready;
    }
    catch {
        // Some DBs lack sale_id / picking_type_code — fall back to origin match.
    }
    try {
        const orders = await searchReadOdooRecords(session, 'sale.order', [['id', 'in', ids]], ['id', 'name'], {
            limit: ids.length,
        });
        const nameById = new Map(orders.map(row => [row.id, odooString(row.name)]));
        const names = [...nameById.values()].filter(Boolean);
        if (names.length === 0) {
            return ready;
        }
        const pickings = await searchReadOdooRecords(session, 'stock.picking', [
            ['origin', 'in', names],
            ['state', 'in', validStates],
        ], ['id', 'origin', 'state', 'picking_type_code'], { limit: Math.min(ids.length * 5, 2000) });
        const idByName = new Map([...nameById.entries()].map(([id, name]) => [name, id]));
        for (const picking of pickings) {
            const code = picking.picking_type_code;
            if (code && code !== 'outgoing') {
                continue;
            }
            const origin = odooString(picking.origin);
            const saleId = idByName.get(origin);
            if (saleId) {
                ready.add(saleId);
            }
        }
    }
    catch {
        return ready;
    }
    return ready;
}
/** Outgoing deliveries linked to a confirmed sale order. */
export async function fetchOdooOutgoingPickingsForOrder(userId, saleOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const fields = [
        'id',
        'name',
        'state',
        'picking_type_code',
        'scheduled_date',
        'date_done',
        'partner_id',
        'origin',
    ];
    const isOutgoing = (row) => {
        const code = row.picking_type_code;
        return !code || code === 'outgoing';
    };
    try {
        const bySaleId = await searchReadOdooRecords(session, 'stock.picking', [
            ['sale_id', '=', saleOrderId],
            ['picking_type_code', '=', 'outgoing'],
        ], fields, { order: 'id asc', limit: 50 });
        if (bySaleId.length > 0) {
            return bySaleId;
        }
    }
    catch {
        // sale_id / picking_type_code may differ by Odoo version — fall through.
    }
    // Some DBs omit picking_type_code on search — retry sale_id only.
    try {
        const bySaleIdAny = await searchReadOdooRecords(session, 'stock.picking', [['sale_id', '=', saleOrderId]], fields, { order: 'id asc', limit: 50 });
        const outgoing = bySaleIdAny.filter(isOutgoing);
        if (outgoing.length > 0) {
            return outgoing;
        }
    }
    catch {
        // fall through
    }
    try {
        const saleOrder = await readOdooRecordAsUser(session, 'sale.order', saleOrderId, [
            'name',
            'picking_ids',
            'delivery_count',
        ]);
        const pickingIds = Array.isArray(saleOrder?.picking_ids)
            ? saleOrder.picking_ids
            : [];
        if (pickingIds.length > 0) {
            const rows = await searchReadOdooRecords(session, 'stock.picking', [['id', 'in', pickingIds]], fields, { order: 'id asc', limit: 50 });
            const outgoing = rows.filter(isOutgoing);
            if (outgoing.length > 0) {
                return outgoing;
            }
        }
        // Odoo online smart button also matches Source Document = SO name.
        const origin = odooString(saleOrder?.name);
        if (origin) {
            const byOrigin = await searchReadOdooRecords(session, 'stock.picking', [['origin', '=', origin]], fields, { order: 'id asc', limit: 50 });
            const outgoing = byOrigin.filter(isOutgoing);
            if (outgoing.length > 0) {
                return outgoing;
            }
        }
    }
    catch {
        return [];
    }
    return [];
}
async function searchStockMoves(session, domain) {
    const baseFields = [
        'id',
        'name',
        'picking_id',
        'product_id',
        'product_uom_qty',
        'product_uom',
    ];
    // Odoo 17+ uses `quantity`; older versions use `quantity_done`.
    // Never request both — unknown fields make the whole read fail.
    try {
        return await searchReadOdooRecords(session, 'stock.move', domain, [...baseFields, 'quantity'], { order: 'id asc', limit: 2000 });
    }
    catch {
        try {
            return await searchReadOdooRecords(session, 'stock.move', domain, [...baseFields, 'quantity_done'], { order: 'id asc', limit: 2000 });
        }
        catch {
            try {
                return await searchReadOdooRecords(session, 'stock.move', domain, baseFields, { order: 'id asc', limit: 2000 });
            }
            catch {
                return [];
            }
        }
    }
}
async function fetchOdooMovesForPickings(session, pickingIds) {
    const byPicking = new Map();
    if (pickingIds.length === 0) {
        return byPicking;
    }
    let rows = await searchStockMoves(session, [
        ['picking_id', 'in', pickingIds],
    ]);
    // Some databases link moves only via picking.move_ids; recover those.
    if (rows.length === 0) {
        try {
            const pickings = await searchReadOdooRecords(session, 'stock.picking', [['id', 'in', pickingIds]], ['id', 'move_ids'], {
                limit: pickingIds.length,
            });
            for (const picking of pickings) {
                const moveIds = Array.isArray(picking.move_ids) ? picking.move_ids : [];
                if (moveIds.length === 0) {
                    continue;
                }
                const moves = await searchStockMoves(session, [['id', 'in', moveIds]]);
                if (moves.length > 0) {
                    byPicking.set(picking.id, moves);
                }
            }
            if (byPicking.size > 0) {
                return byPicking;
            }
        }
        catch {
            // keep empty — caller may fall back to sale order lines
        }
    }
    for (const row of rows) {
        const pickingId = odooRelationId(row.picking_id);
        if (!pickingId) {
            continue;
        }
        const list = byPicking.get(pickingId) ?? [];
        list.push(row);
        byPicking.set(pickingId, list);
    }
    return byPicking;
}
function mapDeliveryPreviewLine(move) {
    const demand = Number(move.product_uom_qty);
    const doneQty = Number(move.quantity);
    const legacyDone = Number(move.quantity_done);
    const safeDemand = Number.isFinite(demand) ? demand : 0;
    const quantity = Number.isFinite(doneQty) && doneQty > 0
        ? doneQty
        : Number.isFinite(legacyDone) && legacyDone > 0
            ? legacyDone
            : safeDemand;
    const product = odooRelationLabel(move.product_id) ||
        odooString(move.name) ||
        '—';
    return {
        id: String(move.id),
        product,
        demand: safeDemand,
        quantity,
        unit: odooRelationLabel(move.product_uom) || 'Units',
    };
}
function mapSaleOrderLinesAsDeliveryLines(lines) {
    return lines.map(line => {
        const qty = Number(line.product_uom_qty);
        const safeQty = Number.isFinite(qty) ? qty : 0;
        return {
            id: `sol-${line.id}`,
            product: odooRelationLabel(line.product_id) ||
                odooString(line.name) ||
                '—',
            demand: safeQty,
            quantity: safeQty,
            unit: odooRelationLabel(line.product_uom_id) || 'Units',
        };
    });
}
function mapDeliveryPreview(picking, moves, fallbackLines = []) {
    const state = String(picking.state || '');
    const lines = moves.length > 0
        ? moves.map(mapDeliveryPreviewLine)
        : fallbackLines;
    return {
        id: String(picking.id),
        name: odooString(picking.name) || `Picking ${picking.id}`,
        state,
        stateLabel: pickingStateLabel(state),
        scheduledDate: odooString(picking.scheduled_date),
        effectiveDate: odooString(picking.date_done),
        partner: odooRelationLabel(picking.partner_id),
        origin: odooString(picking.origin),
        canValidate: VALIDATABLE_PICKING_STATES.has(state),
        lines,
    };
}
/**
 * Odoo-style delivery preview for a sale order: pickings + Product/Qty lines
 * (same as clicking Delivery on the online Odoo sale → WH/OUT/…).
 * Falls back to sale order lines when stock moves are missing.
 */
export async function fetchOdooDeliveryPreviewsForOrder(userId, saleOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const pickings = await fetchOdooOutgoingPickingsForOrder(userId, saleOrderId);
    if (pickings.length === 0) {
        return [];
    }
    const movesByPicking = await fetchOdooMovesForPickings(session, pickings.map(p => p.id));
    const needsFallback = pickings.some(picking => (movesByPicking.get(picking.id) ?? []).length === 0);
    const fallbackLines = needsFallback
        ? mapSaleOrderLinesAsDeliveryLines(await fetchOdooSaleOrderLines(userId, saleOrderId))
        : [];
    return pickings.map(picking => mapDeliveryPreview(picking, movesByPicking.get(picking.id) ?? [], fallbackLines));
}
async function callPickingMethod(session, method, args, kwargs = {}) {
    try {
        return await odooCallKw(session.cookie, 'stock.picking', method, args, kwargs);
    }
    catch (cookieError) {
        try {
            return await odooExecuteKw(session.uid, 'stock.picking', method, args, kwargs);
        }
        catch {
            throw cookieError instanceof Error
                ? cookieError
                : new Error(`Failed to ${method} delivery in Odoo.`);
        }
    }
}
async function writeStockRecord(session, model, recordId, values) {
    try {
        await writeOdooRecord(session, model, recordId, values);
    }
    catch {
        await odooExecuteKw(session.uid, model, 'write', [[recordId], values]);
    }
}
/** Fill done quantities so Validate can complete without the Odoo UI wizard. */
async function fillPickingDoneQuantities(session, pickingId) {
    let moves = [];
    // Odoo 17+ uses `quantity`; older versions use `quantity_done`.
    try {
        moves = await searchReadOdooRecords(session, 'stock.move', [['picking_id', '=', pickingId]], ['id', 'product_uom_qty', 'quantity'], { limit: 500 });
    }
    catch {
        try {
            moves = await searchReadOdooRecords(session, 'stock.move', [['picking_id', '=', pickingId]], ['id', 'product_uom_qty', 'quantity_done'], { limit: 500 });
        }
        catch {
            moves = await searchReadOdooRecords(session, 'stock.move', [['picking_id', '=', pickingId]], ['id', 'product_uom_qty'], { limit: 500 });
        }
    }
    for (const move of moves) {
        const qty = Number(move.product_uom_qty);
        if (!Number.isFinite(qty) || qty <= 0) {
            continue;
        }
        try {
            await writeStockRecord(session, 'stock.move', move.id, { quantity: qty });
        }
        catch {
            try {
                await writeStockRecord(session, 'stock.move', move.id, {
                    quantity_done: qty,
                });
            }
            catch {
                // Move-line fallback below.
            }
        }
    }
    try {
        const lines = await searchReadOdooRecords(session, 'stock.move.line', [['picking_id', '=', pickingId]], ['id', 'qty_done', 'quantity', 'product_uom_qty'], { limit: 500 });
        for (const line of lines) {
            const target = Number(line.product_uom_qty) ||
                Number(line.quantity) ||
                Number(line.qty_done);
            if (!Number.isFinite(target) || target <= 0) {
                continue;
            }
            try {
                await writeStockRecord(session, 'stock.move.line', line.id, {
                    qty_done: target,
                });
            }
            catch {
                await writeStockRecord(session, 'stock.move.line', line.id, {
                    quantity: target,
                });
            }
        }
    }
    catch {
        // Some databases only track qty on stock.move.
    }
}
async function processStockValidateWizard(session, action) {
    const model = String(action.res_model || '');
    if (!model) {
        return;
    }
    let wizardId = Number(action.res_id);
    if (!Number.isFinite(wizardId) || wizardId <= 0) {
        try {
            wizardId = await odooCallKw(session.cookie, model, 'create', [{}], { context: action.context ?? {} });
        }
        catch {
            wizardId = await odooExecuteKw(session.uid, model, 'create', [{}], { context: action.context ?? {} });
        }
    }
    const methods = model === 'stock.backorder.confirmation'
        ? ['process_cancel_backorder', 'process']
        : ['process', 'action_confirm'];
    let lastError;
    for (const method of methods) {
        try {
            await odooCallKw(session.cookie, model, method, [[wizardId]]);
            return;
        }
        catch (error) {
            lastError = error;
            try {
                await odooExecuteKw(session.uid, model, method, [[wizardId]]);
                return;
            }
            catch (execError) {
                lastError = execError;
            }
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error('Failed to complete delivery validation wizard in Odoo.');
}
async function validateOdooPicking(session, pickingId) {
    await fillPickingDoneQuantities(session, pickingId);
    const result = await callPickingMethod(session, 'button_validate', [[pickingId]], {
        context: {
            skip_sms: true,
            skip_immediate: true,
            skip_backorder: true,
        },
    });
    if (result === true || result === false || result == null) {
        return;
    }
    if (typeof result === 'object') {
        await processStockValidateWizard(session, result);
    }
}
/**
 * Validate outgoing delivery(s) for a confirmed sale order
 * (`stock.picking` → `button_validate`).
 */
export async function validateOdooSaleOrderDelivery(userId, saleOrderId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const existing = await fetchOdooSaleOrderById(userId, saleOrderId);
    if (!existing) {
        throw new Error('Sale order not found.');
    }
    const state = String(existing.state || '');
    if (state !== 'sale' && state !== 'done') {
        throw new Error('Only confirmed sales orders can have their delivery validated.');
    }
    const pickings = await fetchOdooOutgoingPickingsForOrder(userId, saleOrderId);
    let pending = pickings.filter(p => VALIDATABLE_PICKING_STATES.has(String(p.state || '')));
    const pickingId = options?.pickingId;
    if (pickingId && Number.isFinite(pickingId) && pickingId > 0) {
        pending = pending.filter(p => p.id === pickingId);
        if (pending.length === 0) {
            const target = pickings.find(p => p.id === pickingId);
            if (!target) {
                throw new Error('Delivery not found for this order.');
            }
            if (String(target.state) === 'done') {
                throw new Error('Delivery is already validated.');
            }
            throw new Error('This delivery is not ready to validate.');
        }
    }
    if (pending.length === 0) {
        if (pickings.length > 0 && pickings.every(p => String(p.state) === 'done')) {
            throw new Error('Delivery is already validated.');
        }
        throw new Error('No delivery is ready to validate for this order.');
    }
    for (const picking of pending) {
        await validateOdooPicking(session, picking.id);
    }
    const bundle = await fetchOdooSaleOrderDetailBundle(userId, saleOrderId);
    if (!bundle) {
        throw new Error('Delivery was validated but the sale order could not be reloaded.');
    }
    const refreshedPickings = await fetchOdooOutgoingPickingsForOrder(userId, saleOrderId);
    return {
        ...bundle,
        pickings: refreshedPickings,
    };
}
export function saleOrderCanCreateInvoice(order) {
    const state = String(order.state || '');
    const invoiceStatus = String(order.invoice_status || '');
    return ((state === 'sale' || state === 'done') && invoiceStatus === 'to invoice');
}
async function createInvoicesViaAdvanceWizard(session, saleOrderId) {
    const context = {
        active_model: 'sale.order',
        active_ids: [saleOrderId],
        active_id: saleOrderId,
    };
    let wizardId;
    try {
        wizardId = await odooCallKw(session.cookie, 'sale.advance.payment.inv', 'create', [{ advance_payment_method: 'delivered' }], { context });
    }
    catch {
        wizardId = await odooExecuteKw(session.uid, 'sale.advance.payment.inv', 'create', [{ advance_payment_method: 'delivered' }], { context });
    }
    try {
        await odooCallKw(session.cookie, 'sale.advance.payment.inv', 'create_invoices', [[wizardId]], { context });
    }
    catch (cookieError) {
        try {
            await odooExecuteKw(session.uid, 'sale.advance.payment.inv', 'create_invoices', [[wizardId]], { context });
        }
        catch {
            throw cookieError instanceof Error
                ? cookieError
                : new Error('Failed to create invoice in Odoo.');
        }
    }
}
/**
 * Create customer invoice(s) for a confirmed sale order
 * (`sale.order` → `_create_invoices` / `sale.advance.payment.inv`).
 */
export async function createOdooSaleOrderInvoice(userId, saleOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const existing = await fetchOdooSaleOrderById(userId, saleOrderId);
    if (!existing) {
        throw new Error('Sale order not found.');
    }
    const state = String(existing.state || '');
    if (state !== 'sale' && state !== 'done') {
        throw new Error('Only confirmed sales orders can be invoiced.');
    }
    if (!saleOrderCanCreateInvoice(existing)) {
        const invoiceStatus = String(existing.invoice_status || '');
        if (invoiceStatus === 'invoiced') {
            throw new Error('This order is already fully invoiced.');
        }
        if (invoiceStatus === 'no') {
            throw new Error('Nothing to invoice on this order.');
        }
        throw new Error('This order is not ready to invoice yet.');
    }
    let createError;
    try {
        await odooCallKw(session.cookie, 'sale.order', '_create_invoices', [
            [saleOrderId],
        ]);
    }
    catch (directError) {
        createError = directError;
        try {
            await odooExecuteKw(session.uid, 'sale.order', '_create_invoices', [
                [saleOrderId],
            ]);
            createError = undefined;
        }
        catch {
            try {
                await createInvoicesViaAdvanceWizard(session, saleOrderId);
                createError = undefined;
            }
            catch (wizardError) {
                createError = wizardError ?? directError;
            }
        }
    }
    if (createError) {
        throw createError instanceof Error
            ? createError
            : new Error('Failed to create invoice in Odoo.');
    }
    const bundle = await fetchOdooSaleOrderDetailBundle(userId, saleOrderId);
    if (!bundle) {
        throw new Error('Invoice was created but the sale order could not be reloaded.');
    }
    const pickings = await fetchOdooOutgoingPickingsForOrder(userId, saleOrderId);
    let invoiceName = '';
    try {
        const invoices = await searchReadOdooRecords(session, 'account.move', [
            ['invoice_origin', '=', odooString(existing.name)],
            ['move_type', '=', 'out_invoice'],
        ], ['id', 'name'], { order: 'id desc', limit: 5 });
        invoiceName = invoices
            .map(row => odooString(row.name))
            .filter(Boolean)
            .join(', ');
    }
    catch {
        // Name is optional for the UI snackbar.
    }
    return {
        ...bundle,
        pickings,
        invoiceName,
    };
}
function invoiceStateLabel(state) {
    switch (state) {
        case 'draft':
            return 'Draft';
        case 'posted':
            return 'Posted';
        case 'cancel':
            return 'Cancelled';
        default:
            return state || '—';
    }
}
function invoicePaymentStateLabel(paymentState) {
    switch (paymentState) {
        case 'not_paid':
            return 'Not Paid';
        case 'in_payment':
            return 'In Payment';
        case 'paid':
            return 'Paid';
        case 'partial':
            return 'Partially Paid';
        case 'reversed':
            return 'Reversed';
        default:
            return paymentState || '—';
    }
}
async function loadOdooInvoiceRowsForOrder(userId, saleOrderId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    let orderName = options?.orderName?.trim() || '';
    let invoiceIds = [];
    try {
        const saleOrder = await readOdooRecordAsUser(session, 'sale.order', saleOrderId, ['name', 'invoice_ids']);
        if (saleOrder) {
            orderName = orderName || odooString(saleOrder.name);
            invoiceIds = Array.isArray(saleOrder.invoice_ids)
                ? saleOrder.invoice_ids
                : [];
        }
    }
    catch {
        // Fall through to origin search.
    }
    const fields = [
        'id',
        'name',
        'state',
        'payment_state',
        'amount_residual',
        'amount_untaxed',
        'amount_total',
        'currency_id',
        'invoice_date',
        'partner_id',
        'invoice_origin',
        'invoice_line_ids',
    ];
    try {
        if (invoiceIds.length > 0) {
            return await searchReadOdooRecords(session, 'account.move', [
                ['id', 'in', invoiceIds],
                ['move_type', '=', 'out_invoice'],
            ], fields, { order: 'id asc', limit: 50 });
        }
        if (orderName) {
            return await searchReadOdooRecords(session, 'account.move', [
                ['invoice_origin', '=', orderName],
                ['move_type', '=', 'out_invoice'],
            ], fields, { order: 'id asc', limit: 50 });
        }
    }
    catch {
        return [];
    }
    return [];
}
async function fetchOdooInvoiceLinesByMove(session, moveIds) {
    const map = new Map();
    if (moveIds.length === 0) {
        return map;
    }
    try {
        const rows = await searchReadOdooRecords(session, 'account.move.line', [
            ['move_id', 'in', moveIds],
            ['display_type', 'not in', ['line_section', 'line_note']],
            ['exclude_from_invoice_tab', '=', false],
        ], [
            'id',
            'name',
            'product_id',
            'quantity',
            'price_unit',
            'price_subtotal',
            'product_uom_id',
            'display_type',
            'move_id',
        ], { order: 'id asc', limit: 2000 });
        for (const row of rows) {
            const moveId = Array.isArray(row.move_id) ? Number(row.move_id[0]) : 0;
            if (!Number.isFinite(moveId) || moveId <= 0) {
                continue;
            }
            const list = map.get(moveId) ?? [];
            list.push(row);
            map.set(moveId, list);
        }
    }
    catch {
        // Older DBs may lack exclude_from_invoice_tab — retry without it.
        try {
            const rows = await searchReadOdooRecords(session, 'account.move.line', [
                ['move_id', 'in', moveIds],
                ['display_type', 'not in', ['line_section', 'line_note']],
            ], [
                'id',
                'name',
                'product_id',
                'quantity',
                'price_unit',
                'price_subtotal',
                'product_uom_id',
                'display_type',
                'move_id',
            ], { order: 'id asc', limit: 2000 });
            for (const row of rows) {
                const moveId = Array.isArray(row.move_id) ? Number(row.move_id[0]) : 0;
                if (!Number.isFinite(moveId) || moveId <= 0) {
                    continue;
                }
                // Skip pure accounting lines (no product and zero qty).
                const qty = Number(row.quantity);
                const hasProduct = Array.isArray(row.product_id);
                if (!hasProduct && !(Number.isFinite(qty) && qty !== 0)) {
                    continue;
                }
                const list = map.get(moveId) ?? [];
                list.push(row);
                map.set(moveId, list);
            }
        }
        catch {
            return map;
        }
    }
    return map;
}
function mapInvoicePreviewLine(line) {
    return {
        id: String(line.id),
        product: odooRelationLabel(line.product_id) ||
            odooString(line.name) ||
            `Line ${line.id}`,
        quantity: Number(line.quantity) || 0,
        unitPrice: Number(line.price_unit) || 0,
        amount: Number(line.price_subtotal) || 0,
        unit: odooRelationLabel(line.product_uom_id) || 'Units',
    };
}
function mapInvoicePreview(row, lines) {
    const state = String(row.state || '');
    const paymentState = odooString(row.payment_state);
    const residual = Number(row.amount_residual) || 0;
    return {
        id: String(row.id),
        name: odooString(row.name) || `Invoice ${row.id}`,
        state,
        stateLabel: invoiceStateLabel(state),
        paymentState,
        paymentStateLabel: invoicePaymentStateLabel(paymentState),
        invoiceDate: odooString(row.invoice_date),
        partner: odooRelationLabel(row.partner_id),
        origin: odooString(row.invoice_origin),
        amountUntaxed: Number(row.amount_untaxed) || 0,
        amountTotal: Number(row.amount_total) || 0,
        amountResidual: residual,
        currency: odooRelationLabel(row.currency_id),
        canPay: state === 'posted' && residual > 0.0001,
        lines: lines.map(mapInvoicePreviewLine),
    };
}
/** Customer invoices for a sale order (Odoo Invoice smart button). */
export async function fetchOdooInvoicePreviewsForOrder(userId, saleOrderId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const rows = (await loadOdooInvoiceRowsForOrder(userId, saleOrderId, options)).filter(row => String(row.state || '') !== 'cancel');
    if (rows.length === 0) {
        return [];
    }
    const linesByMove = await fetchOdooInvoiceLinesByMove(session, rows.map(row => row.id));
    return rows.map(row => mapInvoicePreview(row, linesByMove.get(row.id) ?? []));
}
/** Open customer invoices for a sale order (amount still due). */
export async function fetchOdooPayableInvoicesForOrder(userId, saleOrderId, options) {
    const rows = await loadOdooInvoiceRowsForOrder(userId, saleOrderId, options);
    return rows
        .filter(row => {
        if (String(row.state || '') === 'cancel') {
            return false;
        }
        const residual = Number(row.amount_residual);
        return Number.isFinite(residual) && residual > 0.0001;
    })
        .map(row => ({
        id: String(row.id),
        name: odooString(row.name) || `Invoice ${row.id}`,
        amountResidual: Number(row.amount_residual) || 0,
        amountTotal: Number(row.amount_total) || 0,
        currency: odooRelationLabel(row.currency_id),
        state: String(row.state || ''),
        paymentState: odooString(row.payment_state),
    }));
}
export function saleOrderCanPayInvoice(invoices) {
    return invoices.length > 0;
}
export async function enrichSaleOrderActionFlags(userId, saleOrderId, saleOrder) {
    const orderName = odooString(saleOrder.name);
    const [pickings, invoices] = await Promise.all([
        fetchOdooOutgoingPickingsForOrder(userId, saleOrderId),
        fetchOdooInvoicePreviewsForOrder(userId, saleOrderId, { orderName }),
    ]);
    const payable = invoices.filter(inv => inv.canPay);
    const first = payable[0];
    return {
        canValidateDelivery: saleOrderHasValidatableDelivery(pickings),
        deliveryCount: pickings.length,
        invoiceCount: invoices.length,
        // Odoo: Create Invoice only on confirmed SO (sale/done) with qty to invoice.
        canCreateInvoice: saleOrderCanCreateInvoice(saleOrder),
        canPayInvoice: saleOrderCanPayInvoice(payable.map(inv => ({
            id: inv.id,
            name: inv.name,
            amountResidual: inv.amountResidual,
            amountTotal: inv.amountTotal,
            currency: inv.currency,
            state: inv.state,
            paymentState: inv.paymentState,
        }))),
        payableInvoice: first
            ? {
                id: first.id,
                name: first.name,
                amountResidual: first.amountResidual,
                currency: first.currency,
            }
            : undefined,
        pickings,
    };
}
async function postOdooInvoiceIfDraft(session, invoiceId) {
    try {
        await odooCallKw(session.cookie, 'account.move', 'action_post', [
            [invoiceId],
        ]);
    }
    catch (cookieError) {
        try {
            await odooExecuteKw(session.uid, 'account.move', 'action_post', [
                [invoiceId],
            ]);
        }
        catch {
            throw cookieError instanceof Error
                ? cookieError
                : new Error('Failed to post invoice in Odoo.');
        }
    }
}
/**
 * Post unpaid invoices (if draft) and register full payment
 * via `account.payment.register`.
 */
export async function payOdooSaleOrderInvoice(userId, saleOrderId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const existing = await fetchOdooSaleOrderById(userId, saleOrderId);
    if (!existing) {
        throw new Error('Sale order not found.');
    }
    const state = String(existing.state || '');
    if (state !== 'sale' && state !== 'done') {
        throw new Error('Only confirmed sales orders can be paid.');
    }
    const payable = await fetchOdooPayableInvoicesForOrder(userId, saleOrderId, { orderName: odooString(existing.name) });
    if (payable.length === 0) {
        throw new Error('No unpaid invoice found for this order.');
    }
    for (const invoice of payable) {
        if (invoice.state === 'draft') {
            await postOdooInvoiceIfDraft(session, Number(invoice.id));
        }
    }
    const invoiceIds = payable.map(inv => Number(inv.id));
    const context = {
        active_model: 'account.move',
        active_ids: invoiceIds,
        active_id: invoiceIds[0],
    };
    const wizardValues = {};
    const methodLineId = options?.paymentMethodLineId;
    if (methodLineId !== undefined &&
        Number.isFinite(methodLineId) &&
        methodLineId > 0) {
        wizardValues.payment_method_line_id = methodLineId;
        try {
            const methodLine = await readOdooRecordAsUser(session, 'account.payment.method.line', methodLineId, [
                'journal_id',
            ]);
            const journalId = odooRelationId(methodLine?.journal_id);
            if (journalId) {
                wizardValues.journal_id = journalId;
            }
        }
        catch {
            // Journal is optional; Odoo may infer it from the method line.
        }
    }
    let wizardId;
    try {
        wizardId = await odooCallKw(session.cookie, 'account.payment.register', 'create', [wizardValues], { context });
    }
    catch {
        wizardId = await odooExecuteKw(session.uid, 'account.payment.register', 'create', [wizardValues], { context });
    }
    try {
        await odooCallKw(session.cookie, 'account.payment.register', 'action_create_payments', [[wizardId]], { context });
    }
    catch (cookieError) {
        try {
            await odooExecuteKw(session.uid, 'account.payment.register', 'action_create_payments', [[wizardId]], { context });
        }
        catch {
            throw cookieError instanceof Error
                ? cookieError
                : new Error('Failed to register payment in Odoo.');
        }
    }
    const bundle = await fetchOdooSaleOrderDetailBundle(userId, saleOrderId);
    if (!bundle) {
        throw new Error('Payment was registered but the sale order could not be reloaded.');
    }
    const pickings = await fetchOdooOutgoingPickingsForOrder(userId, saleOrderId);
    const invoiceName = payable.map(inv => inv.name).filter(Boolean).join(', ');
    const totalPaid = payable.reduce((sum, inv) => sum + inv.amountResidual, 0);
    const currency = payable[0]?.currency || '';
    return {
        ...bundle,
        pickings,
        invoiceName,
        paymentLabel: currency
            ? `${currency} ${totalPaid.toLocaleString()}`
            : totalPaid.toLocaleString(),
    };
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
        customer_rank: isChildAddress ? 0 : input.asVendor ? 0 : 1,
    };
    if (input.asVendor && !isChildAddress) {
        values.supplier_rank = 1;
        // Keep customer_rank too so vendor still appears in Contacts list filters.
        values.customer_rank = 1;
    }
    if (typeof input.isCompany === 'boolean') {
        values.is_company = input.isCompany;
    }
    else if (input.asVendor && !isChildAddress) {
        values.is_company = true;
    }
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
    const vat = input.vat?.trim();
    if (vat) {
        values.vat = vat;
    }
    const website = input.website?.trim();
    if (website) {
        values.website = website;
    }
    const jobPosition = input.jobPosition?.trim();
    if (jobPosition) {
        values.function = jobPosition;
    }
    const expoPushToken = input.expoPushToken?.trim();
    if (expoPushToken) {
        values.x_studio_expo_push_token = expoPushToken;
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
async function assertOdooPartnerEmailAvailable(session, partnerId, email) {
    const trimmed = String(email ?? '').trim();
    if (!trimmed) {
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new Error('Please enter a valid email.');
    }
    const users = await searchReadOdooRecords(session, 'res.users', ['|', ['login', '=ilike', trimmed], ['email', '=ilike', trimmed]], ['id', 'partner_id'], { limit: 10 });
    for (const row of users) {
        const linkedPartnerId = odooRelationId(row.partner_id);
        if (linkedPartnerId > 0 && linkedPartnerId !== partnerId) {
            throw new Error('This email is already registered.');
        }
    }
}
export async function updateOdooContact(userId, partnerId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        throw new Error('Invalid contact id.');
    }
    const partner = await fetchOdooContactById(userId, partnerId);
    if (!partner) {
        throw new Error('Contact not found.');
    }
    const name = input.name.trim();
    if (!name) {
        throw new Error('Name is required.');
    }
    const phone = input.phone.trim();
    if (!phone) {
        throw new Error('Phone number is required.');
    }
    const existingByPhone = await searchOdooContactsByPhone(userId, phone);
    const duplicatePhone = existingByPhone.some(row => row.id !== partnerId);
    if (duplicatePhone) {
        throw new Error('A contact with this phone number already exists. Use a different phone number.');
    }
    if (!Number.isFinite(input.townshipId) ||
        input.townshipId <= 0) {
        throw new Error('Township is required.');
    }
    const email = input.email?.trim() ?? '';
    if (email) {
        await assertOdooPartnerEmailAvailable(session, partnerId, email);
    }
    const tagIds = await resolveOdooPartnerTagIds(userId, {
        tagIds: input.tagIds,
    });
    const values = {
        name,
        phone,
        street: input.street?.trim() || false,
        street2: input.street2?.trim() || false,
        email: email || false,
        [PARTNER_TOWNSHIP_FIELD]: input.townshipId,
        category_id: [[6, 0, tagIds]],
    };
    await writeOdooRecordAsUser(session, 'res.partner', partnerId, values);
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
export async function fetchOdooPartnerAddress(userId, partnerId, options) {
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        return { formatted: '', phone: '' };
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const partner = await readOdooRecordAsUser(session, 'res.partner', partnerId, PARTNER_ADDRESS_FIELDS);
    if (!partner) {
        return { formatted: '', phone: '' };
    }
    // Township many2one already includes [id, name] — skip extra township
    // record fetch unless a caller needs postal/state enrichment.
    const township = options?.resolveTownship === false
        ? null
        : await fetchOdooTownshipForPartner(userId, partner);
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
    // Cookie session only — avoids API-key attempt latency on the detail path.
    return odooCallKw(session.cookie, 'sale.order.line', 'search_read', [
        [['order_id', '=', quotationId]],
        ORDER_LINE_FIELDS,
    ], { order: 'sequence asc, id asc' });
}
export async function fetchOdooContacts(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const fields = [
        ...CONTACT_BASE_FIELDS,
        ...Object.keys(CONTACT_CUSTOM_FIELDS),
        ...CONTACT_EXTRA_FIELDS,
    ];
    const domain = options?.suppliersOnly
        ? [['supplier_rank', '>', 0]]
        : [];
    // Odoo search_read is capped per call; page until exhausted so Contacts
    // is not stuck at the old hard limit of 1000.
    const pageSize = 500;
    const maxPages = 100;
    const all = [];
    for (let page = 0; page < maxPages; page += 1) {
        const rows = await searchReadOdooRecords(session, 'res.partner', domain, fields, {
            order: 'name asc',
            limit: pageSize,
            offset: page * pageSize,
        });
        if (!rows.length) {
            break;
        }
        all.push(...rows);
        if (rows.length < pageSize) {
            break;
        }
    }
    return all;
}
/** Lean contact list for New Quotation / New Purchase — fewer fields. */
export async function fetchOdooContactsForQuotation(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const fields = [...CONTACT_BASE_FIELDS, PARTNER_TOWNSHIP_FIELD];
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 500;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const q = String(options?.q ?? '').trim();
    const domain = options?.suppliersOnly
        ? [['supplier_rank', '>', 0]]
        : [['customer_rank', '>', 0]];
    if (q) {
        const phoneClauses = [
            ['name', 'ilike', q],
            ['phone', 'ilike', q],
            ['email', 'ilike', q],
        ];
        const phoneNorm = normalizeMyanmarPhone(q);
        if (phoneNorm && phoneNorm !== q) {
            phoneClauses.push(['phone', 'ilike', phoneNorm]);
        }
        const last7 = lastPhoneDigits(q, 7);
        if (last7.length >= 7) {
            phoneClauses.push(['phone', 'ilike', last7]);
        }
        for (let i = 0; i < phoneClauses.length - 1; i += 1) {
            domain.push('|');
        }
        domain.push(...phoneClauses);
    }
    return searchReadOdooRecords(session, 'res.partner', domain, fields, {
        order: 'name asc',
        limit,
        offset,
    });
}
export async function fetchOdooContactById(userId, contactId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return readOdooRecord(session, 'res.partner', contactId, CONTACT_DETAIL_FIELDS);
}
/** Write App Promoter name on res.partner (Studio x_studio_app_promoter). */
export async function updateOdooPartnerAppPromoter(userId, partnerId, appPromoter) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        throw new Error('Invalid contact id.');
    }
    const name = String(appPromoter ?? '').trim();
    if (!name) {
        throw new Error('App Promoter is required.');
    }
    await writeOdooRecordAsUser(session, 'res.partner', partnerId, {
        [PARTNER_APP_PROMOTER_FIELD]: name,
    });
}
/** Write email on res.partner (required before portal grant). */
export async function updateOdooPartnerEmail(userId, partnerId, email) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        throw new Error('Invalid contact id.');
    }
    const trimmed = String(email ?? '').trim();
    if (!trimmed) {
        throw new Error('Please enter the email.');
    }
    const partner = await fetchOdooContactById(userId, partnerId);
    if (!partner) {
        throw new Error('Contact not found.');
    }
    await assertOdooPartnerEmailAvailable(session, partnerId, trimmed);
    await writeOdooRecordAsUser(session, 'res.partner', partnerId, {
        email: trimmed,
    });
}
async function resolveOdooPortalGroupId(session) {
    try {
        const rows = await searchReadOdooRecords(session, 'ir.model.data', [
            ['module', '=', 'base'],
            ['name', '=', 'group_portal'],
        ], ['res_id'], { limit: 1 });
        const resId = Number(rows[0]?.res_id);
        if (Number.isFinite(resId) && resId > 0) {
            return resId;
        }
    }
    catch {
        // fall through
    }
    try {
        const groups = await searchReadOdooRecords(session, 'res.groups', [['name', 'ilike', 'Portal']], ['id', 'name'], { limit: 20 });
        const exact = groups.find(row => String(row.name || '').trim().toLowerCase() === 'portal');
        const pick = exact ?? groups[0];
        if (pick?.id) {
            return pick.id;
        }
    }
    catch {
        // fall through
    }
    throw new Error('Could not find the Odoo Portal user group. Check Portal is installed.');
}
async function setOdooUserPassword(session, userId, password) {
    if (!password) {
        throw new Error('Password is required.');
    }
    await odooCallKw(session.cookie, 'res.users', 'write', [[userId], { password }], { context: { no_reset_password: true } });
}
/**
 * Odoo Online rejects writing `groups_id` on res.users via API.
 * Prefer portal.wizard.action_grant_access / _create_user_from_template.
 */
async function createOdooPortalUser(session, partnerId, email, name, password) {
    const createContext = {
        no_reset_password: true,
        mail_create_nosubscribe: true,
        mail_notrack: true,
    };
    // 1) Official Portal wizard (assigns portal group without groups_id write)
    try {
        const wizardId = await odooCallKw(session.cookie, 'portal.wizard', 'create', [{ partner_ids: [[6, 0, [partnerId]]] }], { context: createContext });
        let lines = await searchReadOdooRecords(session, 'portal.wizard.user', [['wizard_id', '=', wizardId]], ['id', 'email', 'partner_id'], { limit: 20 });
        if (lines.length === 0) {
            // Some Odoo versions only fill lines after writing partner_ids
            await odooCallKw(session.cookie, 'portal.wizard', 'write', [[wizardId], { partner_ids: [[6, 0, [partnerId]]] }], { context: createContext });
            lines = await searchReadOdooRecords(session, 'portal.wizard.user', [['wizard_id', '=', wizardId]], ['id', 'email', 'partner_id'], { limit: 20 });
        }
        const target = lines.find(row => odooRelationId(row.partner_id) === partnerId) ||
            lines[0];
        if (target?.id) {
            const lineEmail = odooString(target.email).trim();
            if (!lineEmail || lineEmail.toLowerCase() !== email.toLowerCase()) {
                await odooCallKw(session.cookie, 'portal.wizard.user', 'write', [[target.id], { email }], { context: createContext });
            }
            try {
                await odooCallKw(session.cookie, 'portal.wizard.user', 'action_grant_access', [[target.id]], { context: createContext });
            }
            catch {
                // Older / alternate method name
                await odooCallKw(session.cookie, 'portal.wizard', 'action_apply', [[wizardId]], { context: createContext });
            }
            const linked = await findOdooUsersForPartner(session, partnerId);
            const created = linked.find(row => {
                const login = odooString(row.login).toLowerCase();
                const userEmail = odooString(row.email).toLowerCase();
                const needle = email.toLowerCase();
                return login === needle || userEmail === needle;
            }) || linked[0];
            if (created?.id) {
                await setOdooUserPassword(session, created.id, password);
                return;
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lower = message.toLowerCase();
        if (lower.includes('already') ||
            lower.includes('unique') ||
            lower.includes('duplicate') ||
            lower.includes('exists')) {
            throw new Error('This email is already registered.');
        }
        // fall through to template create
    }
    // 2) Same path Portal uses internally (copies portal template groups)
    try {
        await odooCallKw(session.cookie, 'res.users', '_create_user_from_template', [
            {
                name,
                login: email,
                email,
                partner_id: partnerId,
                password,
            },
        ], { context: createContext });
        return;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lower = message.toLowerCase();
        if (lower.includes('already') ||
            lower.includes('unique') ||
            lower.includes('duplicate') ||
            lower.includes('exists')) {
            throw new Error('This email is already registered.');
        }
        // fall through
    }
    // 3) Last resort: create without groups_id, then try to link portal group
    const userId = await odooCallKw(session.cookie, 'res.users', 'create', [
        {
            name,
            login: email,
            email,
            partner_id: partnerId,
            password,
        },
    ], { context: createContext });
    try {
        const portalGroupId = await resolveOdooPortalGroupId(session);
        await odooCallKw(session.cookie, 'res.users', 'write', [[userId], { groups_id: [[4, portalGroupId]] }], { context: createContext });
    }
    catch {
        // Odoo Online may still block groups_id; user may be internal until fixed in Odoo.
        // Prefer not failing the grant if the login exists — password is already set.
    }
}
async function findOdooUsersByLoginOrEmail(session, email) {
    const login = email.trim().toLowerCase();
    return searchReadOdooRecords(session, 'res.users', ['|', ['login', '=ilike', login], ['email', '=ilike', login]], ['id', 'login', 'email', 'partner_id', 'share', 'active'], { limit: 10 });
}
async function findOdooUsersForPartner(session, partnerId) {
    return searchReadOdooRecords(session, 'res.users', [['partner_id', '=', partnerId]], ['id', 'login', 'email', 'partner_id', 'share', 'active'], { limit: 10 });
}
export async function fetchOdooPartnerPortalStatus(userId, partnerId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        throw new Error('Invalid contact id.');
    }
    const partner = await fetchOdooContactById(userId, partnerId);
    if (!partner) {
        throw new Error('Contact not found.');
    }
    const email = odooString(partner.email).trim();
    const hasEmail = Boolean(email);
    const linked = await findOdooUsersForPartner(session, partnerId);
    const portalLike = linked.find(row => row.share === true) ||
        linked.find(row => row.active !== false) ||
        linked[0];
    return {
        hasEmail,
        email,
        granted: Boolean(portalLike),
        login: portalLike
            ? odooString(portalLike.login) || odooString(portalLike.email) || email
            : '',
        userId: portalLike?.id ?? null,
    };
}
/**
 * Grant Odoo Portal access for a contact (external account).
 * Requires email on the contact; password set on the portal user.
 */
export async function grantOdooPartnerPortalAccess(userId, partnerId, password) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(partnerId) || partnerId <= 0) {
        throw new Error('Invalid contact id.');
    }
    const pwd = assertPortalPassword(password);
    const partner = await fetchOdooContactById(userId, partnerId);
    if (!partner) {
        throw new Error('Contact not found.');
    }
    const email = odooString(partner.email).trim();
    if (!email) {
        throw new Error('Please enter the email.');
    }
    const existingByEmail = await findOdooUsersByLoginOrEmail(session, email);
    const linkedUsers = await findOdooUsersForPartner(session, partnerId);
    for (const row of existingByEmail) {
        const linkedPartnerId = odooRelationId(row.partner_id);
        if (linkedPartnerId > 0 && linkedPartnerId !== partnerId) {
            throw new Error('This email is already registered.');
        }
    }
    const ownUser = linkedUsers.find(row => {
        const login = odooString(row.login).toLowerCase();
        const userEmail = odooString(row.email).toLowerCase();
        const needle = email.toLowerCase();
        return login === needle || userEmail === needle;
    }) ||
        existingByEmail.find(row => odooRelationId(row.partner_id) === partnerId) ||
        linkedUsers[0];
    if (ownUser?.id) {
        try {
            await setOdooUserPassword(session, ownUser.id, pwd);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to set portal password.';
            throw new Error(message);
        }
        return fetchOdooPartnerPortalStatus(userId, partnerId);
    }
    const name = odooString(partner.name) || email;
    try {
        await createOdooPortalUser(session, partnerId, email, name, pwd);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to grant portal access.';
        const lower = message.toLowerCase();
        if (lower.includes('already') ||
            lower.includes('unique') ||
            lower.includes('duplicate') ||
            lower.includes('exists')) {
            throw new Error('This email is already registered.');
        }
        throw new Error(message);
    }
    return fetchOdooPartnerPortalStatus(userId, partnerId);
}
/** Studio model: Contacts → App Promoter (rates). */
export const ODOO_APP_PROMOTER_MODEL = 'x_app_promoter';
export const ODOO_APP_PROMOTER_NAME_FIELD = 'x_name';
export const ODOO_APP_PROMOTER_AMOUNT_FIELD = 'x_studio_amount_per_customer';
/** Studio boolean on x_app_promoter (not x_studio_active). */
export const ODOO_APP_PROMOTER_ACTIVE_FIELD = 'x_active';
const ODOO_APP_PROMOTER_READ_FIELDS = [
    'id',
    ODOO_APP_PROMOTER_NAME_FIELD,
    ODOO_APP_PROMOTER_AMOUNT_FIELD,
    ODOO_APP_PROMOTER_ACTIVE_FIELD,
    'x_studio_active',
    'active',
];
export function normalizePromoterName(value) {
    if (value === false || value === null || value === undefined) {
        return '';
    }
    return String(value).trim().replace(/\s+/g, ' ');
}
function parseOdooActiveFlag(value) {
    if (value === undefined || value === null || value === false) {
        if (value === false) {
            return false;
        }
        return undefined;
    }
    if (value === true || value === 1 || value === '1' || value === 'true') {
        return true;
    }
    if (value === 0 || value === '0' || value === 'false' || value === 'no') {
        return false;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'yes' || normalized === 'active') {
            return true;
        }
        if (normalized === 'no' || normalized === 'inactive' || normalized === 'hidden') {
            return false;
        }
    }
    return Boolean(value);
}
function isOdooAppPromoterActive(row) {
    for (const field of [
        row.x_active,
        row.x_studio_active,
        row.active,
    ]) {
        const parsed = parseOdooActiveFlag(field);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return true;
}
function appPromoterActiveWriteValues(active) {
    return {
        [ODOO_APP_PROMOTER_ACTIVE_FIELD]: active,
        x_studio_active: active,
        active,
    };
}
async function searchReadOdooAppPromoterRows(session, domain, kwargs = {}) {
    try {
        return await searchReadOdooRecords(session, ODOO_APP_PROMOTER_MODEL, domain, [...ODOO_APP_PROMOTER_READ_FIELDS], kwargs);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/invalid field.*\bactive\b/i.test(message)) {
            throw error;
        }
        return searchReadOdooRecords(session, ODOO_APP_PROMOTER_MODEL, domain, [
            'id',
            ODOO_APP_PROMOTER_NAME_FIELD,
            ODOO_APP_PROMOTER_AMOUNT_FIELD,
            ODOO_APP_PROMOTER_ACTIVE_FIELD,
        ], kwargs);
    }
}
async function readOdooAppPromoterRowById(session, id) {
    try {
        return await readOdooRecordAsUser(session, ODOO_APP_PROMOTER_MODEL, id, [...ODOO_APP_PROMOTER_READ_FIELDS]);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/invalid field.*\bactive\b/i.test(message)) {
            throw error;
        }
        return readOdooRecordAsUser(session, ODOO_APP_PROMOTER_MODEL, id, [
            'id',
            ODOO_APP_PROMOTER_NAME_FIELD,
            ODOO_APP_PROMOTER_AMOUNT_FIELD,
            ODOO_APP_PROMOTER_ACTIVE_FIELD,
        ]);
    }
}
function mapOdooAppPromoter(row) {
    const amountRaw = row.x_studio_amount_per_customer;
    const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw) ? amountRaw : 0;
    return {
        id: row.id,
        name: normalizePromoterName(row.x_name),
        amountPerCustomer: amount,
        active: isOdooAppPromoterActive(row),
    };
}
/** List App Promoters from Odoo Studio model. */
export async function fetchOdooAppPromoters(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const domain = [];
    const rows = await searchReadOdooAppPromoterRows(session, domain, {
        order: `${ODOO_APP_PROMOTER_NAME_FIELD} asc`,
        limit: 5000,
    });
    let results = rows
        .map(mapOdooAppPromoter)
        .filter(row => row.name.length > 0);
    if (options?.activeOnly) {
        results = results.filter(row => row.active);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
}
/** Active App Promoter by exact name (for Installed validation). */
export async function findActiveOdooAppPromoterByName(userId, name) {
    const normalized = normalizePromoterName(name);
    if (!normalized) {
        return null;
    }
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const rows = await searchReadOdooAppPromoterRows(session, [[ODOO_APP_PROMOTER_NAME_FIELD, '=', normalized]], { order: 'id asc', limit: 20 });
    const match = rows.map(mapOdooAppPromoter).find(row => row.active);
    return match ?? null;
}
async function findOdooAppPromoterByName(session, name, excludeId) {
    const domain = [[ODOO_APP_PROMOTER_NAME_FIELD, '=', name]];
    if (excludeId != null && Number.isFinite(excludeId) && excludeId > 0) {
        domain.push(['id', '!=', excludeId]);
    }
    const rows = await searchReadOdooAppPromoterRows(session, domain, {
        order: 'id asc',
        limit: 1,
    });
    const first = rows[0];
    return first ? mapOdooAppPromoter(first) : null;
}
async function readOdooAppPromoterById(session, id) {
    const row = await readOdooAppPromoterRowById(session, id);
    return row ? mapOdooAppPromoter(row) : null;
}
export function parseAppPromoterAmount(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || n < 0) {
        throw new Error('Amount per customer must be a number ≥ 0.');
    }
    return n;
}
/** Create App Promoter in Odoo Studio model. */
export async function createOdooAppPromoter(userId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const name = normalizePromoterName(input.name);
    if (!name) {
        throw new Error('Promoter name is required.');
    }
    if (name.length > 120) {
        throw new Error('Promoter name is too long.');
    }
    const amountParsed = parseAppPromoterAmount(input.amountPerCustomer);
    const amount = amountParsed ?? 0;
    const active = input.active === undefined ? true : Boolean(input.active);
    const duplicate = await findOdooAppPromoterByName(session, name);
    if (duplicate) {
        throw new Error('This App Promoter already exists.');
    }
    const id = await createOdooRecordAsUser(session, ODOO_APP_PROMOTER_MODEL, {
        [ODOO_APP_PROMOTER_NAME_FIELD]: name,
        [ODOO_APP_PROMOTER_AMOUNT_FIELD]: amount,
        ...appPromoterActiveWriteValues(active),
    });
    const created = await readOdooAppPromoterById(session, id);
    if (!created) {
        throw new Error('App Promoter was created but could not be reloaded.');
    }
    return created;
}
/** Update App Promoter in Odoo (name, amount, and/or active). */
export async function updateOdooAppPromoter(userId, promoterId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(promoterId) || promoterId <= 0) {
        throw new Error('Invalid promoter id.');
    }
    const existing = await readOdooAppPromoterById(session, promoterId);
    if (!existing) {
        throw new Error('App Promoter not found.');
    }
    const values = {};
    if (input.name !== undefined) {
        const name = normalizePromoterName(input.name);
        if (!name) {
            throw new Error('Promoter name is required.');
        }
        if (name.length > 120) {
            throw new Error('Promoter name is too long.');
        }
        const duplicate = await findOdooAppPromoterByName(session, name, promoterId);
        if (duplicate) {
            throw new Error('This App Promoter already exists.');
        }
        values[ODOO_APP_PROMOTER_NAME_FIELD] = name;
    }
    if (input.amountPerCustomer !== undefined) {
        const amount = parseAppPromoterAmount(input.amountPerCustomer);
        if (amount === null) {
            throw new Error('Amount per customer is required.');
        }
        values[ODOO_APP_PROMOTER_AMOUNT_FIELD] = amount;
    }
    if (input.active !== undefined) {
        Object.assign(values, appPromoterActiveWriteValues(Boolean(input.active)));
    }
    if (Object.keys(values).length === 0) {
        throw new Error('Nothing to update.');
    }
    await writeOdooRecordAsUser(session, ODOO_APP_PROMOTER_MODEL, promoterId, values);
    const updated = await readOdooAppPromoterById(session, promoterId);
    if (!updated) {
        throw new Error('App Promoter was updated but could not be reloaded.');
    }
    return updated;
}
/** Delete App Promoter from Odoo. */
export async function deleteOdooAppPromoter(userId, promoterId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(promoterId) || promoterId <= 0) {
        throw new Error('Invalid promoter id.');
    }
    const existing = await readOdooAppPromoterById(session, promoterId);
    if (!existing) {
        throw new Error('App Promoter not found.');
    }
    await odooCallKw(session.cookie, ODOO_APP_PROMOTER_MODEL, 'unlink', [
        [promoterId],
    ]);
}
/** Studio model: App Promoter Commission lines. */
export const ODOO_APP_PROMOTER_COMMISSION_MODEL = 'x_app_promoter_commiss';
export const ODOO_COMMISSION_TITLE_FIELD = 'x_name';
export const ODOO_COMMISSION_DATE_FIELD = 'x_studio_date1';
export const ODOO_COMMISSION_PROMOTER_FIELD = 'x_studio_promoter';
export const ODOO_COMMISSION_CUSTOMER_FIELD = 'x_studio_customer';
export const ODOO_COMMISSION_AMOUNT_FIELD = 'x_studio_amount';
export const ODOO_COMMISSION_UPDATED_FIELD = 'x_studio_updated_date';
export const ODOO_COMMISSION_SALE_ORDER_FIELD = 'x_studio_sale_order_number';
const ODOO_COMMISSION_READ_FIELDS = [
    'id',
    ODOO_COMMISSION_TITLE_FIELD,
    ODOO_COMMISSION_DATE_FIELD,
    ODOO_COMMISSION_PROMOTER_FIELD,
    ODOO_COMMISSION_CUSTOMER_FIELD,
    ODOO_COMMISSION_AMOUNT_FIELD,
    ODOO_COMMISSION_UPDATED_FIELD,
    ODOO_COMMISSION_SALE_ORDER_FIELD,
];
function parseCommissionMonthKey(month) {
    const match = /^(\d{4})-(\d{2})$/.exec(month.trim());
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const monthNum = Number(match[2]);
    if (!Number.isFinite(year) || monthNum < 1 || monthNum > 12) {
        return null;
    }
    const mm = String(monthNum).padStart(2, '0');
    const lastDay = new Date(year, monthNum, 0).getDate();
    return {
        start: `${year}-${mm}-01`,
        end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    };
}
function mapOdooAppPromoterCommission(row) {
    const amountRaw = row.x_studio_amount;
    const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw) ? amountRaw : 0;
    const dateRaw = row.x_studio_date1;
    const date = typeof dateRaw === 'string' && dateRaw.trim() ? dateRaw.trim().slice(0, 10) : '';
    const updatedRaw = row.x_studio_updated_date;
    const updatedAt = typeof updatedRaw === 'string' && updatedRaw.trim() ? updatedRaw.trim() : null;
    return {
        id: row.id,
        title: normalizePromoterName(row.x_name),
        date,
        promoterId: odooRelationId(row.x_studio_promoter) ?? 0,
        promoterName: odooRelationLabel(row.x_studio_promoter),
        customerId: odooRelationId(row.x_studio_customer) ?? 0,
        customerName: odooRelationLabel(row.x_studio_customer),
        amount,
        updatedAt,
        saleOrderId: odooRelationId(row.x_studio_sale_order_number) ?? 0,
        saleOrderName: odooRelationLabel(row.x_studio_sale_order_number),
    };
}
/** List App Promoter Commission lines from Odoo (filter by month and/or promoter). */
export async function fetchOdooAppPromoterCommissions(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset >= 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [];
    const monthRange = options?.month ? parseCommissionMonthKey(options.month) : null;
    if (monthRange) {
        domain.push([ODOO_COMMISSION_DATE_FIELD, '>=', monthRange.start]);
        domain.push([ODOO_COMMISSION_DATE_FIELD, '<=', monthRange.end]);
    }
    if (options?.promoterId !== undefined &&
        Number.isFinite(options.promoterId) &&
        options.promoterId > 0) {
        domain.push([ODOO_COMMISSION_PROMOTER_FIELD, '=', options.promoterId]);
    }
    const q = options?.q?.trim();
    if (q) {
        const search = [
            '|',
            '|',
            '|',
            [ODOO_COMMISSION_TITLE_FIELD, 'ilike', q],
            ['x_studio_customer.name', 'ilike', q],
            ['x_studio_sale_order_number.name', 'ilike', q],
            ['x_studio_promoter.x_name', 'ilike', q],
        ];
        if (domain.length === 0) {
            domain.push(...search);
        }
        else {
            const combined = [...Array(domain.length).fill('&'), ...domain, ...search];
            domain.length = 0;
            domain.push(...combined);
        }
    }
    const rows = await searchReadOdooRecords(session, ODOO_APP_PROMOTER_COMMISSION_MODEL, domain, [...ODOO_COMMISSION_READ_FIELDS], {
        order: `${ODOO_COMMISSION_DATE_FIELD} desc, id desc`,
        limit,
        offset,
    });
    return rows.map(mapOdooAppPromoterCommission);
}
/** @temp-feature app-install-call-list — only used by Call List; delete with that feature. */
export async function fetchOdooContactsByIds(userId, contactIds) {
    const session = getOdooSession(userId);
    if (!session) {
        return [];
    }
    const ids = [...new Set(contactIds)].filter(id => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
        return [];
    }
    const fields = [
        ...CONTACT_BASE_FIELDS,
        ...Object.keys(CONTACT_CUSTOM_FIELDS),
        ...CONTACT_EXTRA_FIELDS,
    ];
    const chunkSize = 80;
    const contacts = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const rows = await searchReadOdooRecords(session, 'res.partner', [['id', 'in', chunk]], fields, { limit: chunk.length, order: 'name asc' });
        contacts.push(...rows);
    }
    return contacts;
}
function relationDisplayName(value) {
    if (Array.isArray(value) && value.length >= 2) {
        return String(value[1] ?? '').trim();
    }
    if (value === false || value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
}
function formatPartnerAddressLines(street, street2, city) {
    return [street, street2, city].filter(Boolean).join(', ');
}
/**
 * @temp-feature app-install-call-list
 * Batch-load Tags + Township + address for Call List / App User List rows
 * (Mongo only stores partner id/name/phone).
 */
export async function fetchOdooPartnerEnrichmentByContactIds(userId, contactIds) {
    const empty = () => ({
        tags: [],
        township: '',
        street: '',
        street2: '',
        city: '',
        address: '',
    });
    const result = new Map();
    const session = getOdooSession(userId);
    if (!session) {
        return result;
    }
    const ids = [...new Set(contactIds)].filter(id => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
        return result;
    }
    const partners = [];
    const chunkSize = 80;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const rows = await searchReadOdooRecords(session, 'res.partner', [['id', 'in', chunk]], [
            'id',
            'category_id',
            'street',
            'street2',
            'city',
            PARTNER_TOWNSHIP_FIELD,
        ], { limit: chunk.length });
        partners.push(...rows);
    }
    const categoryIds = new Set();
    const partnerCategoryIds = new Map();
    for (const partner of partners) {
        const cats = Array.isArray(partner.category_id)
            ? partner.category_id.filter(id => Number.isFinite(id) && id > 0)
            : [];
        partnerCategoryIds.set(partner.id, cats);
        for (const catId of cats) {
            categoryIds.add(catId);
        }
    }
    const nameById = new Map();
    if (categoryIds.size > 0) {
        const categoryRows = await readOdooRecords(session, 'res.partner.category', [...categoryIds], ['id', 'name']);
        for (const row of categoryRows) {
            const name = String(row.name ?? '').trim();
            if (row.id > 0 && name) {
                nameById.set(row.id, name);
            }
        }
    }
    const byId = new Map(partners.map(partner => [partner.id, partner]));
    for (const partnerId of ids) {
        const partner = byId.get(partnerId);
        if (!partner) {
            result.set(partnerId, empty());
            continue;
        }
        const cats = partnerCategoryIds.get(partnerId) ?? [];
        const tags = cats
            .map(catId => {
            const name = nameById.get(catId);
            return name ? { id: catId, name } : null;
        })
            .filter((tag) => Boolean(tag));
        const street = partner.street === false || partner.street == null
            ? ''
            : String(partner.street).trim();
        const street2 = partner.street2 === false || partner.street2 == null
            ? ''
            : String(partner.street2).trim();
        const city = partner.city === false || partner.city == null
            ? ''
            : String(partner.city).trim();
        const township = relationDisplayName(partner[PARTNER_TOWNSHIP_FIELD]);
        result.set(partnerId, {
            tags,
            township,
            street,
            street2,
            city,
            address: formatPartnerAddressLines(street, street2, city),
        });
    }
    return result;
}
/**
 * @temp-feature app-install-call-list
 * Map partner id → Odoo Tags (`res.partner.category_id` / many2many_tags).
 */
export async function fetchOdooPartnerTagsByContactIds(userId, contactIds) {
    const enriched = await fetchOdooPartnerEnrichmentByContactIds(userId, contactIds);
    const result = new Map();
    for (const [partnerId, meta] of enriched) {
        result.set(partnerId, meta.tags);
    }
    return result;
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
const MEMBERSHIP_FIELDS = [
    'id',
    'x_name',
    'x_studio_customer',
    'x_studio_membership_level',
    'x_studio_pricelist',
    'x_studio_start_date',
    'x_studio_end_date',
    'x_studio_status',
    'x_studio_monthly_coupon_amount',
    'x_studio_total_tickets',
    'x_studio_used_tickets',
    'x_studio_missed_tickets',
    'x_studio_remaining_tickets',
    'x_studio_benefits_summary',
];
const MEMBERSHIP_COUPON_FIELDS = [
    'id',
    'x_name',
    'x_studio_membership',
    'x_studio_customer',
    'x_studio_used_date',
    'x_studio_partner_id',
    'x_studio_currency',
    'x_studio_used_sale_order',
    'x_studio_status',
    'x_studio_coupon_program',
    'x_studio_coupon_amount',
    'x_studio_currency_id',
    'x_studio_ticket_month',
    'x_studio_coupon_code',
];
export async function fetchOdooMemberships(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const q = options?.q?.trim();
    const domain = q
        ? [
            '|',
            '|',
            ['x_name', 'ilike', q],
            ['x_studio_customer', 'ilike', q],
            ['x_studio_status', 'ilike', q],
        ]
        : [];
    return searchReadOdooRecords(session, 'x_membership', domain, MEMBERSHIP_FIELDS, { order: 'id desc', limit, offset });
}
export async function fetchOdooMembershipById(userId, membershipId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return readOdooRecordAsUser(session, 'x_membership', membershipId, MEMBERSHIP_FIELDS);
}
export async function fetchOdooMembershipCouponTickets(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [];
    if (options?.membershipId !== undefined &&
        Number.isFinite(options.membershipId) &&
        options.membershipId > 0) {
        domain.push(['x_studio_membership', '=', options.membershipId]);
    }
    const q = options?.q?.trim();
    if (q) {
        const search = [
            '|',
            '|',
            '|',
            ['x_name', 'ilike', q],
            ['x_studio_coupon_code', 'ilike', q],
            ['x_studio_customer', 'ilike', q],
            ['x_studio_status', 'ilike', q],
        ];
        if (domain.length > 0) {
            domain.unshift('&');
        }
        domain.push(...search);
    }
    return searchReadOdooRecords(session, 'x_membership_coupon_ti', domain, MEMBERSHIP_COUPON_FIELDS, { order: 'id desc', limit, offset });
}
export async function fetchOdooMembershipCouponTicketById(userId, ticketId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return readOdooRecordAsUser(session, 'x_membership_coupon_ti', ticketId, MEMBERSHIP_COUPON_FIELDS);
}
/* ─── Membership Application / Member Request (x_membership_applicati) ─── */
export const MEMBERSHIP_APPLICATION_MODEL = 'x_membership_applicati';
export const MEMBER_REQUEST_STATUSES = [
    'Requested',
    'Approved',
    'Rejected',
];
export const MEMBER_REQUEST_PLANS = ['Premium', 'Pro'];
const MEMBERSHIP_APPLICATION_FIELDS = [
    'id',
    'x_studio_customer',
    'x_studio_selection_field_2c0_1jvv3u0te',
    'x_studio_name',
    'x_studio_phone',
    'x_studio_email',
    'x_studio_status',
    'x_studio_requested_at',
    'x_studio_notes_1',
];
export function isMemberRequestStatus(value) {
    return (typeof value === 'string' &&
        MEMBER_REQUEST_STATUSES.includes(value));
}
/** Normalize Studio selection values (label / lowercase / underscore) to UI labels. */
export function normalizeMemberRequestStatus(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return 'Requested';
    const key = raw.toLowerCase().replace(/\s+/g, '_');
    if (key === 'approved')
        return 'Approved';
    if (key === 'rejected')
        return 'Rejected';
    if (key === 'requested')
        return 'Requested';
    return raw;
}
function memberRequestStatusDomain(status) {
    const normalized = normalizeMemberRequestStatus(status);
    const variants = Array.from(new Set([
        normalized,
        normalized.toLowerCase(),
        normalized.toLowerCase().replace(/\s+/g, '_'),
    ]));
    if (variants.length === 1) {
        return [['x_studio_status', '=', variants[0]]];
    }
    const domain = [];
    for (let i = 0; i < variants.length - 1; i += 1) {
        domain.push('|');
    }
    for (const variant of variants) {
        domain.push(['x_studio_status', '=', variant]);
    }
    return domain;
}
function isYmd(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
export async function fetchOdooMembershipApplications(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [];
    const status = String(options?.status ?? '').trim();
    if (status) {
        domain.push(...memberRequestStatusDomain(status));
    }
    const from = String(options?.from ?? '').trim();
    const to = String(options?.to ?? '').trim();
    if (from && isYmd(from)) {
        domain.push(['x_studio_requested_at', '>=', `${from} 00:00:00`]);
    }
    if (to && isYmd(to)) {
        domain.push(['x_studio_requested_at', '<=', `${to} 23:59:59`]);
    }
    const q = options?.q?.trim();
    if (q) {
        domain.push('|');
        domain.push('|');
        domain.push('|');
        domain.push('|');
        domain.push(['x_studio_name', 'ilike', q]);
        domain.push(['x_studio_phone', 'ilike', q]);
        domain.push(['x_studio_email', 'ilike', q]);
        domain.push(['x_studio_customer', 'ilike', q]);
        domain.push(['x_studio_notes_1', 'ilike', q]);
    }
    return searchReadOdooRecords(session, MEMBERSHIP_APPLICATION_MODEL, domain, MEMBERSHIP_APPLICATION_FIELDS, { order: 'x_studio_requested_at desc, id desc', limit, offset });
}
export async function countOdooMembershipApplications(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const domain = [];
    const status = String(options?.status ?? '').trim();
    if (status) {
        domain.push(...memberRequestStatusDomain(status));
    }
    try {
        if (env.odooApiKey) {
            const count = await odooExecuteKw(session.uid, MEMBERSHIP_APPLICATION_MODEL, 'search_count', [domain]);
            if (typeof count === 'number' && Number.isFinite(count)) {
                return count;
            }
        }
    }
    catch {
        // Fall through to session cookie call.
    }
    return odooCallKw(session.cookie, MEMBERSHIP_APPLICATION_MODEL, 'search_count', [domain]);
}
export async function fetchOdooMembershipApplicationById(userId, applicationId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    return readOdooRecordAsUser(session, MEMBERSHIP_APPLICATION_MODEL, applicationId, MEMBERSHIP_APPLICATION_FIELDS);
}
export async function updateOdooMembershipApplicationStatus(userId, applicationId, status) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    // Prefer the UI label first (matches what Odoo Studio showed for this field).
    // Only fall back to alternate keys if the first write fails.
    const candidates = [status];
    try {
        const fields = await odooCallKw(session.cookie, MEMBERSHIP_APPLICATION_MODEL, 'fields_get', [
            ['x_studio_status'],
            ['selection'],
        ]);
        const selection = fields?.x_studio_status?.selection;
        if (Array.isArray(selection)) {
            const match = selection.find(([key, label]) => key === status ||
                label === status ||
                String(key).toLowerCase() === status.toLowerCase() ||
                String(label).toLowerCase() === status.toLowerCase());
            if (match?.[0] && !candidates.includes(match[0])) {
                candidates.unshift(match[0]);
            }
        }
    }
    catch {
        // fields_get optional — continue with label write.
    }
    let lastError;
    for (const value of Array.from(new Set(candidates))) {
        try {
            await writeOdooRecordAsUser(session, MEMBERSHIP_APPLICATION_MODEL, applicationId, { x_studio_status: value });
            lastError = null;
            break;
        }
        catch (error) {
            lastError = error;
        }
    }
    if (lastError) {
        throw lastError instanceof Error
            ? lastError
            : new Error('Failed to update member request status.');
    }
    const updated = await fetchOdooMembershipApplicationById(userId, applicationId);
    if (!updated) {
        throw new Error('Member request not found after update.');
    }
    return updated;
}
const PURCHASE_ORDER_LIST_FIELDS = [
    'id',
    'name',
    'date_order',
    'partner_id',
    'amount_total',
    'state',
    'user_id',
];
const PURCHASE_ORDER_DETAIL_FIELDS = [
    ...PURCHASE_ORDER_LIST_FIELDS,
    'amount_untaxed',
    'currency_id',
    'date_planned',
    'origin',
];
const PURCHASE_ORDER_LINE_FIELDS = [
    'id',
    'name',
    'product_id',
    'product_qty',
    'price_unit',
    'price_subtotal',
];
const PURCHASE_ORDER_LINE_FIELDS_MIN = [
    'id',
    'name',
    'product_id',
    'product_qty',
    'price_unit',
];
export async function fetchOdooPurchaseOrders(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const q = options?.q?.trim();
    const domain = q
        ? ['|', ['name', 'ilike', q], ['partner_id', 'ilike', q]]
        : [];
    return searchReadOdooRecords(session, 'purchase.order', domain, PURCHASE_ORDER_LIST_FIELDS, { order: 'date_order desc, id desc', limit, offset });
}
export async function fetchOdooPurchaseOrderById(userId, purchaseOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    // Detail fields can differ by Odoo version — fall back to list fields on failure.
    try {
        const detail = await readOdooRecordAsUser(session, 'purchase.order', purchaseOrderId, PURCHASE_ORDER_DETAIL_FIELDS);
        if (detail) {
            return detail;
        }
    }
    catch (error) {
        console.warn('[purchase-orders] Detail fields failed, falling back to list fields:', error instanceof Error ? error.message : error);
    }
    try {
        return await readOdooRecordAsUser(session, 'purchase.order', purchaseOrderId, PURCHASE_ORDER_LIST_FIELDS);
    }
    catch (error) {
        console.error('[purchase-orders] Failed to read purchase order:', error instanceof Error ? error.message : error);
        throw error instanceof Error
            ? error
            : new Error('Failed to load purchase order.');
    }
}
export async function fetchOdooPurchaseOrderLines(userId, purchaseOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const domain = [['order_id', '=', purchaseOrderId]];
    try {
        return await odooCallKw(session.cookie, 'purchase.order.line', 'search_read', [domain, PURCHASE_ORDER_LINE_FIELDS], { order: 'id asc' });
    }
    catch (error) {
        console.warn('[purchase-orders] Line fields failed, retrying with minimal fields:', error instanceof Error ? error.message : error);
    }
    try {
        return await odooCallKw(session.cookie, 'purchase.order.line', 'search_read', [domain, PURCHASE_ORDER_LINE_FIELDS_MIN], { order: 'id asc' });
    }
    catch (error) {
        console.warn('[purchase-orders] Could not load order lines:', error instanceof Error ? error.message : error);
        return [];
    }
}
export async function fetchOdooPurchaseOrderDetailBundle(userId, purchaseOrderId) {
    const purchaseOrder = await fetchOdooPurchaseOrderById(userId, purchaseOrderId);
    if (!purchaseOrder) {
        return null;
    }
    const lines = await fetchOdooPurchaseOrderLines(userId, purchaseOrderId);
    return { purchaseOrder, lines };
}
/**
 * Create a Purchase RFQ in Odoo (purchase.order), optionally confirm it.
 * Mirrors the Odoo Purchase “New” form: Vendor + product lines.
 */
export async function createOdooPurchaseOrder(userId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(input.partnerId) || input.partnerId <= 0) {
        throw new Error('A valid vendor is required.');
    }
    if (!input.lines.length) {
        throw new Error('Add at least one product before saving.');
    }
    const orderLineCommands = input.lines.map(line => [
        0,
        0,
        {
            product_id: line.productId,
            product_qty: line.quantity,
            price_unit: line.unitPrice,
        },
    ]);
    const values = {
        partner_id: input.partnerId,
        order_line: orderLineCommands,
    };
    const dateOrder = input.dateOrder?.trim();
    if (dateOrder) {
        values.date_order = dateOrder;
    }
    const datePlanned = input.datePlanned?.trim();
    if (datePlanned) {
        values.date_planned = datePlanned;
    }
    const partnerRef = input.partnerRef?.trim();
    if (partnerRef) {
        values.partner_ref = partnerRef;
    }
    const purchaseOrderId = await createOdooRecordAsUser(session, 'purchase.order', values);
    let state = 'draft';
    if (input.confirm) {
        try {
            await odooCallKw(session.cookie, 'purchase.order', 'button_confirm', [
                [purchaseOrderId],
            ]);
            state = 'purchase';
        }
        catch (error) {
            console.warn('[purchase-orders] Created RFQ but confirm failed:', error instanceof Error ? error.message : error);
        }
    }
    let name = `PO/${purchaseOrderId}`;
    try {
        const row = await readOdooRecordAsUser(session, 'purchase.order', purchaseOrderId, ['name', 'state']);
        if (row?.name) {
            name = String(row.name);
        }
        if (row?.state) {
            state = String(row.state);
        }
    }
    catch {
        // Keep fallback name/state.
    }
    return { id: purchaseOrderId, name, state };
}
const SALE_ORDER_LIST_FIELDS = [
    'id',
    'name',
    'date_order',
    'partner_id',
    'amount_total',
    'state',
    'user_id',
    'x_studio_phonenumber_1',
    'x_studio_phonenumber',
    'x_studio_sale_person_name',
    'x_studio_salesperson',
];
const SALE_ORDER_DETAIL_FIELDS = [
    ...SALE_ORDER_LIST_FIELDS,
    'amount_untaxed',
    'currency_id',
    'commitment_date',
    'client_order_ref',
    'partner_shipping_id',
    'x_studio_preferred_delivery_date',
    'x_studio_delivery_notes',
    'invoice_status',
];
const SALE_ORDER_LINE_FIELDS = [
    'id',
    'name',
    'product_id',
    'product_uom_qty',
    'product_uom_id',
    'qty_delivered',
    'qty_invoiced',
    'price_unit',
    'price_subtotal',
];
const SALE_ORDER_LINE_FIELDS_MIN = [
    'id',
    'name',
    'product_id',
    'product_uom_qty',
    'qty_delivered',
    'price_unit',
];
export async function fetchOdooSaleOrders(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [['state', 'in', ['sale', 'done']]];
    appendOrderDateDomain(domain, options?.from, options?.to);
    const q = options?.q?.trim();
    if (q) {
        domain.push('|');
        domain.push('|');
        domain.push(['name', 'ilike', q]);
        domain.push(['partner_id', 'ilike', q]);
        domain.push(['client_order_ref', 'ilike', q]);
    }
    return searchReadOdooRecords(session, 'sale.order', domain, SALE_ORDER_LIST_FIELDS, { order: 'date_order desc, id desc', limit, offset });
}
export async function fetchOdooSaleOrderById(userId, saleOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    try {
        const detail = await readOdooRecordAsUser(session, 'sale.order', saleOrderId, SALE_ORDER_DETAIL_FIELDS);
        if (detail) {
            return detail;
        }
    }
    catch (error) {
        console.warn('[sale-orders] Detail fields failed, falling back to list fields:', error instanceof Error ? error.message : error);
    }
    try {
        return await readOdooRecordAsUser(session, 'sale.order', saleOrderId, SALE_ORDER_LIST_FIELDS);
    }
    catch (error) {
        console.error('[sale-orders] Failed to read sale order:', error instanceof Error ? error.message : error);
        throw error instanceof Error
            ? error
            : new Error('Failed to load sale order.');
    }
}
export async function fetchOdooSaleOrderLines(userId, saleOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const domain = [['order_id', '=', saleOrderId]];
    try {
        return await odooCallKw(session.cookie, 'sale.order.line', 'search_read', [domain, SALE_ORDER_LINE_FIELDS], { order: 'id asc' });
    }
    catch (error) {
        console.warn('[sale-orders] Line fields failed, retrying with minimal fields:', error instanceof Error ? error.message : error);
    }
    try {
        return await odooCallKw(session.cookie, 'sale.order.line', 'search_read', [domain, SALE_ORDER_LINE_FIELDS_MIN], { order: 'id asc' });
    }
    catch (error) {
        console.warn('[sale-orders] Could not load order lines:', error instanceof Error ? error.message : error);
        return [];
    }
}
export async function fetchOdooSaleOrderDetailBundle(userId, saleOrderId) {
    const saleOrder = await fetchOdooSaleOrderById(userId, saleOrderId);
    if (!saleOrder) {
        return null;
    }
    // View module: only confirmed sale orders (sale / done).
    const state = String(saleOrder.state || '');
    if (state !== 'sale' && state !== 'done') {
        return null;
    }
    const lines = await fetchOdooSaleOrderLines(userId, saleOrderId);
    return { saleOrder, lines };
}
/* ─── App Order (Quotation Sent OR Studio Salesperson = Administrator) ─── */
let cachedAdministratorUserId;
/** Resolve Odoo res.users id for Administrator (Studio x_studio_salesperson). */
async function resolveAdministratorUserId(session) {
    if (cachedAdministratorUserId !== undefined) {
        return cachedAdministratorUserId;
    }
    try {
        const rows = await odooCallKw(session.cookie, 'res.users', 'search_read', [
            [
                '|',
                ['login', '=', 'admin'],
                ['name', '=ilike', 'Administrator'],
            ],
            ['id', 'name', 'login'],
        ], { order: 'id asc', limit: 5 });
        const preferred = rows?.find(row => String(row.login || '').toLowerCase() === 'admin') ??
            rows?.find(row => String(row.name || '').toLowerCase() === 'administrator') ??
            rows?.[0];
        cachedAdministratorUserId =
            preferred && Number.isFinite(preferred.id) ? preferred.id : null;
    }
    catch (error) {
        console.warn('[online-orders] Could not resolve Administrator user:', error instanceof Error ? error.message : error);
        cachedAdministratorUserId = null;
    }
    return cachedAdministratorUserId;
}
function isAppOrderSalespersonAdministrator(order, administratorUserId) {
    const rel = order.x_studio_salesperson;
    if (!Array.isArray(rel) || typeof rel[0] !== 'number') {
        return false;
    }
    if (administratorUserId !== null && rel[0] === administratorUserId) {
        return true;
    }
    return String(rel[1] || '').trim().toLowerCase() === 'administrator';
}
function buildAppOrderDomain(administratorUserId) {
    // Either Quotation Sent OR Studio Salesperson = Administrator.
    if (administratorUserId !== null) {
        return [
            '|',
            ['state', '=', 'sent'],
            ['x_studio_salesperson', '=', administratorUserId],
        ];
    }
    // Fallback when Administrator user cannot be resolved.
    return [['state', '=', 'sent']];
}
export async function fetchOdooOnlineOrders(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const administratorUserId = await resolveAdministratorUserId(session);
    const domain = buildAppOrderDomain(administratorUserId);
    appendOrderDateDomain(domain, options?.from, options?.to);
    const q = options?.q?.trim();
    if (q) {
        domain.push('|');
        domain.push('|');
        domain.push('|');
        domain.push('|');
        domain.push(['name', 'ilike', q]);
        domain.push(['partner_id', 'ilike', q]);
        domain.push(['client_order_ref', 'ilike', q]);
        domain.push(['x_studio_phonenumber_1', 'ilike', q]);
        domain.push(['x_studio_sale_person_name', 'ilike', q]);
    }
    try {
        return await searchReadOdooRecords(session, 'sale.order', domain, SALE_ORDER_LIST_FIELDS, { order: 'date_order desc, id desc', limit, offset });
    }
    catch (error) {
        // Older DBs may lack x_studio_salesperson — fall back to Quotation Sent only.
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes('x_studio_salesperson') ||
            message.toLowerCase().includes('invalid field')) {
            console.warn('[online-orders] x_studio_salesperson unavailable, using state=sent only:', message);
            const fallbackDomain = [['state', '=', 'sent']];
            appendOrderDateDomain(fallbackDomain, options?.from, options?.to);
            if (q) {
                fallbackDomain.push('|');
                fallbackDomain.push('|');
                fallbackDomain.push('|');
                fallbackDomain.push('|');
                fallbackDomain.push(['name', 'ilike', q]);
                fallbackDomain.push(['partner_id', 'ilike', q]);
                fallbackDomain.push(['client_order_ref', 'ilike', q]);
                fallbackDomain.push(['x_studio_phonenumber_1', 'ilike', q]);
                fallbackDomain.push(['x_studio_sale_person_name', 'ilike', q]);
            }
            return searchReadOdooRecords(session, 'sale.order', fallbackDomain, SALE_ORDER_LIST_FIELDS.filter(f => f !== 'x_studio_salesperson'), { order: 'date_order desc, id desc', limit, offset });
        }
        throw error;
    }
}
/**
 * Count App Orders per partner (and capture the latest order number/date).
 * Used by App User List badges beside customer names.
 */
export async function fetchAppOrderStatsByPartnerIds(userId, partnerIds) {
    const stats = new Map();
    const ids = [
        ...new Set(partnerIds.filter(id => Number.isFinite(id) && id > 0).map(id => Math.floor(id))),
    ];
    if (!ids.length) {
        return stats;
    }
    const session = getOdooSession(userId);
    if (!session) {
        return stats;
    }
    const administratorUserId = await resolveAdministratorUserId(session);
    const baseDomain = buildAppOrderDomain(administratorUserId);
    const fields = ['partner_id', 'name', 'date_order'];
    const pageSize = 500;
    const maxPages = 20;
    const readPage = async (domain, offset) => searchReadOdooRecords(session, 'sale.order', domain, [...fields], {
        order: 'date_order desc, id desc',
        limit: pageSize,
        offset,
    });
    try {
        for (let page = 0; page < maxPages; page += 1) {
            const domain = [...baseDomain, ['partner_id', 'in', ids]];
            let rows;
            try {
                rows = await readPage(domain, page * pageSize);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.toLowerCase().includes('x_studio_salesperson') ||
                    message.toLowerCase().includes('invalid field')) {
                    rows = await readPage([['state', '=', 'sent'], ['partner_id', 'in', ids]], page * pageSize);
                }
                else {
                    throw error;
                }
            }
            if (!rows.length) {
                break;
            }
            for (const row of rows) {
                const partnerId = Array.isArray(row.partner_id)
                    ? Number(row.partner_id[0])
                    : 0;
                if (!partnerId) {
                    continue;
                }
                const existing = stats.get(partnerId);
                if (!existing) {
                    stats.set(partnerId, {
                        count: 1,
                        lastOrderNumber: String(row.name || ''),
                        lastOrderDate: String(row.date_order || ''),
                    });
                }
                else {
                    existing.count += 1;
                }
            }
            if (rows.length < pageSize) {
                break;
            }
        }
    }
    catch (error) {
        // Don't fail the whole App User List if order stats cannot load.
        console.error('[app-installs] app-order stats', error instanceof Error ? error.message : error);
    }
    return stats;
}
export async function fetchOdooOnlineOrderDetailBundle(userId, saleOrderId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const saleOrder = await fetchOdooSaleOrderById(userId, saleOrderId);
    if (!saleOrder) {
        return null;
    }
    const administratorUserId = await resolveAdministratorUserId(session);
    const isQuotationSent = String(saleOrder.state || '') === 'sent';
    const isAdminSalesperson = isAppOrderSalespersonAdministrator(saleOrder, administratorUserId);
    if (!isQuotationSent && !isAdminSalesperson) {
        return null;
    }
    const lines = await fetchOdooSaleOrderLines(userId, saleOrderId);
    return { saleOrder, lines };
}
function yangonParts(date) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Yangon',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (type) => Number(parts.find(part => part.type === type)?.value ?? '0');
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') };
}
function pad2(n) {
    return String(n).padStart(2, '0');
}
function yangonDateKey(date) {
    const { y, m, d } = yangonParts(date);
    return `${y}-${pad2(m)}-${pad2(d)}`;
}
function yangonHourKey(date) {
    const { y, m, d, h } = yangonParts(date);
    return `${y}-${pad2(m)}-${pad2(d)}T${pad2(h)}`;
}
function parseOdooDate(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return null;
    }
    // Odoo often returns naive UTC-like "YYYY-MM-DD HH:mm:ss"
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZ = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized)
        ? normalized
        : `${normalized}Z`;
    const date = new Date(withZ);
    return Number.isNaN(date.getTime()) ? null : date;
}
function buildPeriodWindow(period, now = new Date()) {
    const { y, m, d } = yangonParts(now);
    // Approximate Yangon local midnight as UTC+06:30
    const localMidnightUtc = Date.UTC(y, m - 1, d) - 6.5 * 60 * 60 * 1000;
    if (period === 'day') {
        const from = new Date(localMidnightUtc);
        const to = new Date(localMidnightUtc + 24 * 60 * 60 * 1000);
        const prevFrom = new Date(from.getTime() - 24 * 60 * 60 * 1000);
        const prevTo = from;
        const buckets = [];
        for (let hour = 0; hour < 24; hour += 1) {
            buckets.push(`${y}-${pad2(m)}-${pad2(d)}T${pad2(hour)}`);
        }
        return { from, to, prevFrom, prevTo, buckets, bucketMode: 'hour' };
    }
    if (period === 'week') {
        // Last 7 calendar days including today (Yangon)
        const to = new Date(localMidnightUtc + 24 * 60 * 60 * 1000);
        const from = new Date(localMidnightUtc - 6 * 24 * 60 * 60 * 1000);
        const prevTo = from;
        const prevFrom = new Date(from.getTime() - 7 * 24 * 60 * 60 * 1000);
        const buckets = [];
        for (let i = 0; i < 7; i += 1) {
            const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
            buckets.push(yangonDateKey(day));
        }
        return { from, to, prevFrom, prevTo, buckets, bucketMode: 'day' };
    }
    // month: current calendar month in Yangon
    const monthStartUtc = Date.UTC(y, m - 1, 1) - 6.5 * 60 * 60 * 1000;
    const nextMonthStartUtc = Date.UTC(y, m, 1) - 6.5 * 60 * 60 * 1000;
    const from = new Date(monthStartUtc);
    const to = new Date(nextMonthStartUtc);
    const prevMonthStartUtc = Date.UTC(y, m - 2, 1) - 6.5 * 60 * 60 * 1000;
    const prevFrom = new Date(prevMonthStartUtc);
    const prevTo = from;
    const buckets = [];
    const cursor = new Date(from.getTime());
    while (cursor < to) {
        buckets.push(yangonDateKey(cursor));
        cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return { from, to, prevFrom, prevTo, buckets, bucketMode: 'day' };
}
function toOdooDatetime(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}
const ORDER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Inclusive calendar dates (YYYY-MM-DD) on sale.order date_order. */
function appendOrderDateDomain(domain, from, to, field = 'date_order') {
    const start = from?.trim();
    const end = to?.trim();
    if (start && ORDER_DATE_RE.test(start)) {
        domain.push([field, '>=', `${start} 00:00:00`]);
    }
    if (end && ORDER_DATE_RE.test(end)) {
        domain.push([field, '<=', `${end} 23:59:59`]);
    }
}
function paidSaleDomain(fromStr, toStr) {
    return [
        ['state', 'in', ['sale', 'done']],
        ['amount_total', '>', 0],
        ['date_order', '>=', fromStr],
        ['date_order', '<', toStr],
    ];
}
function paidPurchaseDomain(fromStr, toStr) {
    return [
        ['state', 'in', ['purchase', 'done']],
        ['amount_total', '>', 0],
        ['date_order', '>=', fromStr],
        ['date_order', '<', toStr],
    ];
}
function trendPercent(current, previous) {
    if (!Number.isFinite(previous) || previous === 0) {
        return current > 0 ? 100 : 0;
    }
    return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}
function areaLabel(partner) {
    const township = Array.isArray(partner[PARTNER_TOWNSHIP_FIELD])
        ? String(partner[PARTNER_TOWNSHIP_FIELD][1] || '').trim()
        : '';
    const city = String(partner.city || '').trim();
    return township || city || 'Unknown area';
}
function buildLastMonthWindow(now = new Date()) {
    const { y, m } = yangonParts(now);
    const monthStartUtc = Date.UTC(y, m - 1, 1) - 6.5 * 60 * 60 * 1000;
    const prevMonthStartUtc = Date.UTC(y, m - 2, 1) - 6.5 * 60 * 60 * 1000;
    return {
        from: new Date(prevMonthStartUtc),
        to: new Date(monthStartUtc),
    };
}
function partnerAreaMeta(partner, townshipStateById) {
    const townshipId = odooRelationId(partner[PARTNER_TOWNSHIP_FIELD]);
    const townshipName = odooRelationLabel(partner[PARTNER_TOWNSHIP_FIELD]);
    const city = odooString(partner.city);
    const name = townshipName || city || 'Unknown area';
    const key = townshipId > 0
        ? `township:${townshipId}`
        : city
            ? `city:${city.toLowerCase()}`
            : 'unknown';
    let stateId = odooRelationId(partner.state_id) || null;
    let stateName = odooRelationLabel(partner.state_id) || '';
    if ((!stateId || !stateName) && townshipId > 0) {
        const fromTownship = townshipStateById.get(townshipId);
        if (fromTownship) {
            stateId = fromTownship.stateId || stateId;
            stateName = fromTownship.stateName || stateName;
        }
    }
    if (!stateName) {
        stateName = 'Unknown state';
    }
    return { key, name, stateId: stateId || null, stateName };
}
async function loadPartnerAreaMetaMap(session, partnerIds) {
    const metaByPartner = new Map();
    if (partnerIds.length === 0) {
        return metaByPartner;
    }
    const partners = await searchReadOdooRecords(session, 'res.partner', [['id', 'in', partnerIds]], ['id', 'city', 'state_id', PARTNER_TOWNSHIP_FIELD], { limit: partnerIds.length });
    const townshipIds = [
        ...new Set(partners
            .map(partner => odooRelationId(partner[PARTNER_TOWNSHIP_FIELD]))
            .filter(id => id > 0)),
    ];
    const townshipStateById = new Map();
    if (townshipIds.length > 0 && env.odooTownshipModel) {
        try {
            const townships = await searchReadOdooRecords(session, env.odooTownshipModel, [['id', 'in', townshipIds]], ['id', 'x_name', 'x_studio_state_link'], { limit: townshipIds.length });
            for (const row of townships) {
                const stateId = odooRelationId(row.x_studio_state_link);
                const stateName = odooRelationLabel(row.x_studio_state_link);
                if (stateId > 0 || stateName) {
                    townshipStateById.set(row.id, {
                        stateId: stateId || 0,
                        stateName: stateName || 'Unknown state',
                    });
                }
            }
        }
        catch {
            // Township enrichment is optional; partner.state_id still works.
        }
    }
    for (const partner of partners) {
        metaByPartner.set(partner.id, partnerAreaMeta(partner, townshipStateById));
    }
    return metaByPartner;
}
function sumOrders(orders) {
    return orders.reduce((sum, order) => sum + (Number(order.amount_total) || 0), 0);
}
export async function fetchOverviewInsights(userId, period) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const window = buildPeriodWindow(period);
    const fromStr = toOdooDatetime(window.from);
    const toStr = toOdooDatetime(window.to);
    const prevFromStr = toOdooDatetime(window.prevFrom);
    const prevToStr = toOdooDatetime(window.prevTo);
    const saleDomain = paidSaleDomain(fromStr, toStr);
    const prevSaleDomain = paidSaleDomain(prevFromStr, prevToStr);
    const purchaseDomain = paidPurchaseDomain(fromStr, toStr);
    const prevPurchaseDomain = paidPurchaseDomain(prevFromStr, prevToStr);
    const [saleOrders, prevSaleOrders, purchaseOrders, prevPurchaseOrders, quotationCount, prevQuotationCount, membershipCount, prevMembershipCount,] = await Promise.all([
        searchReadOdooRecords(session, 'sale.order', saleDomain, SALE_ORDER_LIST_FIELDS, { order: 'date_order desc, id desc', limit: 1000 }),
        searchReadOdooRecords(session, 'sale.order', prevSaleDomain, ['id', 'amount_total', 'partner_id'], { limit: 1000 }),
        searchReadOdooRecords(session, 'purchase.order', purchaseDomain, PURCHASE_ORDER_LIST_FIELDS, { order: 'date_order desc, id desc', limit: 1000 }),
        searchReadOdooRecords(session, 'purchase.order', prevPurchaseDomain, ['id', 'amount_total'], { limit: 1000 }),
        odooCallKw(session.cookie, 'sale.order', 'search_count', [
            [
                ['date_order', '>=', fromStr],
                ['date_order', '<', toStr],
                ['state', 'in', ['draft', 'sent', 'sale', 'done']],
            ],
        ]),
        odooCallKw(session.cookie, 'sale.order', 'search_count', [
            [
                ['date_order', '>=', prevFromStr],
                ['date_order', '<', prevToStr],
                ['state', 'in', ['draft', 'sent', 'sale', 'done']],
            ],
        ]),
        odooCallKw(session.cookie, 'x_membership', 'search_count', [
            [
                ['x_studio_start_date', '>=', fromStr.slice(0, 10)],
                ['x_studio_start_date', '<', toStr.slice(0, 10)],
            ],
        ]).catch(async () => {
            const rows = await searchReadOdooRecords(session, 'x_membership', [], ['id', 'x_studio_start_date'], { limit: 500 });
            const fromDay = fromStr.slice(0, 10);
            const toDay = toStr.slice(0, 10);
            return rows.filter(row => {
                const start = String(row.x_studio_start_date || '').slice(0, 10);
                return start >= fromDay && start < toDay;
            }).length;
        }),
        odooCallKw(session.cookie, 'x_membership', 'search_count', [
            [
                ['x_studio_start_date', '>=', prevFromStr.slice(0, 10)],
                ['x_studio_start_date', '<', prevToStr.slice(0, 10)],
            ],
        ]).catch(() => 0),
    ]);
    const saleAmount = sumOrders(saleOrders);
    const prevSaleAmount = sumOrders(prevSaleOrders);
    const orderCount = saleOrders.length;
    const prevOrderCount = prevSaleOrders.length;
    const avgOrderValue = orderCount > 0 ? saleAmount / orderCount : 0;
    const prevAvg = prevOrderCount > 0 ? prevSaleAmount / prevOrderCount : 0;
    const purchaseAmount = purchaseOrders.reduce((sum, order) => sum + (Number(order.amount_total) || 0), 0);
    const prevPurchaseAmount = prevPurchaseOrders.reduce((sum, order) => sum + (Number(order.amount_total) || 0), 0);
    const purchaseOrderCount = purchaseOrders.length;
    const prevPurchaseOrderCount = prevPurchaseOrders.length;
    const buyingCustomerIds = new Set(saleOrders
        .map(order => Array.isArray(order.partner_id) ? Number(order.partner_id[0]) : 0)
        .filter(id => id > 0));
    const prevBuyingCustomerIds = new Set(prevSaleOrders
        .map(order => Array.isArray(order.partner_id) ? Number(order.partner_id[0]) : 0)
        .filter(id => id > 0));
    // Partner areas for current-period orders
    const partnerIds = Array.from(buyingCustomerIds);
    let partners = [];
    if (partnerIds.length > 0) {
        partners = await searchReadOdooRecords(session, 'res.partner', [['id', 'in', partnerIds]], ['id', 'city', PARTNER_TOWNSHIP_FIELD], { limit: partnerIds.length });
    }
    const partnerArea = new Map();
    for (const partner of partners) {
        partnerArea.set(partner.id, areaLabel(partner));
    }
    const areaTotals = new Map();
    const areaSeriesMap = new Map();
    for (const order of saleOrders) {
        const partnerId = Array.isArray(order.partner_id)
            ? Number(order.partner_id[0])
            : 0;
        const area = partnerArea.get(partnerId) || 'Unknown area';
        const amount = Number(order.amount_total) || 0;
        areaTotals.set(area, (areaTotals.get(area) || 0) + amount);
        const orderDate = parseOdooDate(order.date_order);
        if (!orderDate) {
            continue;
        }
        const bucket = window.bucketMode === 'hour'
            ? yangonHourKey(orderDate)
            : yangonDateKey(orderDate);
        if (!areaSeriesMap.has(area)) {
            areaSeriesMap.set(area, new Map());
        }
        const series = areaSeriesMap.get(area);
        series.set(bucket, (series.get(bucket) || 0) + amount);
    }
    const topAreas = [...areaTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, total]) => ({ name, total }));
    const areaChart = {
        buckets: window.buckets,
        series: topAreas.map(area => ({
            name: area.name,
            total: area.total,
            points: window.buckets.map(bucket => ({
                bucket,
                value: areaSeriesMap.get(area.name)?.get(bucket) || 0,
            })),
        })),
    };
    // Product rankings from sale order lines
    const orderIds = saleOrders.map(order => order.id);
    const productTotals = new Map();
    let itemsSold = 0;
    if (orderIds.length > 0) {
        const chunkSize = 200;
        for (let i = 0; i < orderIds.length; i += chunkSize) {
            const chunk = orderIds.slice(i, i + chunkSize);
            let lines = [];
            try {
                lines = await searchReadOdooRecords(session, 'sale.order.line', [
                    ['order_id', 'in', chunk],
                    ['display_type', '=', false],
                ], [
                    'id',
                    'product_id',
                    'price_subtotal',
                    'product_uom_qty',
                    'display_type',
                ], { limit: 2000 });
            }
            catch {
                lines = await searchReadOdooRecords(session, 'sale.order.line', [['order_id', 'in', chunk]], ['id', 'product_id', 'price_subtotal', 'product_uom_qty'], { limit: 2000 });
            }
            for (const line of lines) {
                if (line.display_type) {
                    continue;
                }
                const productId = Array.isArray(line.product_id)
                    ? String(line.product_id[0])
                    : '';
                const productName = Array.isArray(line.product_id)
                    ? String(line.product_id[1] || '').trim()
                    : '';
                const qty = Number(line.product_uom_qty) || 0;
                itemsSold += qty;
                if (!productId || !productName) {
                    continue;
                }
                const existing = productTotals.get(productId) || {
                    id: productId,
                    name: productName,
                    revenue: 0,
                    qty: 0,
                };
                existing.revenue += Number(line.price_subtotal) || 0;
                existing.qty += qty;
                productTotals.set(productId, existing);
            }
        }
    }
    const rankedProducts = [...productTotals.values()].sort((a, b) => b.revenue - a.revenue);
    const topProducts = rankedProducts.slice(0, 3);
    const bottomProducts = rankedProducts.length <= 3
        ? []
        : [...rankedProducts].reverse().slice(0, 3);
    const demandRanked = [...productTotals.values()].sort((a, b) => b.qty - a.qty);
    const topDemandCandidates = demandRanked.slice(0, 3);
    const stockByProductId = new Map();
    const demandProductIds = topDemandCandidates
        .map(row => Number(row.id))
        .filter(id => Number.isFinite(id) && id > 0);
    let lowestOnHandProducts = [];
    let highestDemandProducts = [];
    try {
        let stockRows = [];
        try {
            stockRows = await searchReadOdooRecords(session, 'product.product', [
                ['active', '=', true],
                ['sale_ok', '=', true],
                ['type', 'in', ['product', 'consu']],
            ], ['id', 'name', 'qty_available'], { limit: 400 });
        }
        catch {
            stockRows = await searchReadOdooRecords(session, 'product.product', [['active', '=', true], ['sale_ok', '=', true]], ['id', 'name', 'qty_available'], { limit: 400 });
        }
        for (const row of stockRows) {
            stockByProductId.set(row.id, Number(row.qty_available) || 0);
        }
        lowestOnHandProducts = [...stockRows]
            .map(row => ({
            id: String(row.id),
            name: String(row.name || '').trim() || `Product #${row.id}`,
            onHand: Number(row.qty_available) || 0,
        }))
            .sort((a, b) => a.onHand - b.onHand)
            .slice(0, 3);
        // Fill any missing demand-product stock from a targeted read.
        const missingDemandIds = demandProductIds.filter(id => !stockByProductId.has(id));
        if (missingDemandIds.length > 0) {
            const extra = await searchReadOdooRecords(session, 'product.product', [['id', 'in', missingDemandIds]], ['id', 'name', 'qty_available'], { limit: missingDemandIds.length });
            for (const row of extra) {
                stockByProductId.set(row.id, Number(row.qty_available) || 0);
            }
        }
        highestDemandProducts = topDemandCandidates.map(row => {
            const idNum = Number(row.id);
            return {
                id: row.id,
                name: row.name,
                demandQty: row.qty,
                onHand: stockByProductId.get(idNum) ?? 0,
                revenue: row.revenue,
            };
        });
    }
    catch (error) {
        console.warn('[insights] Stock on-hand enrichment failed:', error instanceof Error ? error.message : error);
        highestDemandProducts = topDemandCandidates.map(row => ({
            id: row.id,
            name: row.name,
            demandQty: row.qty,
            onHand: 0,
            revenue: row.revenue,
        }));
    }
    const recentOrders = saleOrders
        .filter(order => (Number(order.amount_total) || 0) > 0)
        .slice(0, 8)
        .map(order => ({
        id: String(order.id),
        number: String(order.name || ''),
        customer: Array.isArray(order.partner_id)
            ? String(order.partner_id[1] || '')
            : '',
        total: Number(order.amount_total) || 0,
        orderDate: String(order.date_order || ''),
        status: String(order.state || ''),
    }));
    const customerSpend = new Map();
    for (const order of saleOrders) {
        const id = Array.isArray(order.partner_id)
            ? String(order.partner_id[0] || '')
            : '';
        const name = Array.isArray(order.partner_id)
            ? String(order.partner_id[1] || '').trim()
            : '';
        if (!id) {
            continue;
        }
        const existing = customerSpend.get(id) || {
            id,
            name: name || 'Unknown customer',
            total: 0,
            orders: 0,
        };
        existing.total += Number(order.amount_total) || 0;
        existing.orders += 1;
        if (name) {
            existing.name = name;
        }
        customerSpend.set(id, existing);
    }
    const topSpendingCustomers = [...customerSpend.values()]
        .filter(row => row.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
    const recentPurchaseOrders = purchaseOrders
        .filter(order => (Number(order.amount_total) || 0) > 0)
        .slice(0, 8)
        .map(order => ({
        id: String(order.id),
        number: String(order.name || ''),
        vendor: Array.isArray(order.partner_id)
            ? String(order.partner_id[1] || '')
            : '',
        total: Number(order.amount_total) || 0,
        orderDate: String(order.date_order || ''),
        status: String(order.state || ''),
    }));
    return {
        period,
        range: {
            from: fromStr,
            to: toStr,
        },
        kpis: {
            saleAmount: {
                value: saleAmount,
                trend: trendPercent(saleAmount, prevSaleAmount),
            },
            confirmedOrders: {
                value: orderCount,
                trend: trendPercent(orderCount, prevOrderCount),
            },
            buyingCustomers: {
                value: buyingCustomerIds.size,
                trend: trendPercent(buyingCustomerIds.size, prevBuyingCustomerIds.size),
            },
            quotations: {
                value: Number(quotationCount) || 0,
                trend: trendPercent(Number(quotationCount) || 0, Number(prevQuotationCount) || 0),
            },
            itemsSold: {
                value: itemsSold,
                trend: 0,
            },
            avgOrderValue: {
                value: avgOrderValue,
                trend: trendPercent(avgOrderValue, prevAvg),
            },
            purchaseAmount: {
                value: purchaseAmount,
                trend: trendPercent(purchaseAmount, prevPurchaseAmount),
            },
            purchaseOrders: {
                value: purchaseOrderCount,
                trend: trendPercent(purchaseOrderCount, prevPurchaseOrderCount),
            },
            // Kept for older clients; same period window as quotations / buying customers.
            totalCustomers: {
                value: buyingCustomerIds.size,
                trend: trendPercent(buyingCustomerIds.size, prevBuyingCustomerIds.size),
            },
            openQuotations: {
                value: Number(quotationCount) || 0,
                trend: trendPercent(Number(quotationCount) || 0, Number(prevQuotationCount) || 0),
            },
            activeMemberships: {
                value: Number(membershipCount) || 0,
                trend: trendPercent(Number(membershipCount) || 0, Number(prevMembershipCount) || 0),
            },
        },
        areaChart,
        topProducts,
        bottomProducts,
        lowestOnHandProducts,
        highestDemandProducts,
        topSpendingCustomers,
        recentOrders,
        recentPurchaseOrders,
    };
}
/** Full rankings for Overview View detail (customers + buying areas). */
export async function fetchOverviewRankings(userId, period, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const compare = options?.compare === true;
    const window = buildPeriodWindow(period);
    const lastMonth = buildLastMonthWindow();
    const fromStr = toOdooDatetime(window.from);
    const toStr = toOdooDatetime(window.to);
    const prevFromStr = toOdooDatetime(lastMonth.from);
    const prevToStr = toOdooDatetime(lastMonth.to);
    const saleDomain = paidSaleDomain(fromStr, toStr);
    const prevSaleDomain = paidSaleDomain(prevFromStr, prevToStr);
    const [saleOrders, prevSaleOrders] = await Promise.all([
        searchReadOdooRecords(session, 'sale.order', saleDomain, ['id', 'amount_total', 'partner_id', 'date_order'], { order: 'date_order desc, id desc', limit: 2000 }),
        compare
            ? searchReadOdooRecords(session, 'sale.order', prevSaleDomain, ['id', 'amount_total', 'partner_id'], { limit: 2000 })
            : Promise.resolve([]),
    ]);
    const partnerIds = [
        ...new Set([...saleOrders, ...prevSaleOrders]
            .map(order => Array.isArray(order.partner_id) ? Number(order.partner_id[0]) : 0)
            .filter(id => id > 0)),
    ];
    const partnerMeta = await loadPartnerAreaMetaMap(session, partnerIds);
    const customerSpend = new Map();
    const areaSpend = new Map();
    const bumpCustomer = (order, field) => {
        const id = Array.isArray(order.partner_id)
            ? String(order.partner_id[0] || '')
            : '';
        const name = Array.isArray(order.partner_id)
            ? String(order.partner_id[1] || '').trim()
            : '';
        if (!id) {
            return;
        }
        const existing = customerSpend.get(id) || {
            id,
            name: name || 'Unknown customer',
            total: 0,
            orders: 0,
            prevTotal: 0,
            prevOrders: 0,
        };
        const amount = Number(order.amount_total) || 0;
        if (field === 'current') {
            existing.total += amount;
            existing.orders += 1;
        }
        else {
            existing.prevTotal += amount;
            existing.prevOrders += 1;
        }
        if (name) {
            existing.name = name;
        }
        customerSpend.set(id, existing);
    };
    const bumpArea = (order, field) => {
        const partnerId = Array.isArray(order.partner_id)
            ? Number(order.partner_id[0])
            : 0;
        const meta = partnerMeta.get(partnerId) || {
            key: 'unknown',
            name: 'Unknown area',
            stateId: null,
            stateName: 'Unknown state',
        };
        const existing = areaSpend.get(meta.key) || {
            key: meta.key,
            name: meta.name,
            stateId: meta.stateId,
            stateName: meta.stateName,
            total: 0,
            orders: 0,
            prevTotal: 0,
            prevOrders: 0,
        };
        const amount = Number(order.amount_total) || 0;
        if (field === 'current') {
            existing.total += amount;
            existing.orders += 1;
        }
        else {
            existing.prevTotal += amount;
            existing.prevOrders += 1;
        }
        areaSpend.set(meta.key, existing);
    };
    for (const order of saleOrders) {
        bumpCustomer(order, 'current');
        bumpArea(order, 'current');
    }
    for (const order of prevSaleOrders) {
        bumpCustomer(order, 'prev');
        bumpArea(order, 'prev');
    }
    const customers = [...customerSpend.values()]
        .filter(row => row.total > 0)
        .sort((a, b) => b.total - a.total || b.prevTotal - a.prevTotal);
    const areas = [...areaSpend.values()].sort((a, b) => b.total - a.total || b.prevTotal - a.prevTotal);
    const stateMap = new Map();
    for (const area of areas) {
        if (area.stateId && area.stateName && area.stateName !== 'Unknown state') {
            stateMap.set(area.stateId, area.stateName);
        }
    }
    const states = [...stateMap.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        period,
        range: { from: fromStr, to: toStr },
        compareRange: { from: prevFromStr, to: prevToStr },
        compareLabel: 'Last month',
        customers,
        areas,
        states,
    };
}
function mapPeriodOrder(order) {
    return {
        id: String(order.id),
        number: String(order.name || ''),
        partner: Array.isArray(order.partner_id)
            ? String(order.partner_id[1] || '').trim()
            : '',
        total: Number(order.amount_total) || 0,
        orderDate: String(order.date_order || ''),
        status: String(order.state || ''),
    };
}
/** Full sale or purchase orders for Overview View detail. */
export async function fetchOverviewOrders(userId, period, type, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const compare = options?.compare === true;
    const window = buildPeriodWindow(period);
    const lastMonth = buildLastMonthWindow();
    const fromStr = toOdooDatetime(window.from);
    const toStr = toOdooDatetime(window.to);
    const prevFromStr = toOdooDatetime(lastMonth.from);
    const prevToStr = toOdooDatetime(lastMonth.to);
    const model = type === 'purchase' ? 'purchase.order' : 'sale.order';
    const currentDomain = type === 'purchase'
        ? paidPurchaseDomain(fromStr, toStr)
        : paidSaleDomain(fromStr, toStr);
    const prevDomain = type === 'purchase'
        ? paidPurchaseDomain(prevFromStr, prevToStr)
        : paidSaleDomain(prevFromStr, prevToStr);
    const fields = type === 'purchase'
        ? PURCHASE_ORDER_LIST_FIELDS
        : ['id', 'name', 'date_order', 'partner_id', 'amount_total', 'state'];
    const [currentRows, prevRows] = await Promise.all([
        searchReadOdooRecords(session, model, currentDomain, fields, { order: 'date_order desc, id desc', limit: 2000 }),
        compare
            ? searchReadOdooRecords(session, model, prevDomain, fields, { order: 'amount_total desc, id desc', limit: 2000 })
            : Promise.resolve([]),
    ]);
    const orders = currentRows
        .map(mapPeriodOrder)
        .filter(row => row.total > 0);
    const prevOrders = prevRows
        .map(mapPeriodOrder)
        .filter(row => row.total > 0);
    return {
        period,
        type,
        range: { from: fromStr, to: toStr },
        compareRange: { from: prevFromStr, to: prevToStr },
        compareLabel: 'Last month',
        orders,
        prevOrders,
    };
}
async function productDemandFromOrders(session, orderIds) {
    const productTotals = new Map();
    if (orderIds.length === 0) {
        return productTotals;
    }
    const chunkSize = 200;
    for (let i = 0; i < orderIds.length; i += chunkSize) {
        const chunk = orderIds.slice(i, i + chunkSize);
        let lines = [];
        try {
            lines = await searchReadOdooRecords(session, 'sale.order.line', [
                ['order_id', 'in', chunk],
                ['display_type', '=', false],
            ], [
                'id',
                'product_id',
                'price_subtotal',
                'product_uom_qty',
                'display_type',
            ], { limit: 2000 });
        }
        catch {
            lines = await searchReadOdooRecords(session, 'sale.order.line', [['order_id', 'in', chunk]], ['id', 'product_id', 'price_subtotal', 'product_uom_qty'], { limit: 2000 });
        }
        for (const line of lines) {
            if (line.display_type) {
                continue;
            }
            const productId = Array.isArray(line.product_id)
                ? String(line.product_id[0])
                : '';
            const productName = Array.isArray(line.product_id)
                ? String(line.product_id[1] || '').trim()
                : '';
            const qty = Number(line.product_uom_qty) || 0;
            if (!productId || !productName || qty <= 0) {
                continue;
            }
            const existing = productTotals.get(productId) || {
                id: productId,
                name: productName,
                revenue: 0,
                qty: 0,
            };
            existing.revenue += Number(line.price_subtotal) || 0;
            existing.qty += qty;
            productTotals.set(productId, existing);
        }
    }
    return productTotals;
}
/** Highest-demand products for Overview View detail. */
export async function fetchOverviewDemand(userId, period, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const compare = options?.compare === true;
    const window = buildPeriodWindow(period);
    const lastMonth = buildLastMonthWindow();
    const fromStr = toOdooDatetime(window.from);
    const toStr = toOdooDatetime(window.to);
    const prevFromStr = toOdooDatetime(lastMonth.from);
    const prevToStr = toOdooDatetime(lastMonth.to);
    const [saleOrders, prevSaleOrders] = await Promise.all([
        searchReadOdooRecords(session, 'sale.order', paidSaleDomain(fromStr, toStr), ['id', 'amount_total'], { order: 'date_order desc, id desc', limit: 2000 }),
        compare
            ? searchReadOdooRecords(session, 'sale.order', paidSaleDomain(prevFromStr, prevToStr), ['id', 'amount_total'], { limit: 2000 })
            : Promise.resolve([]),
    ]);
    const currentIds = saleOrders
        .filter(order => (Number(order.amount_total) || 0) > 0)
        .map(order => order.id);
    const prevIds = prevSaleOrders
        .filter(order => (Number(order.amount_total) || 0) > 0)
        .map(order => order.id);
    const [currentTotals, prevTotals] = await Promise.all([
        productDemandFromOrders(session, currentIds),
        compare
            ? productDemandFromOrders(session, prevIds)
            : Promise.resolve(new Map()),
    ]);
    const ids = new Set([...currentTotals.keys(), ...prevTotals.keys()]);
    const stockIds = [...ids]
        .map(id => Number(id))
        .filter(id => Number.isFinite(id) && id > 0);
    const stockByProductId = new Map();
    if (stockIds.length > 0) {
        try {
            const extra = await searchReadOdooRecords(session, 'product.product', [['id', 'in', stockIds]], ['id', 'qty_available'], { limit: stockIds.length });
            for (const row of extra) {
                stockByProductId.set(row.id, Number(row.qty_available) || 0);
            }
        }
        catch (error) {
            console.warn('[insights] Demand stock lookup failed:', error instanceof Error ? error.message : error);
        }
    }
    const products = [...ids]
        .map(id => {
        const current = currentTotals.get(id);
        const prev = prevTotals.get(id);
        const idNum = Number(id);
        return {
            id,
            name: current?.name || prev?.name || `Product #${id}`,
            demandQty: current?.qty ?? 0,
            prevDemandQty: prev?.qty ?? 0,
            onHand: stockByProductId.get(idNum) ?? 0,
            revenue: current?.revenue ?? 0,
            prevRevenue: prev?.revenue ?? 0,
        };
    })
        .filter(row => row.demandQty > 0 || row.prevDemandQty > 0)
        .sort((a, b) => b.demandQty - a.demandQty || b.prevDemandQty - a.prevDemandQty);
    return {
        period,
        range: { from: fromStr, to: toStr },
        compareRange: { from: prevFromStr, to: prevToStr },
        compareLabel: 'Last month',
        products,
    };
}
/** Last 6 calendar months in Asia/Yangon, including the current month. */
function buildSixMonthWindow(now = new Date()) {
    const { y, m } = yangonParts(now);
    const fromUtc = Date.UTC(y, m - 6, 1) - 6.5 * 60 * 60 * 1000;
    const toUtc = Date.UTC(y, m, 1) - 6.5 * 60 * 60 * 1000;
    const months = [];
    for (let i = 5; i >= 0; i -= 1) {
        const monthIndex = m - 1 - i;
        const year = y + Math.floor(monthIndex / 12);
        const mon = ((monthIndex % 12) + 12) % 12;
        months.push(`${year}-${pad2(mon + 1)}`);
    }
    return {
        from: new Date(fromUtc),
        to: new Date(toUtc),
        months,
    };
}
function yangonMonthKeyFromOdooDate(value) {
    const date = parseOdooDate(value);
    if (!date) {
        return '';
    }
    const { y, m } = yangonParts(date);
    return `${y}-${pad2(m)}`;
}
async function searchReadAllPaidSaleOrders(session, fromStr, toStr) {
    const pageSize = 500;
    const maxPages = 40;
    const all = [];
    const domain = paidSaleDomain(fromStr, toStr);
    const fields = [
        'id',
        'name',
        'date_order',
        'partner_id',
        'amount_total',
        'state',
    ];
    for (let page = 0; page < maxPages; page += 1) {
        const rows = await searchReadOdooRecords(session, 'sale.order', domain, fields, {
            order: 'date_order asc, id asc',
            limit: pageSize,
            offset: page * pageSize,
        });
        all.push(...rows);
        if (rows.length < pageSize) {
            break;
        }
    }
    return all.filter(order => (Number(order.amount_total) || 0) > 0);
}
/**
 * Export rows for Overview View detail — last 6 Yangon calendar months.
 * topic: customers | sales | products
 */
export async function fetchOverviewSixMonthExport(userId, topic) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const window = buildSixMonthWindow();
    const fromStr = toOdooDatetime(window.from);
    const toStr = toOdooDatetime(window.to);
    const stamp = yangonDateKey(new Date());
    const orders = await searchReadAllPaidSaleOrders(session, fromStr, toStr);
    if (topic === 'sales') {
        const rows = orders.map(order => {
            const month = yangonMonthKeyFromOdooDate(order.date_order);
            const partner = Array.isArray(order.partner_id)
                ? String(order.partner_id[1] || '').trim()
                : '';
            return [
                month,
                String(order.name || ''),
                partner || '—',
                Number(order.amount_total) || 0,
                String(order.date_order || ''),
                String(order.state || ''),
            ];
        });
        return {
            topic,
            range: { from: fromStr, to: toStr },
            months: window.months,
            headers: [
                'Month',
                'Order',
                'Customer',
                'Total (MMK)',
                'Order date',
                'Status',
            ],
            rows,
            filename: `overview-sale-orders-6-months-${stamp}.xlsx`,
            sheetName: 'Sale orders',
        };
    }
    if (topic === 'customers') {
        const spend = new Map();
        for (const order of orders) {
            const month = yangonMonthKeyFromOdooDate(order.date_order);
            if (!month) {
                continue;
            }
            const id = Array.isArray(order.partner_id)
                ? String(order.partner_id[0] || '')
                : '';
            const name = Array.isArray(order.partner_id)
                ? String(order.partner_id[1] || '').trim()
                : '';
            if (!id) {
                continue;
            }
            const key = `${month}::${id}`;
            const existing = spend.get(key) || {
                month,
                id,
                name: name || 'Unknown customer',
                total: 0,
                orders: 0,
            };
            existing.total += Number(order.amount_total) || 0;
            existing.orders += 1;
            if (name) {
                existing.name = name;
            }
            spend.set(key, existing);
        }
        const rows = [...spend.values()]
            .sort((a, b) => a.month.localeCompare(b.month) ||
            b.total - a.total ||
            a.name.localeCompare(b.name))
            .map(row => [row.month, row.id, row.name, row.total, row.orders]);
        return {
            topic,
            range: { from: fromStr, to: toStr },
            months: window.months,
            headers: [
                'Month',
                'Customer ID',
                'Customer',
                'Total (MMK)',
                'Orders',
            ],
            rows,
            filename: `overview-customers-6-months-${stamp}.xlsx`,
            sheetName: 'Customers',
        };
    }
    // products — demand by month from sale order lines
    const byMonthIds = new Map();
    for (const order of orders) {
        const month = yangonMonthKeyFromOdooDate(order.date_order);
        if (!month) {
            continue;
        }
        const list = byMonthIds.get(month) || [];
        list.push(order.id);
        byMonthIds.set(month, list);
    }
    const productRows = [];
    for (const month of window.months) {
        const ids = byMonthIds.get(month) || [];
        const totals = await productDemandFromOrders(session, ids);
        const sorted = [...totals.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);
        for (const product of sorted) {
            productRows.push([
                month,
                product.id,
                product.name,
                product.qty,
                product.revenue,
            ]);
        }
    }
    return {
        topic,
        range: { from: fromStr, to: toStr },
        months: window.months,
        headers: [
            'Month',
            'Product ID',
            'Product',
            'Qty',
            'Revenue (MMK)',
        ],
        rows: productRows,
        filename: `overview-products-6-months-${stamp}.xlsx`,
        sheetName: 'Products',
    };
}
const BOM_LIST_FIELDS = [
    'id',
    'code',
    'product_tmpl_id',
    'product_id',
    'product_qty',
    'uom_id',
    'type',
    'company_id',
    'active',
];
const BOM_LINE_FIELDS = [
    'id',
    'bom_id',
    'product_id',
    'product_qty',
    'uom_id',
    'sequence',
];
/**
 * List Bills of Materials (Odoo 19.2 Manufacturing → Products → Bills of Materials).
 */
export async function fetchOdooBoms(userId, options) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const limit = options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
        ? Math.min(Math.floor(options.limit), 500)
        : 200;
    const offset = options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
        ? Math.floor(options.offset)
        : 0;
    const domain = [['active', '=', true]];
    const q = String(options?.q ?? '').trim();
    if (q) {
        domain.push('|');
        domain.push(['code', 'ilike', q]);
        domain.push(['product_tmpl_id', 'ilike', q]);
    }
    return searchReadOdooRecords(session, 'mrp.bom', domain, [...BOM_LIST_FIELDS], { order: 'sequence asc, id desc', limit, offset });
}
export async function fetchOdooBomById(userId, bomId) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    const rows = await searchReadOdooRecords(session, 'mrp.bom', [['id', '=', bomId]], [...BOM_LIST_FIELDS], { limit: 1 });
    const bom = rows[0];
    if (!bom)
        return null;
    const lines = await searchReadOdooRecords(session, 'mrp.bom.line', [['bom_id', '=', bomId]], [...BOM_LINE_FIELDS], { order: 'sequence asc, id asc' });
    return { bom, lines };
}
/**
 * Create a BoM (Odoo 19.2). Accepts a product.product id and maps to product_tmpl_id.
 */
export async function createOdooBom(userId, input) {
    const session = getOdooSession(userId);
    if (!session) {
        throw new Error('Odoo session expired. Please log in again.');
    }
    if (!Number.isFinite(input.productId) || input.productId <= 0) {
        throw new Error('A valid product is required.');
    }
    if (!input.lines.length) {
        throw new Error('Add at least one component before saving.');
    }
    const productRow = await readOdooRecordAsUser(session, 'product.product', input.productId, ['product_tmpl_id']);
    const templateId = templateIdFromProduct(productRow ?? {});
    if (!templateId) {
        throw new Error('Could not resolve the product template for this product.');
    }
    const qty = input.quantity !== undefined && Number.isFinite(input.quantity) && input.quantity > 0
        ? input.quantity
        : 1;
    const bomType = (input.type || 'normal').trim() || 'normal';
    const lineCommands = input.lines.map(line => [
        0,
        0,
        {
            product_id: line.productId,
            product_qty: line.quantity,
        },
    ]);
    const values = {
        product_tmpl_id: templateId,
        product_qty: qty,
        type: bomType,
        bom_line_ids: lineCommands,
    };
    const code = input.code?.trim();
    if (code) {
        values.code = code;
    }
    try {
        const id = await createOdooRecordAsUser(session, 'mrp.bom', values);
        return { id };
    }
    catch (error) {
        // Some DBs only allow normal/phantom — retry without subcontracting type.
        if (bomType !== 'normal' && bomType !== 'phantom') {
            values.type = 'normal';
            const id = await createOdooRecordAsUser(session, 'mrp.bom', values);
            return { id };
        }
        throw error;
    }
}
