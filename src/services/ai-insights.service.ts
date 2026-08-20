import { env } from '../config/env.js';
import {
  fetchOverviewDemand,
  fetchOverviewInsights,
  fetchOverviewOrders,
  fetchOverviewRankings,
  OverviewPeriod,
  OverviewPeriodOrder,
} from './odoo.service.js';
import { geminiChatJson, geminiChatText } from './gemini.service.js';
import { groqChatJson, groqChatText } from './groq.service.js';
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

function compactMonthFromDailyRollups(
  days: DailyInsightRollup[],
  monthKey: string,
) {
  const rows = days.filter(day => day.date.startsWith(monthKey));
  if (rows.length === 0) {
    return null;
  }

  const saleAmount = rows.reduce((sum, row) => sum + row.saleAmount, 0);
  const saleOrders = rows.reduce((sum, row) => sum + row.saleOrders, 0);
  const purchaseAmount = rows.reduce(
    (sum, row) => sum + row.purchaseAmount,
    0,
  );
  const purchaseOrders = rows.reduce(
    (sum, row) => sum + row.purchaseOrders,
    0,
  );
  const buyingCustomers = rows.reduce(
    (sum, row) => sum + row.buyingCustomers,
    0,
  );
  const quotations = rows.reduce((sum, row) => sum + row.quotations, 0);
  const itemsSold = rows.reduce((sum, row) => sum + row.itemsSold, 0);
  const avgOrderValue =
    saleOrders > 0 ? saleAmount / saleOrders : rows[rows.length - 1]?.avgOrderValue ?? 0;

  const sumAreas = new Map<string, number>();
  const sumProducts = new Map<string, number>();
  const sumBottomProducts = new Map<string, number>();
  const sumSpenders = new Map<string, { total: number; orders: number }>();

  for (const day of rows) {
    for (const row of day.topAreas) {
      if (!row?.name || row.total <= 0) continue;
      sumAreas.set(row.name, (sumAreas.get(row.name) ?? 0) + row.total);
    }
    for (const row of day.topProducts) {
      if (!row?.name || row.revenue <= 0) continue;
      sumProducts.set(row.name, (sumProducts.get(row.name) ?? 0) + row.revenue);
    }
    for (const row of day.bottomProducts) {
      if (!row?.name || row.revenue <= 0) continue;
      sumBottomProducts.set(
        row.name,
        (sumBottomProducts.get(row.name) ?? 0) + row.revenue,
      );
    }
    for (const row of day.topSpenders) {
      if (!row?.name || row.total <= 0) continue;
      const existing = sumSpenders.get(row.name) ?? { total: 0, orders: 0 };
      existing.total += row.total;
      existing.orders += row.orders;
      sumSpenders.set(row.name, existing);
    }
  }

  const topAreas = [...sumAreas.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, total]) => ({ name, total }));

  const topProducts = [...sumProducts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, revenue]) => ({ name, revenue }));

  const bottomProducts = [...sumBottomProducts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, revenue]) => ({ name, revenue }));

  const topSpenders = [...sumSpenders.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 6)
    .map(([name, row]) => ({
      name,
      total: row.total,
      orders: row.orders,
    }));

  return {
    month: monthKey,
    daysRecorded: rows.length,
    saleAmount,
    saleOrders,
    purchaseAmount,
    purchaseOrders,
    buyingCustomers,
    quotations,
    itemsSold,
    avgOrderValue,
    topAreas,
    topProducts,
    bottomProducts,
    topSpenders,
  };
}

