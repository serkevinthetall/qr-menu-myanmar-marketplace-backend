import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  answerOverviewChat,
  generateAiSuggestions,
  generateCompareAiSuggestions,
  generateSixMonthAiSuggestions,
  getAiSuggestionsStatus,
  isAiInsightsEnabled,
  CompareAiTopic,
  OverviewChatTurn,
} from '../services/ai-insights.service.js';
import {
  fetchOverviewDemand,
  fetchOverviewInsights,
  fetchOverviewOrders,
  fetchOverviewRankings,
  fetchOverviewSixMonthExport,
  OverviewOrderType,
  OverviewPeriod,
  OverviewSixMonthExportTopic,
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

function parseCompare(raw: unknown): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'last_month';
}

function parseOrderType(raw: unknown): OverviewOrderType {
  const value = String(raw ?? 'sale').trim().toLowerCase();
  return value === 'purchase' ? 'purchase' : 'sale';
}

function parseSixMonthExportTopic(raw: unknown): OverviewSixMonthExportTopic {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'customers' || value === 'sales' || value === 'products') {
    return value;
  }
  throw new Error(
    'Invalid export topic. Use customers, sales, or products.',
  );
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

function parseCompareTopic(raw: unknown): CompareAiTopic | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (
    value === 'customers' ||
    value === 'areas' ||
    value === 'sales' ||
    value === 'demand'
  ) {
    return value;
  }
  return null;
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

/** Full sale / purchase order lists for Overview View detail. */
router.get('/orders', async (req: AuthRequest, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const type = parseOrderType(req.query.type);
    const compare = parseCompare(req.query.compare);
    const data = await fetchOverviewOrders(req.user!.id, period, type, {
      compare,
    });
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load orders.';
    console.error('[insights/orders]', message);
    return res.status(500).json({ message });
  }
});

/** Highest-demand products for Overview View detail. */
router.get('/demand', async (req: AuthRequest, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const compare = parseCompare(req.query.compare);
    const data = await fetchOverviewDemand(req.user!.id, period, {
      compare,
    });
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load demand.';
    console.error('[insights/demand]', message);
    return res.status(500).json({ message });
  }
});

/** Six-month Excel source rows for Overview View detail pages. */
router.get('/export/six-month', async (req: AuthRequest, res) => {
  try {
    const topic = parseSixMonthExportTopic(req.query.topic);
    const data = await fetchOverviewSixMonthExport(req.user!.id, topic);
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to build six-month export.';
    console.error('[insights/export/six-month]', message);
    const status = /Invalid export topic/i.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

/** Full customer / area rankings for Overview View detail. */
router.get('/rankings', async (req: AuthRequest, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const compare = parseCompare(req.query.compare);
    const data = await fetchOverviewRankings(req.user!.id, period, {
      compare,
    });
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load rankings.';
    console.error('[insights/rankings]', message);
    return res.status(500).json({ message });
  }
});

/**
 * Optional Groq AI suggestions for Overview.
 * Disable with AI_INSIGHTS_ENABLED=false. To remove later: delete this block's
 * routes + ai-insights* / gemini.service files and the Overview suggestions card.
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
    const pack = await generateAiSuggestions(req.user!.id, slot);
    return res.json({ data: pack });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to generate suggestions.';
    console.error('[insights/suggestions/generate]', message);
    return res.status(500).json({ message });
  }
});

router.post('/suggestions/generate-six-month', async (req: AuthRequest, res) => {
  if (!isAiInsightsEnabled()) {
    return res.status(404).json({ message: 'AI insights are disabled.' });
  }
  try {
    const pack = await generateSixMonthAiSuggestions(req.user!.id);
    return res.json({ data: pack });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to generate suggestions.';
    console.error('[insights/suggestions/generate-six-month]', message);
    return res.status(500).json({ message });
  }
});

function parseChatHistory(raw: unknown): OverviewChatTurn[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const turns: OverviewChatTurn[] = [];
  for (const item of raw.slice(-12)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const role = String(row.role ?? '').trim();
    const content = String(row.content ?? '').trim().slice(0, 2000);
    if ((role === 'user' || role === 'assistant') && content) {
      turns.push({ role, content });
    }
  }
  return turns;
}

router.post('/chat', async (req: AuthRequest, res) => {
  if (!isAiInsightsEnabled()) {
    return res.status(404).json({ message: 'AI insights are disabled.' });
  }
  try {
    const message = String(req.body?.message ?? '').trim();
    if (!message) {
      return res.status(400).json({ message: 'message is required.' });
    }
    const period = parsePeriod(req.body?.period ?? req.query.period);
    const history = parseChatHistory(req.body?.history);
    const data = await answerOverviewChat(
      req.user!.id,
      period,
      message,
      history,
    );
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to send chat.';
    console.error('[insights/chat]', message);
    return res.status(500).json({ message });
  }
});

router.post('/suggestions/compare', async (req: AuthRequest, res) => {
  if (!isAiInsightsEnabled()) {
    return res.status(404).json({ message: 'AI insights are disabled.' });
  }
  try {
    const topic = parseCompareTopic(req.body?.topic ?? req.query.topic);
    if (!topic) {
      return res.status(400).json({
        message: 'topic must be customers, areas, sales, or demand.',
      });
    }
    const period = parsePeriod(req.body?.period ?? req.query.period);
    const pack = await generateCompareAiSuggestions(
      req.user!.id,
      topic,
      period,
    );
    return res.json({ data: pack });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to generate suggestions.';
    console.error('[insights/suggestions/compare]', message);
    return res.status(500).json({ message });
  }
});

export default router;
