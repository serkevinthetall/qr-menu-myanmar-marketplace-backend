import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  createOdooPickupPoint,
  fetchOdooPickupPoints,
  updateOdooPickupPoint,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import { toStringValue } from '../utils/quotation-mapper.js';

const router = Router();

function mapRow(
  row: Awaited<ReturnType<typeof fetchOdooPickupPoints>>[number],
) {
  return {
    id: String(row.id),
    name: toStringValue(row.x_name),
    township: toStringValue(row.x_studio_township),
    address: toStringValue(row.x_studio_address),
  };
}

function parseBody(body: unknown): {
  name: string;
  township: string;
  address: string;
} {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    name: String(raw.name ?? '').trim(),
    township: String(raw.township ?? '').trim(),
    address: String(raw.address ?? '').trim(),
  };
}

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();

    const rows = await fetchOdooPickupPoints(req.user!.id, {
      limit,
      offset,
      q,
    });
    const data = rows.map(mapRow);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load pickup points.';
    console.error('[pickup-points]', message);
    return res.status(500).json({ message });
  }
});

router.post('/', async (req: AuthRequest, res) => {
  try {
    const input = parseBody(req.body);
    if (!input.name) {
      return res.status(400).json({ message: 'Name is required.' });
    }
    const row = await createOdooPickupPoint(req.user!.id, input);
    return res.status(201).json({ data: mapRow(row) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create pickup point.';
    console.error('[pickup-points] create', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid pickup point id.' });
    }
    const input = parseBody(req.body);
    if (!input.name) {
      return res.status(400).json({ message: 'Name is required.' });
    }
    const row = await updateOdooPickupPoint(req.user!.id, id, input);
    return res.json({ data: mapRow(row) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update pickup point.';
    console.error('[pickup-points] update', message);
    return res.status(500).json({ message });
  }
});

export default router;
