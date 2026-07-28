import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOverviewInsights,
  OverviewPeriod,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function parsePeriod(raw: unknown): OverviewPeriod {
  const value = String(raw ?? 'month').trim().toLowerCase();
  if (value === 'day' || value === 'week' || value === 'month') {
    return value;
  }
  return 'month';
}

router.get('/summary', async (req: AuthRequest, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const data = await fetchOverviewInsights(req.user!.id, period);
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load overview.';
    console.error('[insights]', message);
    return res.status(500).json({ message });
  }
});

export default router;
