import { Router } from 'express';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createOdooContact, fetchOdooContactById, fetchOdooContacts, fetchOdooPartnerAddressOptions, fetchOdooPartnerCategoryNames, fetchOdooPartnerTags, fetchOdooTownshipForPartner, fetchOdooTownships, resolvePartnerLocation, searchOdooContactsByPhone, } from '../services/odoo.service.js';
import { splitTagNames, validateMyanmarPhone } from '../utils/myanmar-phone.js';
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
/** Odoo many2one fields come back as [id, "Display Name"] (or false). */
function toRelationName(value) {
    if (Array.isArray(value)) {
        return toStringValue(value[1]);
    }
    return toStringValue(value);
}
function toRelationId(value) {
    if (Array.isArray(value) && typeof value[0] === 'number') {
        return value[0];
    }
    return 0;
}
function toManyIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === 'number');
}
router.use(authMiddleware);
router.get('/', async (req, res) => {
    try {
        const contacts = await fetchOdooContacts(req.user.id);
        const data = contacts.map(contact => {
            const extra = {};
            for (const field of env.odooContactExtraFields) {
                extra[field] = toStringValue(contact[field]);
            }
            return {
                id: String(contact.id),
                name: contact.name,
                email: toStringValue(contact.email),
                phone: toStringValue(contact.phone),
                city: toStringValue(contact.city),
                jobPosition: toStringValue(contact.function),
                company: toRelationName(contact.parent_id),
                isCompany: Boolean(contact.is_company),
                activity: toStringValue(contact.x_studio_monthly_activity),
                township: toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
                status: toStringValue(contact.x_studio_customer_status),
                lastMonthSales: toNumberValue(contact.x_studio_last_month_sales),
                thisMonthSales: toNumberValue(contact.x_studio_this_month_sales),
                thisMonthPercent: toNumberValue(contact.x_studio_this_month_percent),
                lastInvoiceDate: toStringValue(contact.x_studio_last_invoice_date),
                expoPushToken: toStringValue(contact.x_studio_expo_push_token),
                extra,
            };
        });
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load contacts.';
        console.error('[customers] Failed to load contacts:', message);
        return res.status(500).json({ message });
    }
});
router.get('/townships', async (req, res) => {
    try {
        const townships = await fetchOdooTownships(req.user.id);
        const seen = new Set();
        const data = townships
            .map(township => ({
            id: String(township.id),
            name: toStringValue(township.x_name).replace(/\s+/g, ' ').trim(),
        }))
            .filter(township => {
            if (!township.name) {
                return false;
            }
            const key = township.name.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load townships.';
        console.error('[customers] Failed to load townships:', message);
        return res.status(500).json({ message });
    }
});
router.get('/tags', async (req, res) => {
    try {
        const tags = await fetchOdooPartnerTags(req.user.id);
        const data = tags.map(tag => ({
            id: String(tag.id),
            name: toStringValue(tag.name),
        }));
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load contact tags.';
        console.error('[customers] Failed to load contact tags:', message);
        return res.status(500).json({ message });
    }
});
router.get('/search', async (req, res) => {
    const phone = toStringValue(req.query.phone).trim();
    if (!phone) {
        return res.status(400).json({ message: 'Phone number is required.' });
    }
    try {
        validateMyanmarPhone(phone, 'Phone number');
        const contacts = await searchOdooContactsByPhone(req.user.id, phone);
        const data = contacts.map(contact => ({
            id: String(contact.id),
            name: toStringValue(contact.name),
            phone: toStringValue(contact.phone),
            street: toStringValue(contact.street),
            street2: toStringValue(contact.street2),
            city: toStringValue(contact.city),
            township: toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
            parentId: toRelationId(contact.parent_id)
                ? String(toRelationId(contact.parent_id))
                : null,
            isCompany: Boolean(contact.is_company),
            type: toStringValue(contact.type) || 'contact',
        }));
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to search contacts.';
        console.error('[customers] Failed to search contacts:', message);
        return res.status(400).json({ message });
    }
});
router.post('/', async (req, res) => {
    const name = toStringValue(req.body?.name).trim();
    const email = toStringValue(req.body?.email).trim();
    const phoneRaw = toStringValue(req.body?.phone).trim();
    const street = toStringValue(req.body?.street).trim();
    const street2 = toStringValue(req.body?.street2).trim();
    const tagIdsRaw = req.body?.tagIds;
    const tagsRaw = toStringValue(req.body?.tags).trim();
    const townshipId = Number(req.body?.townshipId);
    if (!name) {
        return res.status(400).json({ message: 'Name is required.' });
    }
    if (!phoneRaw) {
        return res.status(400).json({ message: 'Phone number is required.' });
    }
    if (!Number.isFinite(townshipId) || townshipId <= 0) {
        return res.status(400).json({ message: 'Township is required.' });
    }
    let phone = phoneRaw;
    try {
        phone = validateMyanmarPhone(phoneRaw, 'Phone number');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid phone number.';
        return res.status(400).json({ message });
    }
    try {
        const existing = await searchOdooContactsByPhone(req.user.id, phone);
        if (existing.length > 0) {
            return res.status(409).json({
                message: 'A contact with this phone number already exists. Open the existing contact instead of creating a new one.',
                data: existing.map(contact => ({
                    id: String(contact.id),
                    name: toStringValue(contact.name),
                    phone: toStringValue(contact.phone),
                    street: toStringValue(contact.street),
                    street2: toStringValue(contact.street2),
                    city: toStringValue(contact.city),
                    township: toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
                })),
            });
        }
        const tagIds = Array.isArray(tagIdsRaw)
            ? tagIdsRaw
                .map(id => Number(id))
                .filter(id => Number.isFinite(id) && id > 0)
            : [];
        const created = await createOdooContact(req.user.id, {
            name,
            email: email || undefined,
            phone,
            street: street || undefined,
            street2: street2 || undefined,
            townshipId,
            tagIds: tagIds.length > 0 ? tagIds : undefined,
            tagNames: tagIds.length > 0 ? undefined : splitTagNames(tagsRaw),
        });
        const contacts = await fetchOdooContacts(req.user.id);
        const contact = contacts.find(item => item.id === created.id);
        if (!contact) {
            return res.status(201).json({
                data: {
                    id: String(created.id),
                    name: created.name,
                    email,
                    phone,
                    city: '',
                    jobPosition: '',
                    company: '',
                    isCompany: false,
                    activity: '',
                    township: '',
                    status: '',
                    lastMonthSales: 0,
                    thisMonthSales: 0,
                    thisMonthPercent: 0,
                    lastInvoiceDate: '',
                    expoPushToken: '',
                    extra: {},
                },
            });
        }
        const extra = {};
        for (const field of env.odooContactExtraFields) {
            extra[field] = toStringValue(contact[field]);
        }
        return res.status(201).json({
            data: {
                id: String(contact.id),
                name: contact.name,
                email: toStringValue(contact.email),
                phone: toStringValue(contact.phone),
                city: toStringValue(contact.city),
                jobPosition: toStringValue(contact.function),
                company: toRelationName(contact.parent_id),
                isCompany: Boolean(contact.is_company),
                activity: toStringValue(contact.x_studio_monthly_activity),
                township: toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
                status: toStringValue(contact.x_studio_customer_status),
                lastMonthSales: toNumberValue(contact.x_studio_last_month_sales),
                thisMonthSales: toNumberValue(contact.x_studio_this_month_sales),
                thisMonthPercent: toNumberValue(contact.x_studio_this_month_percent),
                lastInvoiceDate: toStringValue(contact.x_studio_last_invoice_date),
                expoPushToken: toStringValue(contact.x_studio_expo_push_token),
                extra,
            },
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create contact.';
        console.error('[customers] Failed to create contact:', message);
        return res.status(500).json({ message });
    }
});
router.get('/:id/addresses', async (req, res) => {
    const contactId = Number(req.params.id);
    if (!Number.isFinite(contactId) || contactId <= 0) {
        return res.status(400).json({ message: 'Invalid contact id.' });
    }
    try {
        const result = await fetchOdooPartnerAddressOptions(req.user.id, contactId);
        return res.json({
            data: {
                companyId: String(result.companyId),
                companyName: result.companyName,
                defaultAddressId: String(result.defaultAddressId),
                company: {
                    id: String(result.company.id),
                    name: result.company.name,
                    phone: result.company.phone,
                    street: result.company.street,
                    street2: result.company.street2,
                    city: result.company.city,
                    township: result.company.township,
                    parentId: result.company.parentId ? String(result.company.parentId) : null,
                    isCompany: result.company.isCompany,
                    isMain: result.company.isMain,
                    type: result.company.type,
                    label: result.company.label,
                },
                addresses: result.addresses.map(address => ({
                    id: String(address.id),
                    name: address.name,
                    phone: address.phone,
                    street: address.street,
                    street2: address.street2,
                    city: address.city,
                    township: address.township,
                    parentId: address.parentId ? String(address.parentId) : null,
                    isCompany: address.isCompany,
                    isMain: address.isMain,
                    type: address.type,
                    label: address.label,
                })),
            },
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load delivery addresses.';
        console.error('[customers] Failed to load addresses:', message);
        return res.status(500).json({ message });
    }
});
router.post('/:id/addresses', async (req, res) => {
    const parentId = Number(req.params.id);
    const name = toStringValue(req.body?.name).trim();
    const phoneRaw = toStringValue(req.body?.phone).trim();
    const street = toStringValue(req.body?.street).trim();
    const street2 = toStringValue(req.body?.street2).trim();
    const townshipId = Number(req.body?.townshipId);
    if (!Number.isFinite(parentId) || parentId <= 0) {
        return res.status(400).json({ message: 'Invalid company id.' });
    }
    if (!name) {
        return res.status(400).json({ message: 'Address name is required.' });
    }
    if (!Number.isFinite(townshipId) || townshipId <= 0) {
        return res.status(400).json({ message: 'Township is required.' });
    }
    let phone = phoneRaw;
    if (phoneRaw) {
        try {
            phone = validateMyanmarPhone(phoneRaw, 'Phone number');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid phone number.';
            return res.status(400).json({ message });
        }
    }
    try {
        const created = await createOdooContact(req.user.id, {
            name,
            phone: phone || undefined,
            street: street || undefined,
            street2: street2 || undefined,
            townshipId,
            parentId,
            type: 'delivery',
        });
        const result = await fetchOdooPartnerAddressOptions(req.user.id, parentId);
        const createdAddress = result.addresses.find(address => address.id === created.id) ?? null;
        return res.status(201).json({
            data: {
                id: String(created.id),
                name: created.name,
                address: createdAddress
                    ? {
                        id: String(createdAddress.id),
                        name: createdAddress.name,
                        phone: createdAddress.phone,
                        street: createdAddress.street,
                        street2: createdAddress.street2,
                        city: createdAddress.city,
                        township: createdAddress.township,
                        parentId: createdAddress.parentId
                            ? String(createdAddress.parentId)
                            : null,
                        isCompany: createdAddress.isCompany,
                        isMain: createdAddress.isMain,
                        type: createdAddress.type,
                        label: createdAddress.label,
                    }
                    : null,
                companyId: String(result.companyId),
                defaultAddressId: String(created.id),
                addresses: result.addresses.map(address => ({
                    id: String(address.id),
                    name: address.name,
                    phone: address.phone,
                    street: address.street,
                    street2: address.street2,
                    city: address.city,
                    township: address.township,
                    parentId: address.parentId ? String(address.parentId) : null,
                    isCompany: address.isCompany,
                    isMain: address.isMain,
                    type: address.type,
                    label: address.label,
                })),
            },
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create delivery address.';
        console.error('[customers] Failed to create address:', message);
        return res.status(500).json({ message });
    }
});
router.get('/:id', async (req, res) => {
    const contactId = Number(req.params.id);
    if (!Number.isFinite(contactId) || contactId <= 0) {
        return res.status(400).json({ message: 'Invalid contact id.' });
    }
    try {
        const contact = await fetchOdooContactById(req.user.id, contactId);
        if (!contact) {
            return res.status(404).json({ message: 'Contact not found.' });
        }
        const [tagNames, township] = await Promise.all([
            fetchOdooPartnerCategoryNames(req.user.id, toManyIds(contact.category_id)),
            fetchOdooTownshipForPartner(req.user.id, contact),
        ]);
        const location = resolvePartnerLocation(contact, township);
        const data = {
            id: String(contact.id),
            name: toStringValue(contact.name),
            relatedCompany: toRelationName(contact.parent_id),
            relatedCompanyId: toRelationId(contact.parent_id) || null,
            email: toStringValue(contact.email),
            phone: toStringValue(contact.phone),
            street: toStringValue(contact.street),
            street2: toStringValue(contact.street2),
            township: location.township,
            city: location.city,
            state: location.state,
            stateId: location.stateId,
            zip: location.zip,
            country: location.country,
            countryId: location.countryId,
            tags: tagNames.join(', '),
            memberCode: toStringValue(contact.x_studio_member_code),
        };
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load contact detail.';
        console.error('[customers] Failed to load contact detail:', message);
        return res.status(500).json({ message });
    }
});
export default router;
