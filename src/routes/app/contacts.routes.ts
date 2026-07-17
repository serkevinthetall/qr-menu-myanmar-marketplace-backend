import { Router } from 'express';

import { authMiddleware } from '../../middleware/auth.js';
import { fetchOdooContactsForQuotation } from '../../services/odoo.service.js';
import { AuthRequest } from '../../types/auth.js';

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

router.use(authMiddleware);

/** Lean contact list for handheld sales-rep app. */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    // Fetch a page; if searching, pull a larger window then filter locally
    // (Odoo ilike domain can be added later without changing the app contract).
    const fetchLimit = q ? Math.min(limit + offset + 200, 500) : limit;
    const fetchOffset = q ? 0 : offset;

    const contacts = await fetchOdooContactsForQuotation(req.user!.id, {
      limit: fetchLimit,
      offset: fetchOffset,
    });

    let data = contacts.map(contact => ({
      id: String(contact.id),
      name: contact.name,
      phone: toStringValue(contact.phone),
      email: toStringValue(contact.email),
      city: toStringValue(contact.city),
      township: toRelationName(contact.x_studio_many2one_field_8u9_1jp4l7r0g),
      company: toRelationName(contact.parent_id),
      isCompany: Boolean(contact.is_company),
    }));

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

export default router;
