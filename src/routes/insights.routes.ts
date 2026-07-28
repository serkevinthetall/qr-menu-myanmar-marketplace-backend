import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  generateAiSuggestions,
  getAiSuggestionsStatus,
  isAiInsightsEnabled,
  runDailyInsightRollup,
} from '../services/ai-insights.service.js';
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

function parseSlot(raw: unknown): 'monday' | 'friday' | 'monthly' | 'manual' {
  const value = String(raw ?? 'manual').trim().toLowerCase();
  if (
    value === 'monday' ||
    value === 'friday' ||
    value === 'monthly' ||
    value === 'manual'
  ) {
    return value;
  }
  return 'manual';
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

/**
 * Optional Groq AI suggestions for Overview.
 * Disable with AI_INSIGHTS_ENABLED=false. To remove later: delete this block's
 * routes + ai-insights* / groq.service files and the Overview suggestions card.
 */
router.get('/suggestions', async (_req: AuthRequest, res) => {
  try {
    const status = await getAiSuggestionsStatus();
    return res.json({ data: status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load suggestions.';
    console.error('[insights/suggestions]', message);
    return res.status(500).json({ message });
  }
});

router.post('/suggestions/generate', async (req: AuthRequest, res) => {
  if (!isAiInsightsEnabled()) {
    return res.status(404).json({ message: 'AI insights are disabled.' });
  }
  try {
    const slot = parseSlot(req.body?.slot ?? req.query.slot ?? 'manual');
    // Keep the daily notebook warm whenever a user generates tips.
    await runDailyInsightRollup(req.user!.id).catch(() => undefined);
    const pack = await generateAiSuggestions(req.user!.id, slot);
    return res.json({ data: pack });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to generate suggestions.';
    console.error('[insights/suggestions/generate]', message);
    return res.status(500).json({ message });
  }
});

export default router;
