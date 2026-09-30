import { Router } from 'express';

import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  CachedContactListItem,
  invalidateContactListCache,
  loadContactListCache,
  maxContactWriteDate,
  mergeAndSaveContactListCache,
  saveContactListCache,
  sliceContactList,
} from '../services/contact-list-cache.store.js';
import {
  createOdooContact,
  fetchOdooContactById,
  fetchOdooContacts,
  fetchOdooContactsForQuotation,
  fetchOdooPartnerAddressOptions,
  fetchOdooPartnerCategoryNames,
  fetchOdooPartnerPortalStatus,
  fetchOdooPartnerTags,
  fetchOdooTownshipForPartner,
  fetchOdooTownships,
  grantOdooPartnerPortalAccess,
  resolvePartnerLocation,
  searchOdooContactsByPhone,
  updateOdooContact,
  fetchOdooContactsByIds,
  type OdooContact,
} from '../services/odoo.service.js';
import { splitTagNames, validateMyanmarPhone } from '../utils/myanmar-phone.js';
import { assertPortalPassword } from '../utils/portal-password.js';
import { AuthRequest } from '../types/auth.js';

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

/** Odoo many2one fields come back as [id, "Display Name"] (or false). */
function toRelationName(value: unknown): string {
  if (Array.isArray(value)) {
    return toStringValue(value[1]);
  }
  return toStringValue(value);
}

function toRelationId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') {
    return value[0];
  }
  return 0;
}

function toManyIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is number => typeof item === 'number');
}

async function buildCustomerDetailResponse(
  userId: string,
  contactId: number,
) {
  const contact = await fetchOdooContactById(userId, contactId);
  if (!contact) {
    return null;
  }

  const contactEmail = toStringValue(contact.email);
  const townshipRelationId = toRelationId(
    contact.x_studio_many2one_field_8u9_1jp4l7r0g,
  );
  const hasTownshipLabel = Boolean(
    toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
  );
  // Township many2one usually already carries the display name. Only hit the
  // township model when we still need state/zip/country enrichment.
  const needsTownshipEnrichment =
    townshipRelationId > 0 &&
    (!hasTownshipLabel ||
      (!toRelationId(contact.state_id) &&
        !toStringValue(contact.zip) &&
        !toRelationId(contact.country_id)));

  const [tagNames, township, portal] = await Promise.all([
    fetchOdooPartnerCategoryNames(userId, toManyIds(contact.category_id)),
    needsTownshipEnrichment
      ? fetchOdooTownshipForPartner(userId, contact)
      : Promise.resolve(null),
    fetchOdooPartnerPortalStatus(userId, contactId, {
      email: contactEmail,
    }).catch(() => ({
      hasEmail: Boolean(contactEmail),
      email: contactEmail,
      granted: false,
      login: '',
      userId: null as number | null,
    })),
  ]);

  const location = resolvePartnerLocation(contact, township);

  return {
    id: String(contact.id),
    name: toStringValue(contact.name),
    relatedCompany: toRelationName(contact.parent_id),
    relatedCompanyId: toRelationId(contact.parent_id) || null,
    email: toStringValue(contact.email),
    phone: toStringValue(contact.phone),
    street: toStringValue(contact.street),
    street2: toStringValue(contact.street2),
    township: location.township,
    townshipId: townshipRelationId > 0 ? String(townshipRelationId) : null,
    city: location.city,
    state: location.state,
    stateId: location.stateId,
    zip: location.zip,
    country: location.country,
    countryId: location.countryId,
    tags: tagNames.join(', '),
    tagIds: toManyIds(contact.category_id).map(String),
    memberCode: toStringValue(contact.x_studio_member_code),
    appPromoter: toStringValue(contact.x_studio_app_promoter),
    portalAccess: {
      hasEmail: portal.hasEmail,
      email: portal.email,
      granted: portal.granted,
      login: portal.login,
    },
  };
}

router.use(authMiddleware);

