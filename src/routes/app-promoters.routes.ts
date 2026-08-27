/**
 * App Promoter list from Odoo Studio model x_app_promoter.
 * Manage names/amounts in Odoo; website is read-only for the Installed dropdown.
 */
import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooAppPromoters,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function mapPromoter(row: {
  id: number;
  name: string;
  amountPerCustomer: number;
  active: boolean;
}) {
  return {
    id: String(row.id),
    name: row.name,
    amountPerCustomer: row.amountPerCustomer,
    active: row.active,
    createdAt: null as string | null,
    updatedAt: null as string | null,
  };
}

/** List promoters from Odoo. ?active=true = Installed dropdown. */
router.get('/', async (req: AuthRequest, res) => {
  try {
    const activeOnly = String(req.query.active ?? '').trim().toLowerCase();
    const rows = await fetchOdooAppPromoters(req.user!.id, {
      activeOnly: activeOnly === 'true' || activeOnly === '1',
    });
    return res.json({ data: rows.map(mapPromoter) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load App Promoters.';
    console.error('[app-promoters] list', message);
    const status = /session expired/i.test(message) ? 401 : 502;
    return res.status(status).json({ message });
  }
});

router.post('/', (_req, res) => {
  return res.status(405).json({
    message: 'Create App Promoters in Odoo (Contacts → App Promoter).',
  });
});

router.put('/:id', (_req, res) => {
  return res.status(405).json({
    message: 'Edit App Promoters in Odoo (Contacts → App Promoter).',
  });
});

router.delete('/:id', (_req, res) => {
  return res.status(405).json({
    message: 'Delete or archive App Promoters in Odoo.',
  });
});

export default router;
