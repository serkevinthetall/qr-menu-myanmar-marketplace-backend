/**
 * App Promoter CRUD via Odoo Studio model x_app_promoter.
 * Website creates/edits names, amounts, and active flag in Odoo.
 */
import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  createOdooAppPromoter,
  deleteOdooAppPromoter,
  fetchOdooAppPromoters,
  updateOdooAppPromoter,
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

function odooStatus(message: string): number {
  if (/session expired/i.test(message)) return 401;
  if (/already exists/i.test(message)) return 409;
  if (/not found/i.test(message)) return 404;
  if (
    /required|too long|invalid|nothing to update|must be a number/i.test(
      message,
    )
  ) {
    return 400;
  }
  return 502;
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
    return res.status(odooStatus(message)).json({ message });
  }
});

router.post('/', async (req: AuthRequest, res) => {
  try {
    const created = await createOdooAppPromoter(req.user!.id, {
      name: req.body?.name,
      amountPerCustomer: req.body?.amountPerCustomer,
      active: req.body?.active,
    });
    return res.status(201).json({ data: mapPromoter(created) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create App Promoter.';
    console.error('[app-promoters] create', message);
    return res.status(odooStatus(message)).json({ message });
  }
});

router.put('/:id', async (req: AuthRequest, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid promoter id.' });
  }

  try {
    const updated = await updateOdooAppPromoter(req.user!.id, id, {
      name: req.body?.name,
      amountPerCustomer: req.body?.amountPerCustomer,
      active: req.body?.active,
    });
    return res.json({ data: mapPromoter(updated) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update App Promoter.';
    console.error('[app-promoters] update', message);
    return res.status(odooStatus(message)).json({ message });
  }
});

router.delete('/:id', async (req: AuthRequest, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ message: 'Invalid promoter id.' });
  }

  try {
    await deleteOdooAppPromoter(req.user!.id, id);
    return res.json({ data: { id: String(id), removed: true } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to delete App Promoter.';
    console.error('[app-promoters] delete', message);
    return res.status(odooStatus(message)).json({ message });
  }
});

export default router;
