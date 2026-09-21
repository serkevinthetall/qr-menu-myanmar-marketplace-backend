import cron from 'node-cron';

import { env } from '../config/env.js';
import { sendAppInstallDailyReport } from './app-install-daily-report.service.js';
import { telegramPoliceInboundUpdates } from './telegram.service.js';

let started = false;
let updatesOffset: number | undefined;

async function runDailyReportJob(label: string): Promise<void> {
  console.log(`[telegram-daily-report] Running (${label})…`);
  try {
    const result = await sendAppInstallDailyReport();
    console.log(
      `[telegram-daily-report] Sent to ${result.sent.length} chat(s)` +
        (result.failed.length ? `, failed ${result.failed.length}` : '') +
        (result.geminiUsed ? ', Gemini commentary on' : ', Gemini skipped'),
    );
    for (const fail of result.failed) {
      console.error(
        `[telegram-daily-report] chat ${fail.chatId}: ${fail.error}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[telegram-daily-report] Job failed:', message);
  }
}

async function policeLoopTick(): Promise<void> {
  try {
    updatesOffset = await telegramPoliceInboundUpdates(updatesOffset);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[telegram-daily-report] inbound police failed:', message);
  }
}

/**
 * Local Express fallback only.
 * On Vercel: use webhook + vercel.json cron instead (this is a no-op).
 */
export function startTelegramDailyReportJobs(): void {
  if (started) return;
  started = true;

  if (env.isVercel) {
    console.log(
      '[telegram-daily-report] Vercel detected — using webhook + Vercel Cron (skip local node-cron/polling).',
    );
    return;
  }

  if (!env.telegramDailyReportEnabled) {
    console.log(
      '[telegram-daily-report] Disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS to enable).',
    );
    return;
  }

  // Webhook mode: do not poll getUpdates (Telegram allows only one).
  if (env.telegramWebhookUrl) {
    console.log(
      `[telegram-daily-report] Webhook mode (${env.telegramWebhookUrl}) — skip local polling.`,
    );
  } else {
    void policeLoopTick();
    setInterval(() => {
      void policeLoopTick();
    }, 5_000);
    console.log('[telegram-daily-report] Local polling for /start enabled.');
  }

  const expression = env.telegramReportCron || '30 16 * * *';
  const timezone = env.telegramReportTz || 'Asia/Yangon';

  if (!cron.validate(expression)) {
    console.error(
      `[telegram-daily-report] Invalid TELEGRAM_REPORT_CRON: ${expression}`,
    );
    return;
  }

  cron.schedule(
    expression,
    () => {
      void runDailyReportJob('cron');
    },
    { timezone },
  );

  console.log(
    `[telegram-daily-report] Local schedule "${expression}" (${timezone}) → ${env.telegramChatIds.length} chat(s)`,
  );
}
