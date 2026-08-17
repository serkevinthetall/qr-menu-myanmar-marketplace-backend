import { env } from '../config/env.js';
import {
  fetchOverviewInsights,
  fetchOverviewOrders,
  OverviewPeriodOrder,
} from './odoo.service.js';
import { geminiChatJson } from './gemini.service.js';
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

/** Max individual orders sent to Gemini per type (avoids token overflow). */
const AI_ORDER_LIST_LIMIT = 120;

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

function yangonMonthKey(date = new Date()): string {
  return yangonDateString(date).slice(0, 7);
}

function previousMonthKey(ym: string): string {
  const [year, month] = ym.split('-').map(Number);
  const prev = new Date(year, month - 2, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

function sumRollupsForMonth(days: DailyInsightRollup[], monthKey: string) {
  const rows = days.filter(day => day.date.startsWith(monthKey));
  if (rows.length === 0) {
    return null;
  }
  return {
    month: monthKey,
    daysRecorded: rows.length,
    saleAmount: rows.reduce((sum, row) => sum + row.saleAmount, 0),
    saleOrders: rows.reduce((sum, row) => sum + row.saleOrders, 0),
    purchaseAmount: rows.reduce((sum, row) => sum + row.purchaseAmount, 0),
    purchaseOrders: rows.reduce((sum, row) => sum + row.purchaseOrders, 0),
    buyingCustomers: rows.reduce((sum, row) => sum + row.buyingCustomers, 0),
    quotations: rows.reduce((sum, row) => sum + row.quotations, 0),
    itemsSold: rows.reduce((sum, row) => sum + row.itemsSold, 0),
  };
}

function compactMonthLive(
  monthLive: Awaited<ReturnType<typeof fetchOverviewInsights>>,
) {
  return {
    range: monthLive.range,
    saleAmount: monthLive.kpis.saleAmount.value,
    saleAmountTrendPct: monthLive.kpis.saleAmount.trend,
    saleOrders: monthLive.kpis.confirmedOrders.value,
    saleOrdersTrendPct: monthLive.kpis.confirmedOrders.trend,
    purchaseAmount: monthLive.kpis.purchaseAmount?.value ?? 0,
    purchaseOrders: monthLive.kpis.purchaseOrders?.value ?? 0,
    buyingCustomers: monthLive.kpis.buyingCustomers?.value ?? 0,
    quotations: monthLive.kpis.quotations?.value ?? 0,
    itemsSold: monthLive.kpis.itemsSold?.value ?? 0,
    avgOrderValue: monthLive.kpis.avgOrderValue.value,
    topAreas: (monthLive.areaChart?.series ?? [])
      .filter(row => row.total > 0)
      .slice(0, 12)
      .map(row => ({
        name: row.name,
        total: row.total,
      })),
    topSpenders: (monthLive.topSpendingCustomers ?? [])
      .filter(row => row.total > 0)
      .slice(0, 12)
      .map(row => ({
        name: row.name,
        total: row.total,
        orders: row.orders,
      })),
    topProducts: (monthLive.topProducts ?? [])
      .filter(row => row.revenue > 0)
      .slice(0, 5)
      .map(row => ({
        name: row.name,
        revenue: row.revenue,
        qty: row.qty,
      })),
    bottomProducts: (monthLive.bottomProducts ?? [])
      .filter(row => row.revenue > 0)
      .slice(0, 5)
      .map(row => ({
        name: row.name,
        revenue: row.revenue,
        qty: row.qty,
      })),
    lowestOnHand: (monthLive.lowestOnHandProducts ?? []).slice(0, 3).map(row => ({
      name: row.name,
      onHand: row.onHand,
    })),
    highestDemand: (monthLive.highestDemandProducts ?? []).slice(0, 3).map(row => ({
      name: row.name,
      demandQty: row.demandQty,
      onHand: row.onHand,
    })),
  };
}

function compactOrdersForAi(orders: OverviewPeriodOrder[]) {
  const rows = orders.filter(row => row.total > 0);
  const totalAmount = rows.reduce((sum, row) => sum + row.total, 0);
  const sorted = [...rows].sort((a, b) => b.total - a.total);

  const byPartner = new Map<
    string,
    { name: string; total: number; orders: number }
  >();
  for (const row of sorted) {
    const name = row.partner.trim() || 'Unknown';
    const existing = byPartner.get(name) || { name, total: 0, orders: 0 };
    existing.total += row.total;
    existing.orders += 1;
    byPartner.set(name, existing);
  }

  const topPartners = [...byPartner.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)
    .map(row => ({
      name: row.name,
      total: row.total,
      orders: row.orders,
    }));

  return {
    count: rows.length,
    totalAmount,
    topPartners,
    orders: sorted.slice(0, AI_ORDER_LIST_LIMIT).map(row => ({
      number: row.number,
      partner: row.partner,
      date: row.orderDate.slice(0, 10),
      total: row.total,
    })),
    truncated: rows.length > AI_ORDER_LIST_LIMIT,
  };
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
  if (!env.geminiApiKey && !env.groqApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  // Only fetch live monthly Overview + order lists when the user clicks Process.
  const [history, monthLive, saleOrders, purchaseOrders] = await Promise.all([
    listDailyRollups(90),
    fetchOverviewInsights(userId, 'month'),
    fetchOverviewOrders(userId, 'month', 'sale', { compare: false }),
    fetchOverviewOrders(userId, 'month', 'purchase', { compare: false }),
  ]);

  const thisMonthKey = yangonMonthKey();
  const lastMonthKey = previousMonthKey(thisMonthKey);
  const monthSnapshot = compactMonthLive(monthLive);
  const saleOrdersSnapshot = compactOrdersForAi(saleOrders.orders);
  const purchaseOrdersSnapshot = compactOrdersForAi(purchaseOrders.orders);

  const payload = {
    business: {
      currency: 'MMK',
      timezone: 'Asia/Yangon',
      notes: [
        'sale orders = confirmed customer sales with amount_total > 0 MMK',
        'purchase orders = confirmed vendor purchases with amount_total > 0 MMK',
        'thisMonthLive = KPIs, rankings, products for the current calendar month in Yangon.',
        'thisMonthOrders = full sale/purchase order lists for the same month (may be truncated to top orders by amount).',
        'Give practical actions for a Myanmar retail / membership shop ERP.',
      ],
    },
    slot,
    weeklyTrend: buildWeeklyTotals(history),
    last14Daily: history.slice(-14),
    thisMonthLive: monthSnapshot,
    thisMonthOrders: {
      range: saleOrders.range,
      sale: saleOrdersSnapshot,
      purchase: purchaseOrdersSnapshot,
    },
    lastMonthFromNotebook: sumRollupsForMonth(history, lastMonthKey),
  };

  const focus =
    slot === 'monday'
      ? 'Focus on planning the coming week using last week and trends. Still mention this month if the numbers are striking.'
      : slot === 'friday'
        ? 'Focus on reviewing this week so far and what to fix before the weekend. Mention this month if relevant.'
        : slot === 'monthly'
          ? 'This is a monthly review. Use thisMonthLive for KPIs and rankings, and thisMonthOrders for order-level analysis (sale vs purchase, top customers/vendors, large orders). Compare with lastMonthFromNotebook when present. Give 3–5 priorities for the rest of this month / next month.'
          : 'Give balanced business suggestions. Use thisMonthLive and thisMonthOrders (sale + purchase orders above 0 MMK) over daily snippets.';

  const system = `You are a concise business analyst for a Myanmar shop ERP.
Return ONLY JSON with shape:
{"suggestions":[{"title":"string","detail":"string","priority":"high|medium|low"}]}
Give 3 to 5 actionable suggestions. No markdown. Currency is MMK.
Use only the provided DATA. Prefer thisMonthLive for totals/rankings and thisMonthOrders for order-level insights (sales vs purchases, concentration in top customers/vendors, unusual large orders).
Quote real customer, vendor, area, and product names with MMK amounts when you mention them.`;

  const user = `${focus}

DATA:
${JSON.stringify(payload)}`;

  const content = env.geminiApiKey
    ? await geminiChatJson({ system, user })
    : await groqChatJson({ system, user });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('AI returned invalid JSON.');
  }

  const suggestions = normalizeSuggestions(parsed);
  if (suggestions.length === 0) {
    throw new Error('AI returned no usable suggestions.');
  }

  const pack: AiSuggestionPack = {
    generatedAt: new Date().toISOString(),
    slot,
    model: env.geminiApiKey ? env.geminiModel : env.groqModel,
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
  const configured = Boolean(env.geminiApiKey || env.groqApiKey);
  return {
    enabled: true,
    configured,
    latest,
    shouldGenerate: false,
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
