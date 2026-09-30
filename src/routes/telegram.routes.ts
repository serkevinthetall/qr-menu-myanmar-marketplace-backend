import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { sendAppInstallDailyReport } from '../services/app-install-daily-report.service.js';
import {
  handleTelegramUpdate,
  isValidCronAuthorization,
  isValidTelegramWebhookSecret,
  telegramSetWebhook,
  type TelegramUpdate,
} from '../services/telegram.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

/**
 * Telegram → Vercel webhook (no JWT).
 * Secured by X-Telegram-Bot-Api-Secret-Token when TELEGRAM_WEBHOOK_SECRET is set.
 */
router.post('/webhook', async (req, res) => {
  try {
    const secret = req.header('x-telegram-bot-api-secret-token') ?? undefined;
    if (!isValidTelegramWebhookSecret(secret)) {
      return res.status(401).json({ message: 'Invalid webhook secret.' });
    }

    const update = req.body as TelegramUpdate;
    if (update && typeof update === 'object') {
      await handleTelegramUpdate(update);
    }
    // Always 200 so Telegram does not retry forever.
    return res.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Webhook handler failed.';
    console.error('[telegram] webhook', message);
    return res.json({ ok: true });
  }
});

/**
 * Vercel Cron → daily report (GET).
 * Secured by Authorization: Bearer CRON_SECRET.
 * Schedule in vercel.json: 0 10 * * * (≈ 16:30 Asia/Yangon).
 */
router.get('/cron/daily-report', async (req, res) => {
  try {
    if (!isValidCronAuthorization(req.header('authorization') ?? undefined)) {
      return res.status(401).json({ message: 'Unauthorized cron request.' });
    }
    if (!env.telegramDailyReportEnabled) {
      return res.status(503).json({
        message:
          'Telegram daily report is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS.',
      });
    }

    const result = await sendAppInstallDailyReport();
    return res.json({
      ok: true,
      data: {
        sent: result.sent,
        failed: result.failed,
        geminiUsed: result.geminiUsed,
        stats: {
          date: result.stats.reportDateLabel,
          installedToday: result.stats.installedToday,
          totalInstalledUsers: result.stats.totalInstalledUsers,
          appOrders: {
            available: result.stats.appOrders.available,
            totalOrders: result.stats.appOrders.totalOrders,
            totalSpending: result.stats.appOrders.totalSpending,
            customers: result.stats.appOrders.customers,
          },
        },
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to send Telegram daily report.';
    console.error('[telegram] cron/daily-report', message);
    return res.status(500).json({ message });
  }
});

router.use(authMiddleware);

/**
 * Register Telegram webhook URL (call once after deploy).
 * POST /api/telegram/setup-webhook
 */
router.post('/setup-webhook', async (req: AuthRequest, res) => {
  try {
    const bodyUrl =
      typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const result = await telegramSetWebhook({
      url: bodyUrl || undefined,
    });
    return res.json({ data: result });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to set Telegram webhook.';
    console.error('[telegram] setup-webhook', message);
    return res.status(500).json({ message });
  }
});

/**
 * Manual trigger for the daily App Install + App Order Telegram report.
 */
router.post('/daily-report', async (req: AuthRequest, res) => {
  try {
    if (!env.telegramDailyReportEnabled) {
      return res.status(503).json({
        message:
          'Telegram daily report is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS.',
      });
    }

    const result = await sendAppInstallDailyReport(new Date(), {
      odooUserId: req.user?.id,
    });
    return res.json({
      data: {
        sent: result.sent,
        failed: result.failed,
        geminiUsed: result.geminiUsed,
        stats: {
          date: result.stats.reportDateLabel,
          installedToday: result.stats.installedToday,
          totalInstalledUsers: result.stats.totalInstalledUsers,
          appOrders: {
            available: result.stats.appOrders.available,
            totalOrders: result.stats.appOrders.totalOrders,
            totalSpending: result.stats.appOrders.totalSpending,
            customers: result.stats.appOrders.customers,
          },
        },
        preview: result.message,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to send Telegram daily report.';
    console.error('[telegram] daily-report', message);
    return res.status(500).json({ message });
  }
});

export default router;
