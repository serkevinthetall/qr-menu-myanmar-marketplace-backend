import { Router } from 'express';

import { authMiddleware } from '../../middleware/auth.js';
import {
  createOdooContact,
  fetchOdooContactsForQuotation,
  fetchOdooPartnerAddressOptions,
  fetchOdooTownships,
} from '../../services/odoo.service.js';
import { AuthRequest } from '../../types/auth.js';
import { validateMyanmarPhone } from '../../utils/myanmar-phone.js';

const router = Router();

function toStringValue(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function toRelationName(value: unknown): string {
  if (Array.isArray(value)) {
    return toStringValue(value[1]);
  }
  return toStringValue(value);
}

function mapAppContact(contact: {
  id: number;
  name: string;
  phone?: unknown;
  email?: unknown;
  city?: unknown;
  x_studio_many2one_field_8u9_1jp4l7r0g?: unknown;
  parent_id?: unknown;
  is_company?: unknown;
}) {
  return {
    id: String(contact.id),
    name: contact.name,
    phone: toStringValue(contact.phone),
    email: toStringValue(contact.email),
    city: toStringValue(contact.city),
    township: toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
    company: toRelationName(contact.parent_id),
    isCompany: Boolean(contact.is_company),
  };
}

router.use(authMiddleware);

/** Lean contact list for handheld sales-rep app. */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const fetchLimit = q ? Math.min(limit + offset + 200, 500) : limit;
    const fetchOffset = q ? 0 : offset;

    const contacts = await fetchOdooContactsForQuotation(req.user!.id, {
      limit: fetchLimit,
      offset: fetchOffset,
    });

    let data = contacts.map(mapAppContact);

    if (q) {
      data = data.filter(item => {
        const hay = `${item.name} ${item.phone} ${item.email} ${item.township} ${item.city}`.toLowerCase();
        return hay.includes(q);
      });
      data = data.slice(offset, offset + limit);
    }

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: q ? data.length >= limit : contacts.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load contacts.';
    console.error('[app/contacts]', message);
    return res.status(500).json({ message });
  }
});

/** Townships for create-customer on the phone app. */
router.get('/townships', async (req: AuthRequest, res) => {
  try {
    const townships = await fetchOdooTownships(req.user!.id);
    return res.json({
      data: townships.map(item => ({
        id: String(item.id),
        name: toStringValue(item.x_name),
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load townships.';
    console.error('[app/contacts/townships]', message);
    return res.status(500).json({ message });
  }
});

/** Create a lean customer from the phone app. */
router.post('/', async (req: AuthRequest, res) => {
  const name = toStringValue(req.body?.name).trim();
  const phoneRaw = toStringValue(req.body?.phone).trim();
  const street = toStringValue(req.body?.street).trim();
  const email = toStringValue(req.body?.email).trim();
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

  try {
    const created = await createOdooContact(req.user!.id, {
      name,
      phone,
      street: street || undefined,
      email: email || undefined,
      townshipId,
    });

    return res.status(201).json({
      data: {
        id: String(created.id),
        name: created.name,
        phone,
        email,
        city: '',
        township: '',
        company: '',
        isCompany: false,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create contact.';
    const status = message.includes('already exists') ? 409 : 500;
    console.error('[app/contacts] create', message);
    return res.status(status).json({ message });
  }
});

/** Delivery locations for quotation create (full list for sales-rep picker). */
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
        addresses: result.addresses.map(address => ({
          id: String(address.id),
          name: address.name,
          phone: address.phone,
          street: address.street,
          street2: address.street2,
          city: address.city,
          township: address.township,
          isMain: address.isMain,
          label: address.label,
        })),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load addresses.';
    console.error('[app/contacts/:id/addresses]', message);
    return res.status(500).json({ message });
  }
});

export default router;