function mapOdooContactToListItem(contact: OdooContact): CachedContactListItem {
  const extra: Record<string, string> = {};
  for (const field of env.odooContactExtraFields) {
    extra[field] = toStringValue(contact[field]);
  }
  const activeRaw = contact.active;
  const active =
    typeof activeRaw === 'boolean' ? activeRaw : activeRaw !== false;

  return {
    id: String(contact.id),
    name: toStringValue(contact.name),
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
    writeDate: toStringValue(contact.write_date),
    active,
    extra,
  };
}

/** Background warm of the full Redis catalog (non-blocking). */
function warmContactListCache(userId: string, suppliersOnly: boolean) {
  void (async () => {
    try {
      const rows = await fetchOdooContacts(userId, { suppliersOnly });
      const mapped = rows.map(mapOdooContactToListItem);
      await saveContactListCache(suppliersOnly, mapped);
    } catch (error) {
      console.warn(
        '[customers] Redis warm failed:',
        error instanceof Error ? error.message : error,
      );
    }
  })();
}

router.get('/', async (req: AuthRequest, res) => {
  try {
    const lite = String(req.query.lite ?? '') === '1';
    const suppliersOnly =
      String(req.query.vendors ?? '') === '1' ||
      String(req.query.suppliers ?? '') === '1';
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();
    const since = String(req.query.since ?? '').trim();

    if (lite) {
      const contacts = await fetchOdooContactsForQuotation(req.user!.id, {
        limit,
        offset,
        q: q || undefined,
        suppliersOnly,
      });
      const data = contacts.map(mapOdooContactToListItem);
      const effectiveLimit = limit ?? 500;
      return res.json({
        data,
        meta: {
          limit: effectiveLimit,
          offset,
          count: data.length,
          hasMore: data.length >= effectiveLimit,
          cache: 'bypass',
        },
      });
    }

    const cached = await loadContactListCache(suppliersOnly);

    // Incremental sync: always ask Odoo for the small delta, then merge into Redis.
    if (since) {
      const rows = await fetchOdooContacts(req.user!.id, {
        suppliersOnly,
        since,
        limit,
        offset,
      });
      const data = rows.map(mapOdooContactToListItem);
      void mergeAndSaveContactListCache(suppliersOnly, data);
      const effectiveLimit = limit ?? data.length;
      return res.json({
        data,
        meta: {
          limit: effectiveLimit,
          offset,
          count: data.length,
          hasMore: limit !== undefined ? data.length >= effectiveLimit : false,
          since,
          cache: cached ? 'merge' : 'miss',
        },
      });
    }

    // Paged list from Redis when available.
    if (limit !== undefined) {
      if (cached?.contacts.length) {
        const sliced = sliceContactList(cached.contacts, limit, offset);
        return res.json({
          data: sliced.data,
          meta: {
            limit,
            offset,
            count: sliced.data.length,
            hasMore: sliced.hasMore,
            since: cached.since || maxContactWriteDate(cached.contacts),
            cache: 'hit',
          },
        });
      }

      const rows = await fetchOdooContacts(req.user!.id, {
        suppliersOnly,
        limit,
        offset,
      });
      const data = rows.map(mapOdooContactToListItem);
      // First page miss → warm full catalog in Redis for later hits.
      if (offset === 0) {
        warmContactListCache(req.user!.id, suppliersOnly);
      }
      return res.json({
        data,
        meta: {
          limit,
          offset,
          count: data.length,
          hasMore: data.length >= limit,
          since: null,
          cache: 'miss',
        },
      });
    }

    // Full list (no limit): Redis first.
    if (cached?.contacts.length) {
      return res.json({
        data: cached.contacts,
        meta: {
          limit: cached.contacts.length,
          offset: 0,
          count: cached.contacts.length,
          hasMore: false,
          since: cached.since || maxContactWriteDate(cached.contacts),
          cache: 'hit',
        },
      });
    }

    const rows = await fetchOdooContacts(req.user!.id, { suppliersOnly });
    const data = rows.map(mapOdooContactToListItem);
    await saveContactListCache(suppliersOnly, data);
    return res.json({
      data,
      meta: {
        limit: data.length,
        offset: 0,
        count: data.length,
        hasMore: false,
        since: maxContactWriteDate(data),
        cache: 'miss',
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load contacts.';
    console.error('[customers] Failed to load contacts:', message);
    return res.status(500).json({ message });
  }
});

router.get('/townships', async (req: AuthRequest, res) => {
  try {
    const townships = await fetchOdooTownships(req.user!.id);

    const seen = new Set<string>();
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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load townships.';
    console.error('[customers] Failed to load townships:', message);
    return res.status(500).json({ message });
  }
});

router.get('/tags', async (req: AuthRequest, res) => {
  try {
    const tags = await fetchOdooPartnerTags(req.user!.id);

    const data = tags.map(tag => ({
      id: String(tag.id),
      name: toStringValue(tag.name),
    }));

    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load contact tags.';
    console.error('[customers] Failed to load contact tags:', message);
    return res.status(500).json({ message });
  }
});

router.get('/search', async (req: AuthRequest, res) => {
  const phone = toStringValue(req.query.phone).trim();

  if (!phone) {
    return res.status(400).json({ message: 'Phone number is required.' });
  }

  try {
    validateMyanmarPhone(phone, 'Phone number');
    const contacts = await searchOdooContactsByPhone(req.user!.id, phone);

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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to search contacts.';
    console.error('[customers] Failed to search contacts:', message);
    return res.status(400).json({ message });
  }
});

router.post('/', async (req: AuthRequest, res) => {
  const name = toStringValue(req.body?.name).trim();
  const email = toStringValue(req.body?.email).trim();
  const phoneRaw = toStringValue(req.body?.phone).trim();
  const street = toStringValue(req.body?.street).trim();
  const street2 = toStringValue(req.body?.street2).trim();
  const tagIdsRaw = req.body?.tagIds;
  const tagsRaw = toStringValue(req.body?.tags).trim();
  const townshipId = Number(req.body?.townshipId);
  const asVendor = Boolean(req.body?.asVendor);
  const isCompany =
    req.body?.isCompany === undefined ? undefined : Boolean(req.body.isCompany);
  const vat = toStringValue(req.body?.vat).trim();
  const website = toStringValue(req.body?.website).trim();
  const jobPosition = toStringValue(req.body?.jobPosition).trim();
  const expoPushToken = toStringValue(req.body?.expoPushToken).trim();

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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid phone number.';
    return res.status(400).json({ message });
  }

  try {
    const existing = await searchOdooContactsByPhone(req.user!.id, phone);
    if (existing.length > 0) {
      return res.status(409).json({
        message:
          'A contact with this phone number already exists. Open the existing contact instead of creating a new one.',
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

    const created = await createOdooContact(req.user!.id, {
      name,
      email: email || undefined,
      phone,
      street: street || undefined,
      street2: street2 || undefined,
      townshipId,
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      tagNames: tagIds.length > 0 ? undefined : splitTagNames(tagsRaw),
      asVendor,
      isCompany,
      vat: vat || undefined,
      website: website || undefined,
      jobPosition: jobPosition || undefined,
      expoPushToken: expoPushToken || undefined,
    });

    await invalidateContactListCache();

    const createdRows = await fetchOdooContactsByIds(req.user!.id, [created.id]);
    const contact = createdRows[0];

    if (!contact) {
      warmContactListCache(req.user!.id, false);
      if (asVendor) warmContactListCache(req.user!.id, true);
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
          writeDate: '',
          active: true,
          extra: {},
        },
      });
    }

    const mapped = mapOdooContactToListItem(contact);
    warmContactListCache(req.user!.id, false);
    if (asVendor) warmContactListCache(req.user!.id, true);

    return res.status(201).json({ data: mapped });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create contact.';
    console.error('[customers] Failed to create contact:', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id/addresses', async (req: AuthRequest, res) => {
  const contactId = Number(req.params.id);

  if (!Number.isFinite(contactId) || contactId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  try {
    const result = await fetchOdooPartnerAddressOptions(req.user!.id, contactId);

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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load delivery addresses.';
    console.error('[customers] Failed to load addresses:', message);
    return res.status(500).json({ message });
  }
});

router.post('/:id/addresses', async (req: AuthRequest, res) => {
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid phone number.';
      return res.status(400).json({ message });
    }
  }

  try {
    const created = await createOdooContact(req.user!.id, {
      name,
      phone: phone || undefined,
      street: street || undefined,
      street2: street2 || undefined,
      townshipId,
      parentId,
      type: 'delivery',
    });

    const result = await fetchOdooPartnerAddressOptions(req.user!.id, parentId);
    const createdAddress =
      result.addresses.find(address => address.id === created.id) ?? null;

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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create delivery address.';
    console.error('[customers] Failed to create address:', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const contactId = Number(req.params.id);

  if (!Number.isFinite(contactId) || contactId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  try {
    const data = await buildCustomerDetailResponse(req.user!.id, contactId);

    if (!data) {
      return res.status(404).json({ message: 'Contact not found.' });
    }

    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load contact detail.';
    console.error('[customers] Failed to load contact detail:', message);
    return res.status(500).json({ message });
  }
});

/** PATCH /api/customers/:id — update contact fields. */
router.patch('/:id', async (req: AuthRequest, res) => {
  const contactId = Number(req.params.id);
  if (!Number.isFinite(contactId) || contactId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  const name = toStringValue(req.body?.name).trim();
  const phoneRaw = toStringValue(req.body?.phone).trim();
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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid phone number.';
    return res.status(400).json({ message });
  }

  const tagIdsRaw = req.body?.tagIds;
  const tagIds = Array.isArray(tagIdsRaw)
    ? tagIdsRaw
        .map(id => Number(id))
        .filter(id => Number.isFinite(id) && id > 0)
    : [];

  try {
    await updateOdooContact(req.user!.id, contactId, {
      name,
      email: toStringValue(req.body?.email).trim() || undefined,
      phone,
      street: toStringValue(req.body?.street).trim() || undefined,
      street2: toStringValue(req.body?.street2).trim() || undefined,
      townshipId,
      tagIds,
    });

    await invalidateContactListCache();
    warmContactListCache(req.user!.id, false);

    const data = await buildCustomerDetailResponse(req.user!.id, contactId);
    if (!data) {
      return res.status(404).json({ message: 'Contact not found.' });
    }

    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update contact.';
    console.error('[customers] patch contact', message);
    const lower = message.toLowerCase();
    let status = 502;
    if (/session expired/i.test(message)) status = 401;
    else if (/not found/i.test(message)) status = 404;
    else if (
      lower.includes('required') ||
      lower.includes('valid email') ||
      lower.includes('already') ||
      lower.includes('phone')
    ) {
      status = 400;
    }
    return res.status(status).json({ message });
  }
});

/** POST /api/customers/:id/portal-access — grant portal user + set password. */
router.post('/:id/portal-access', async (req: AuthRequest, res) => {
  const contactId = Number(req.params.id);
  if (!Number.isFinite(contactId) || contactId <= 0) {
    return res.status(400).json({ message: 'Invalid contact id.' });
  }

  let password: string;
  try {
    password = assertPortalPassword(req.body?.password);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Password is required.';
    return res.status(400).json({ message });
  }

  try {
    const portal = await grantOdooPartnerPortalAccess(
      req.user!.id,
      contactId,
      password,
    );
    return res.json({
      data: {
        hasEmail: portal.hasEmail,
        email: portal.email,
        granted: portal.granted,
        login: portal.login,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to grant portal access.';
    console.error('[customers] portal-access', message);
    const lower = message.toLowerCase();
    let status = 502;
    if (/session expired/i.test(message)) status = 401;
    else if (/not found/i.test(message)) status = 404;
    else if (
      lower.includes('please enter the email') ||
      lower.includes('already registered') ||
      lower.includes('password') ||
      lower.includes('invalid contact')
    ) {
      status = 400;
    }
    return res.status(status).json({ message });
  }
});

export default router;