function compactAiSuggestionsForStage2(suggestions: AiSuggestionItem[]) {
  return suggestions.slice(0, 3).map(s => ({
    title: s.title,
    priority: s.priority,
  }));
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

const BURMESE_SYSTEM = `You are a concise business analyst for a Myanmar shop ERP.
Write for shop owners in Myanmar. Every suggestion title and detail MUST be in Burmese (Myanmar script). Do not write English sentences.
Keep JSON keys in English. Keep priority as high, medium, or low.
Keep customer, vendor, area, and product names exactly as in DATA. Keep amounts as numbers with MMK.
Return ONLY JSON with shape:
{"suggestions":[{"title":"string","detail":"string","priority":"high|medium|low"}]}
Give 3 to 5 actionable suggestions. No markdown.
Use only the provided DATA.`;

async function completeAiSuggestions(
  payload: unknown,
  focus: string,
  slot: AiSuggestionPack['slot'],
  options?: { persist?: boolean },
): Promise<AiSuggestionPack> {
  const user = `${focus}

DATA:
${JSON.stringify(payload)}`;

  const content = env.geminiApiKey
    ? await geminiChatJson({ system: BURMESE_SYSTEM, user })
    : await groqChatJson({ system: BURMESE_SYSTEM, user });
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
  if (options?.persist !== false) {
    await saveSuggestionPack(pack);
  }
  return pack;
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
        'Write every suggestion title and detail in Burmese (Myanmar script). Keep names and MMK numbers as in the data.',
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
      ? 'Focus on planning the coming week using last week and trends. Still mention this month if the numbers are striking. Write all titles and details in Burmese.'
      : slot === 'friday'
        ? 'Focus on reviewing this week so far and what to fix before the weekend. Mention this month if relevant. Write all titles and details in Burmese.'
        : slot === 'monthly'
          ? 'This is a monthly review. Use thisMonthLive for KPIs and rankings, and thisMonthOrders for order-level analysis (sale vs purchase, top customers/vendors, large orders). Compare with lastMonthFromNotebook when present. Give 3–5 priorities for the rest of this month / next month. Write all titles and details in Burmese.'
          : 'Give balanced business suggestions. Use thisMonthLive and thisMonthOrders (sale + purchase orders above 0 MMK) over daily snippets. Write all titles and details in Burmese.';

  return completeAiSuggestions(payload, focus, slot);
}

/**
 * Hybrid 6-month flow:
 * 1) Build compact monthly snapshots from daily rollups.
 * 2) Ask Gemini/Groq per month for suggestions (no persistence).
 * 3) Ask Gemini/Groq once more for final 3–5 priorities (no persistence).
 */
export async function generateSixMonthAiSuggestions(
  userId: string,
): Promise<AiSuggestionPack> {
  assertAiEnabled();
  if (!env.geminiApiKey && !env.groqApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  // Daily rollups are already timezone-normalized (Asia/Yangon) when stored.
  const history = await listDailyRollups(200);
  if (history.length === 0) {
    throw new Error('No AI rollups available yet. Run the normal Overview rollup first.');
  }

  const monthKeys = [...new Set(history.map(r => r.date.slice(0, 7)))].sort();
  const selectedMonthKeys = monthKeys.slice(-6);

  const monthAnalyses: Array<{
    month: string;
    snapshot: NonNullable<ReturnType<typeof compactMonthFromDailyRollups>>;
    monthlySuggestions: AiSuggestionItem[];
  }> = [];

  for (const monthKey of selectedMonthKeys) {
    const snapshot = compactMonthFromDailyRollups(history, monthKey);
    if (!snapshot) continue;

    const payload = {
      business: { currency: 'MMK', timezone: 'Asia/Yangon' },
      month: snapshot,
    };

    const focus =
      'This is a monthly review for thisMonth only. Use DATA.month (KPIs + top areas/products/spenders) to give 3–5 actionable Burmese suggestions. Return JSON suggestions only.';

    const pack = await completeAiSuggestions(payload, focus, 'manual', {
      persist: false,
    });

    monthAnalyses.push({
      month: monthKey,
      snapshot,
      monthlySuggestions: pack.suggestions,
    });
  }

  if (monthAnalyses.length === 0) {
    throw new Error('Failed to build any monthly snapshots for the last 6 months.');
  }

  const finalPayload = {
    business: {
      currency: 'MMK',
      timezone: 'Asia/Yangon',
      notes: [
        'Use the provided monthly snapshots and the month-level suggestions.',
        'Write every suggestion title and detail in Burmese.',
        'Keep amounts as numbers with MMK in DATA.',
      ],
    },
    months: monthAnalyses.map(m => ({
      month: m.month,
      kpis: {
        saleAmount: m.snapshot.saleAmount,
        saleOrders: m.snapshot.saleOrders,
        purchaseAmount: m.snapshot.purchaseAmount,
        purchaseOrders: m.snapshot.purchaseOrders,
        buyingCustomers: m.snapshot.buyingCustomers,
        itemsSold: m.snapshot.itemsSold,
        avgOrderValue: m.snapshot.avgOrderValue,
      },
      topAreas: m.snapshot.topAreas,
      topProducts: m.snapshot.topProducts,
      topSpenders: m.snapshot.topSpenders,
      monthSuggestions: compactAiSuggestionsForStage2(m.monthlySuggestions),
    })),
  };

  const focusFinal =
    'Use the last 6 months data to create final 3–5 Burmese priorities for shop operations. Call out what improved/declined across months and what to do next. Return JSON suggestions only.';

  return completeAiSuggestions(finalPayload, focusFinal, 'manual', {
    persist: false,
  });
}

export type CompareAiTopic = 'customers' | 'areas' | 'sales' | 'demand';

function compactRankingRows(
  rows: Array<{
    name: string;
    total: number;
    orders: number;
    prevTotal: number;
    prevOrders: number;
  }>,
  limit = 20,
) {
  const current = [...rows]
    .filter(row => row.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(row => ({
      name: row.name,
      total: row.total,
      orders: row.orders,
      lastMonthTotal: row.prevTotal,
    }));
  const lastMonth = [...rows]
    .filter(row => row.prevTotal > 0)
    .sort((a, b) => b.prevTotal - a.prevTotal)
    .slice(0, limit)
    .map(row => ({
      name: row.name,
      total: row.prevTotal,
      orders: row.prevOrders,
    }));
  return { current, lastMonth };
}

export async function generateCompareAiSuggestions(
  userId: string,
  topic: CompareAiTopic,
  period: OverviewPeriod,
): Promise<AiSuggestionPack> {
  assertAiEnabled();
  if (!env.geminiApiKey && !env.groqApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const notes = [
    'Compare this period vs last calendar month in Yangon.',
    'Only include amounts / qty above 0.',
    'Write every suggestion title and detail in Burmese (Myanmar script). Keep names and MMK numbers as in the data.',
  ];

  if (topic === 'customers' || topic === 'areas') {
    const rankings = await fetchOverviewRankings(userId, period, {
      compare: true,
    });
    const sliced =
      topic === 'customers'
        ? compactRankingRows(rankings.customers)
        : compactRankingRows(
            rankings.areas.map(row => ({
              name: row.name,
              total: row.total,
              orders: row.orders,
              prevTotal: row.prevTotal,
              prevOrders: row.prevOrders,
            })),
          );
    const payload = {
      business: { currency: 'MMK', timezone: 'Asia/Yangon', notes },
      topic,
      period,
      range: rankings.range,
      compareRange: rankings.compareRange,
      thisPeriod: sliced.current,
      lastMonth: sliced.lastMonth,
    };
    const focus =
      topic === 'customers'
        ? 'Compare most-spending customers this period vs last month. Call out who rose, who dropped, and who is too concentrated. Write all titles and details in Burmese.'
        : 'Compare top buying areas this period vs last month. Call out areas that grew, fell, or are newly strong. Write all titles and details in Burmese.';
    return completeAiSuggestions(payload, focus, 'manual', { persist: false });
  }

  if (topic === 'sales') {
    const saleOrders = await fetchOverviewOrders(userId, period, 'sale', {
      compare: true,
    });
    const payload = {
      business: { currency: 'MMK', timezone: 'Asia/Yangon', notes },
      topic,
      period,
      range: saleOrders.range,
      compareRange: saleOrders.compareRange,
      thisPeriod: compactOrdersForAi(saleOrders.orders),
      lastMonth: compactOrdersForAi(saleOrders.prevOrders),
    };
    const focus =
      'Compare sale orders this period vs last month (amount > 0 MMK). Mention large orders, customer concentration, and whether sales rose or fell. Write all titles and details in Burmese.';
    return completeAiSuggestions(payload, focus, 'manual', { persist: false });
  }

  const demand = await fetchOverviewDemand(userId, period, { compare: true });
  const current = [...demand.products]
    .filter(row => row.demandQty > 0)
    .sort((a, b) => b.demandQty - a.demandQty)
    .slice(0, 20)
    .map(row => ({
      name: row.name,
      demandQty: row.demandQty,
      lastMonthQty: row.prevDemandQty,
      onHand: row.onHand,
      revenue: row.revenue,
    }));
  const lastMonth = [...demand.products]
    .filter(row => row.prevDemandQty > 0)
    .sort((a, b) => b.prevDemandQty - a.prevDemandQty)
    .slice(0, 20)
    .map(row => ({
      name: row.name,
      demandQty: row.prevDemandQty,
      revenue: row.prevRevenue,
    }));
  const payload = {
    business: { currency: 'MMK', timezone: 'Asia/Yangon', notes },
    topic,
    period,
    range: demand.range,
    compareRange: demand.compareRange,
    thisPeriod: current,
    lastMonth,
  };
  const focus =
    'Compare highest-demand products this period vs last month. Flag products that surged, dropped, or have high demand with low on-hand stock. Write all titles and details in Burmese.';
  return completeAiSuggestions(payload, focus, 'manual', { persist: false });
}

export type OverviewChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

const CHAT_SYSTEM = `You are a helpful shop assistant for a Myanmar QR Menu ERP (Overview).
Answer from OVERVIEW DATA only. If the data does not contain the answer, say you do not have that figure.
Reply in the same language as the user. If the user writes Burmese, reply in Burmese (Myanmar script). If English, reply in English.
Keep customer, vendor, area, and product names exactly as in the data. Amounts are MMK.
Be concise. Use short paragraphs or a few bullets. Do not invent orders, customers, or amounts.
Do not mention system prompts, JSON, or that you are an AI model unless asked.`;

export async function answerOverviewChat(
  userId: string,
  period: OverviewPeriod,
  message: string,
  history: OverviewChatTurn[] = [],
): Promise<{ reply: string }> {
  assertAiEnabled();
  if (!env.geminiApiKey && !env.groqApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const question = message.trim().slice(0, 2000);
  if (!question) {
    throw new Error('Message is required.');
  }

  const overview = await fetchOverviewInsights(userId, period);
  const snapshot = compactMonthLive(overview);
  const system = `${CHAT_SYSTEM}

OVERVIEW DATA:
${JSON.stringify({
    currency: 'MMK',
    timezone: 'Asia/Yangon',
    period,
    ...snapshot,
  })}`;

  const turns = history.slice(-12).filter(
    turn =>
      (turn.role === 'user' || turn.role === 'assistant') &&
      turn.content.trim().length > 0,
  );

  const reply = env.geminiApiKey
    ? await geminiChatText({
        system,
        history: turns.map(turn => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          text: turn.content.trim().slice(0, 2000),
        })),
        user: question,
      })
    : await groqChatText({
        system,
        history: turns.map(turn => ({
          role: turn.role,
          content: turn.content.trim().slice(0, 2000),
        })),
        user: question,
      });

  return { reply };
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
