import { env } from '../config/env.js';
import { fetchOverviewInsights } from './odoo.service.js';
import { groqChatJson } from './groq.service.js';
import {
  AiSuggestionItem,
  AiSuggestionPack,
  DailyInsightRollup,
  listDailyRollups,
  loadLatestSuggestionPack,
  pruneDailyRollups,
  saveDailyRollup,
  saveSuggestionPack,
} from './ai-insights-store.js';

function yangonDateString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yangon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function assertAiEnabled(): void {
  if (!env.aiInsightsEnabled) {
    throw new Error('AI insights are disabled (AI_INSIGHTS_ENABLED=false).');
  }
}

export function isAiInsightsEnabled(): boolean {
  return env.aiInsightsEnabled === true;
}

export async function runDailyInsightRollup(userId: string): Promise<DailyInsightRollup> {
  assertAiEnabled();
  const summary = await fetchOverviewInsights(userId, 'day');
  const date = yangonDateString();

  const rollup: DailyInsightRollup = {
    date,
    saleAmount: summary.kpis.saleAmount.value,
    saleOrders: summary.kpis.confirmedOrders.value,
    purchaseAmount: summary.kpis.purchaseAmount?.value ?? 0,
    purchaseOrders: summary.kpis.purchaseOrders?.value ?? 0,
    buyingCustomers: summary.kpis.buyingCustomers?.value ?? 0,
    quotations: summary.kpis.quotations?.value ?? 0,
    itemsSold: summary.kpis.itemsSold?.value ?? 0,
    avgOrderValue: summary.kpis.avgOrderValue.value,
    topAreas: (summary.areaChart?.series ?? []).slice(0, 5).map(row => ({
      name: row.name,
      total: row.total,
    })),
    topProducts: (summary.topProducts ?? []).slice(0, 5).map(row => ({
      name: row.name,
      revenue: row.revenue,
    })),
    bottomProducts: (summary.bottomProducts ?? []).slice(0, 5).map(row => ({
      name: row.name,
      revenue: row.revenue,
    })),
    topSpenders: (summary.topSpendingCustomers ?? []).slice(0, 5).map(row => ({
      name: row.name,
      total: row.total,
      orders: row.orders,
    })),
  };

  await saveDailyRollup(rollup);
  await pruneDailyRollups(90);
  return rollup;
}

