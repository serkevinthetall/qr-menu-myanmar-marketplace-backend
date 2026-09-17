import { connectMongo, isMongoConfigured } from '../config/mongo.js';
import { env } from '../config/env.js';
import { AppInstallModel } from '../models/app-install.model.js';
import { geminiChatText } from './gemini.service.js';
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

export type AppInstallDailyStats = {
  reportDateLabel: string;
  dayStart: Date;
  dayEnd: Date;
  installedToday: number;
  totalInstalledUsers: number;
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
  };
}

function buildStatsBlock(stats: AppInstallDailyStats): string {
  return [
    stats.reportDateLabel,
    '',
    `ဆိုင်သို့ သွားရောက်၍ App Install လုပ်ပေးခဲ့သူ - ${stats.installedToday}`,
    '',
    `QR Shop App အသုံးပြုသူ စုစုပေါင်း ${stats.totalInstalledUsers}ဦး`,
  ].join('\n');
}

async function buildGeminiCommentary(
  stats: AppInstallDailyStats,
): Promise<string> {
  if (!env.geminiApiKey) {
    return '';
  }

  const system = [
    'You are a concise QR Shop Myanmar operations assistant.',
    'Write 2–4 short sentences in Burmese (Myanmar script) about the daily App Install report.',
    'Be warm, professional, and practical. Do not invent numbers not given.',
    'Do not repeat the raw stats line-by-line; interpret them briefly (pace, growth, encouragement, or gentle nudge if installs are low).',
    'No markdown, no bullet lists, no English unless a product name like QR Shop App.',
  ].join(' ');

  const user = [
    `Report date: ${stats.reportDateLabel}`,
    `Shop visits / App installs marked today: ${stats.installedToday}`,
    `Total QR Shop App users (installed): ${stats.totalInstalledUsers}`,
    'Write a short spoken-style commentary for the manager Telegram message.',
  ].join('\n');

  try {
    const text = await geminiChatText({
      system,
      user,
      temperature: 0.5,
    });
    return text.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[telegram-daily-report] Gemini commentary failed:', message);
    return '';
  }
}

export async function buildAppInstallDailyReportMessage(
  now = new Date(),
): Promise<{ message: string; stats: AppInstallDailyStats; geminiUsed: boolean }> {
  const stats = await fetchAppInstallDailyStats(now);
  const statsBlock = buildStatsBlock(stats);
  const commentary = await buildGeminiCommentary(stats);
  const geminiUsed = Boolean(commentary);

  const message = commentary
    ? `${statsBlock}\n\n${commentary}`
    : statsBlock;

  return { message, stats, geminiUsed };
}

export async function sendAppInstallDailyReport(now = new Date()): Promise<{
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
    await buildAppInstallDailyReportMessage(now);
  const { sent, failed } = await telegramSendToAllowlist(message);

  return { message, stats, geminiUsed, sent, failed };
}
