import { connectMongo, isMongoConfigured } from '../config/mongo.js';
import { env } from '../config/env.js';
import { AppInstallModel } from '../models/app-install.model.js';
import { hydrateLatestWebOdooSession } from './auth-session.store.js';
import { fetchOdooOnlineOrders } from './odoo.service.js';
import { telegramSendToAllowlist } from './telegram.service.js';

const YANGON_OFFSET_MS = 6.5 * 60 * 60 * 1000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function toYangonLocal(date: Date): Date {
  return new Date(date.getTime() + YANGON_OFFSET_MS);
}

function yangonStartOfDayUtc(dateUtc: Date): Date {
  const d = toYangonLocal(dateUtc);
  const startLocalMs = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    0,
    0,
    0,
  );
  return new Date(startLocalMs - YANGON_OFFSET_MS);
}

function formatReportDate(dateUtc: Date): string {
  const d = toYangonLocal(dateUtc);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()] ?? 'Jan';
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/** Yangon calendar day as YYYY-MM-DD for Odoo date_order filters. */
function yangonDateKey(dateUtc: Date): string {
  const d = toYangonLocal(dateUtc);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatMmk(amount: number): string {
  const n = Math.round(Number(amount) || 0);
  return `${n.toLocaleString('en-US')} MMK`;
}

export type AppOrderCustomerSpend = {
  partnerId: number;
  name: string;
  spending: number;
  orders: number;
};

export type AppOrderDailySpendStats = {
  dateKey: string;
  customers: AppOrderCustomerSpend[];
  totalSpending: number;
  totalOrders: number;
  available: boolean;
};

export type AppInstallDailyStats = {
  reportDateLabel: string;
  dayStart: Date;
  dayEnd: Date;
  installedToday: number;
  totalInstalledUsers: number;
  appOrders: AppOrderDailySpendStats;
};

export async function fetchAppInstallDailyStats(
  now = new Date(),
): Promise<AppInstallDailyStats> {
  if (!isMongoConfigured()) {
    throw new Error('MongoDB is not configured (MONGODB_URI).');
  }
  await connectMongo();

  const dayStart = yangonStartOfDayUtc(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const [installedToday, totalInstalledUsers] = await Promise.all([
    AppInstallModel.countDocuments({
      status: 'installed',
      updatedAt: { $gte: dayStart, $lt: dayEnd },
    }),
    AppInstallModel.countDocuments({ status: 'installed' }),
  ]);

  return {
    reportDateLabel: formatReportDate(now),
    dayStart,
    dayEnd,
    installedToday,
    totalInstalledUsers,
    appOrders: {
      dateKey: yangonDateKey(now),
      customers: [],
      totalSpending: 0,
      totalOrders: 0,
      available: false,
    },
  };
}

export async function fetchAppOrderDailySpendStats(
  userId: string,
  now = new Date(),
): Promise<AppOrderDailySpendStats> {
  const dateKey = yangonDateKey(now);
  const rows = await fetchOdooOnlineOrders(userId, {
    from: dateKey,
    to: dateKey,
    limit: 500,
    offset: 0,
  });

  const byPartner = new Map<number, AppOrderCustomerSpend>();
  let totalSpending = 0;

  for (const row of rows) {
    const partnerId = Array.isArray(row.partner_id)
      ? Number(row.partner_id[0])
      : 0;
    const name = Array.isArray(row.partner_id)
      ? String(row.partner_id[1] || '').trim()
      : '';
    const amount = Number(row.amount_total) || 0;
    totalSpending += amount;

    if (!partnerId) {
      const orphanKey = -1;
      const existing = byPartner.get(orphanKey);
      if (!existing) {
        byPartner.set(orphanKey, {
          partnerId: orphanKey,
          name: name || 'Unknown customer',
          spending: amount,
          orders: 1,
        });
      } else {
        existing.spending += amount;
        existing.orders += 1;
      }
      continue;
    }

    const existing = byPartner.get(partnerId);
    if (!existing) {
      byPartner.set(partnerId, {
        partnerId,
        name: name || `Partner #${partnerId}`,
        spending: amount,
        orders: 1,
      });
    } else {
      existing.spending += amount;
      existing.orders += 1;
      if (!existing.name && name) {
        existing.name = name;
      }
    }
  }

  const customers = [...byPartner.values()].sort(
    (a, b) => b.spending - a.spending || a.name.localeCompare(b.name),
  );

  return {
    dateKey,
    customers,
    totalSpending,
    totalOrders: rows.length,
    available: true,
  };
}

async function resolveOdooUserId(
  preferredUserId?: string,
): Promise<string | null> {
  if (preferredUserId?.trim()) {
    return preferredUserId.trim();
  }
  return hydrateLatestWebOdooSession();
}

const APP_ORDER_CUSTOMERS_IN_MESSAGE = 10;

function buildAppOrdersBlock(appOrders: AppOrderDailySpendStats): string {
  if (!appOrders.available) {
    return '';
  }

  const lines = ['App Order (ယနေ့)'];

  if (appOrders.customers.length === 0) {
    lines.push('မရှိပါ');
    return lines.join('\n');
  }

  const shown = appOrders.customers.slice(0, APP_ORDER_CUSTOMERS_IN_MESSAGE);
  for (const customer of shown) {
    const orderLabel =
      customer.orders === 1 ? '1 order' : `${customer.orders} orders`;
    lines.push(
      `${customer.name} — ${formatMmk(customer.spending)} (${orderLabel})`,
    );
  }

  const hidden = appOrders.customers.length - shown.length;
  if (hidden > 0) {
    lines.push(`… နှင့် အခြား ${hidden} ဦး`);
  }

  lines.push('');
  lines.push(
    `စုစုပေါင်း — ${formatMmk(appOrders.totalSpending)} (${appOrders.totalOrders} order${
      appOrders.totalOrders === 1 ? '' : 's'
    })`,
  );

  return lines.join('\n');
}

function buildStatsBlock(stats: AppInstallDailyStats): string {
  const parts = [
    stats.reportDateLabel,
    '',
    `ဆိုင်သို့ သွားရောက်၍ App Install လုပ်ပေးခဲ့သူ - ${stats.installedToday}`,
    '',
    `QR Shop App အသုံးပြုသူ စုစုပေါင်း ${stats.totalInstalledUsers}ဦး`,
  ];

  const appOrdersBlock = buildAppOrdersBlock(stats.appOrders);
  if (appOrdersBlock) {
    parts.push('', appOrdersBlock);
  }

  return parts.join('\n');
}

export async function buildAppInstallDailyReportMessage(
  now = new Date(),
  options?: { odooUserId?: string },
): Promise<{ message: string; stats: AppInstallDailyStats; geminiUsed: boolean }> {
  const stats = await fetchAppInstallDailyStats(now);

  const odooUserId = await resolveOdooUserId(options?.odooUserId);
  if (odooUserId) {
    try {
      stats.appOrders = await fetchAppOrderDailySpendStats(odooUserId, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[telegram-daily-report] App order stats failed:', message);
      stats.appOrders = {
        dateKey: yangonDateKey(now),
        customers: [],
        totalSpending: 0,
        totalOrders: 0,
        available: false,
      };
    }
  }

  return {
    message: buildStatsBlock(stats),
    stats,
    geminiUsed: false,
  };
}

export async function sendAppInstallDailyReport(
  now = new Date(),
  options?: { odooUserId?: string },
): Promise<{
  message: string;
  stats: AppInstallDailyStats;
  geminiUsed: boolean;
  sent: string[];
  failed: Array<{ chatId: string; error: string }>;
}> {
  if (!env.telegramDailyReportEnabled) {
    throw new Error(
      'Telegram daily report is disabled or TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_IDS missing.',
    );
  }
  if (env.telegramChatIds.length === 0) {
    throw new Error('TELEGRAM_CHAT_IDS is empty.');
  }

  const { message, stats, geminiUsed } =
    await buildAppInstallDailyReportMessage(now, options);
  const { sent, failed } = await telegramSendToAllowlist(message);

  return { message, stats, geminiUsed, sent, failed };
}