function buildWeeklyTotals(days: DailyInsightRollup[]) {
  const byWeek = new Map<
    string,
    {
      week: string;
      saleAmount: number;
      purchaseAmount: number;
      saleOrders: number;
      buyingCustomers: number;
    }
  >();

  for (const day of days) {
    const d = new Date(`${day.date}T00:00:00+06:30`);
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(
      ((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7,
    );
    const key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    const row = byWeek.get(key) || {
      week: key,
      saleAmount: 0,
      purchaseAmount: 0,
      saleOrders: 0,
      buyingCustomers: 0,
    };
    row.saleAmount += day.saleAmount;
    row.purchaseAmount += day.purchaseAmount;
    row.saleOrders += day.saleOrders;
    row.buyingCustomers += day.buyingCustomers;
    byWeek.set(key, row);
  }

  return [...byWeek.values()].slice(-12);
}

function normalizeSuggestions(raw: unknown): AiSuggestionItem[] {
  const list = Array.isArray((raw as { suggestions?: unknown })?.suggestions)
    ? ((raw as { suggestions: unknown[] }).suggestions)
    : Array.isArray(raw)
      ? raw
      : [];

  const items: AiSuggestionItem[] = [];
  for (const entry of list.slice(0, 5)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const title = String(row.title ?? '').trim();
    const detail = String(row.detail ?? row.description ?? '').trim();
    const priorityRaw = String(row.priority ?? 'medium').toLowerCase();
    const priority =
      priorityRaw === 'high' || priorityRaw === 'low' ? priorityRaw : 'medium';
    if (!title || !detail) {
      continue;
    }
    items.push({ title, detail, priority });
  }
  return items;
}

export async function generateAiSuggestions(
  userId: string,
  slot: AiSuggestionPack['slot'],
): Promise<AiSuggestionPack> {
  assertAiEnabled();
  if (!env.groqApiKey) {
    throw new Error('GROQ_API_KEY is not configured.');
  }

  // Refresh today's notebook page before suggesting.
  try {
    await runDailyInsightRollup(userId);
  } catch (error) {
    console.warn(
      '[ai-insights] daily rollup before suggest failed:',
      error instanceof Error ? error.message : error,
    );
  }

  const [history, weekLive, monthLive] = await Promise.all([
    listDailyRollups(90),
    fetchOverviewInsights(userId, 'week'),
    fetchOverviewInsights(userId, 'month'),
  ]);

  const payload = {
    business: {
      currency: 'MMK',
      timezone: 'Asia/Yangon',
      notes: [
        'sale orders = confirmed customer sales (state sale/done)',
        'purchase orders = confirmed vendor purchases (state purchase/done)',
        'Give practical actions for a Myanmar retail / membership shop ERP.',
      ],
    },
    slot,
    weeklyTrend: buildWeeklyTotals(history),
    last14Daily: history.slice(-14),
    thisWeekLive: {
      saleAmount: weekLive.kpis.saleAmount.value,
      saleOrders: weekLive.kpis.confirmedOrders.value,
      purchaseAmount: weekLive.kpis.purchaseAmount?.value ?? 0,
      purchaseOrders: weekLive.kpis.purchaseOrders?.value ?? 0,
      buyingCustomers: weekLive.kpis.buyingCustomers?.value ?? 0,
      quotations: weekLive.kpis.quotations?.value ?? 0,
      topAreas: weekLive.areaChart.series.slice(0, 5).map(s => ({
        name: s.name,
        total: s.total,
      })),
      topProducts: weekLive.topProducts.slice(0, 3),
      bottomProducts: weekLive.bottomProducts.slice(0, 3),
      topSpenders: weekLive.topSpendingCustomers.slice(0, 5),
    },
    thisMonthLive: {
      saleAmount: monthLive.kpis.saleAmount.value,
      saleOrders: monthLive.kpis.confirmedOrders.value,
      purchaseAmount: monthLive.kpis.purchaseAmount?.value ?? 0,
      purchaseOrders: monthLive.kpis.purchaseOrders?.value ?? 0,
    },
  };

  const focus =
    slot === 'monday'
      ? 'Focus on planning the coming week using last week and trends.'
      : slot === 'friday'
        ? 'Focus on reviewing this week so far and what to fix before the weekend.'
        : slot === 'monthly'
          ? 'Focus on a monthly review and priorities for the new month.'
          : 'Give balanced business suggestions from the data.';

  const system = `You are a concise business analyst for a Myanmar shop ERP.
Return ONLY JSON with shape:
{"suggestions":[{"title":"string","detail":"string","priority":"high|medium|low"}]}
Give 3 to 5 actionable suggestions. No markdown. Currency is MMK.`;

  const user = `${focus}

DATA:
${JSON.stringify(payload)}`;

  const content = await groqChatJson({ system, user });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Groq returned invalid JSON.');
  }

  const suggestions = normalizeSuggestions(parsed);
  if (suggestions.length === 0) {
    throw new Error('Groq returned no usable suggestions.');
  }

  const pack: AiSuggestionPack = {
    generatedAt: new Date().toISOString(),
    slot,
    model: env.groqModel,
    suggestions,
  };
  await saveSuggestionPack(pack);
  return pack;
}

export async function getAiSuggestionsStatus(): Promise<{
  enabled: boolean;
  configured: boolean;
  latest: AiSuggestionPack | null;
  shouldGenerate: boolean;
  suggestedSlot: AiSuggestionPack['slot'];
}> {
  const enabled = isAiInsightsEnabled();
  const suggestedSlot = suggestedSlotForNow();
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      latest: null,
      shouldGenerate: false,
      suggestedSlot,
    };
  }
  const latest = await loadLatestSuggestionPack();
  const configured = Boolean(env.groqApiKey);
  return {
    enabled: true,
    configured,
    latest,
    shouldGenerate: configured && isSuggestionStale(latest, suggestedSlot),
    suggestedSlot,
  };
}

function suggestedSlotForNow(now = new Date()): AiSuggestionPack['slot'] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Yangon',
    weekday: 'short',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const day = Number(parts.find(p => p.type === 'day')?.value ?? '0');
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');

  if (day === 1 && hour >= 8) {
    return 'monthly';
  }
  if (weekday === 'Fri' && hour >= 16) {
    return 'friday';
  }
  if (weekday === 'Mon' && hour >= 8) {
    return 'monday';
  }
  if (weekday === 'Fri' || weekday === 'Sat' || weekday === 'Sun') {
    return 'friday';
  }
  return 'monday';
}

function isSuggestionStale(
  latest: AiSuggestionPack | null,
  slot: AiSuggestionPack['slot'],
): boolean {
  if (!latest) {
    return true;
  }
  const generated = new Date(latest.generatedAt).getTime();
  if (!Number.isFinite(generated)) {
    return true;
  }
  const ageMs = Date.now() - generated;
  // Prefer fresh tips for the current schedule window.
  if (slot === 'monthly') {
    return ageMs > 20 * 24 * 60 * 60 * 1000 || latest.slot !== 'monthly';
  }
  if (slot === 'friday') {
    return ageMs > 4 * 24 * 60 * 60 * 1000;
  }
  // monday / manual
  return ageMs > 4 * 24 * 60 * 60 * 1000;
}
