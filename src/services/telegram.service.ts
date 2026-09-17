import { env } from '../config/env.js';
import { isMongoConfigured } from '../config/mongo.js';

type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  result?: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
  };
};

function telegramApiUrl(method: string): string {
  return `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
}

export function isTelegramChatAllowed(chatId: string | number): boolean {
  const id = String(chatId).trim();
  if (!id) return false;
  return env.telegramChatIds.includes(id);
}

export function buildTelegramBotStatusReply(): string {
  const host = env.isVercel ? 'Vercel' : 'local Express';
  const cron = env.isVercel
    ? 'Vercel Cron ~16:55 Asia/Yangon (10:25 UTC)'
    : `${env.telegramReportCron || '55 16 * * *'} (${env.telegramReportTz || 'Asia/Yangon'})`;
  const gemini = env.geminiApiKey ? 'ON' : 'OFF';
  const mongo = isMongoConfigured() ? 'ON' : 'OFF';
  const chats = env.telegramChatIds.length;
  const webhook = env.telegramWebhookUrl ? 'ON' : env.isVercel ? 'set TELEGRAM_WEBHOOK_URL' : 'polling';

  return [
    `✅ QR Shop report bot is RUNNING (${host})`,
    '',
    `Schedule: ${cron}`,
    `Allowlist chats: ${chats}`,
    `Gemini commentary: ${gemini}`,
    `Mongo (app installs): ${mongo}`,
    `Inbound: ${webhook}`,
    '',
    'You will get the daily App Install report automatically.',
    'Commands: /start  /status',
  ].join('\n');
}

export async function telegramSendMessage(
  chatId: string | number,
  text: string,
): Promise<void> {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }

  const response = await fetch(telegramApiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = (await response.json()) as TelegramApiResponse;
  if (!response.ok || !data.ok) {
    throw new Error(
      data.description || `Telegram sendMessage failed (${response.status}).`,
    );
  }
}

export async function telegramSendToAllowlist(text: string): Promise<{
  sent: string[];
  failed: Array<{ chatId: string; error: string }>;
}> {
  const sent: string[] = [];
  const failed: Array<{ chatId: string; error: string }> = [];

  for (const chatId of env.telegramChatIds) {
    try {
      await telegramSendMessage(chatId, text);
      sent.push(chatId);
    } catch (error) {
      failed.push({
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { sent, failed };
}

function isStatusCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const command = normalized.split(/\s+/)[0]?.split('@')[0] ?? '';
  return (
    command === '/start' ||
    command === '/status' ||
    command === '/ping' ||
    command === '/help'
  );
}

/** Handle one Telegram update (webhook or polling). */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const chatId = update.message?.chat?.id;
  if (chatId == null) return;

  const text = String(update.message?.text || '').trim();

  if (isTelegramChatAllowed(chatId)) {
    if (isStatusCommand(text)) {
      await telegramSendMessage(chatId, buildTelegramBotStatusReply());
    }
    return;
  }

  await telegramSendMessage(chatId, 'Unauthorized. This bot is private.');
}

/**
 * Drain inbound updates via getUpdates (local Express only).
 * Do not use together with an active Telegram webhook.
 */
export async function telegramPoliceInboundUpdates(
  offset?: number,
): Promise<number | undefined> {
  if (!env.telegramBotToken) {
    return offset;
  }

  const url = new URL(telegramApiUrl('getUpdates'));
  url.searchParams.set('timeout', '0');
  url.searchParams.set('limit', '50');
  if (offset != null) {
    url.searchParams.set('offset', String(offset));
  }

  const response = await fetch(url);
  const data = (await response.json()) as TelegramApiResponse & {
    result?: TelegramUpdate[];
  };
  if (!response.ok || !data.ok || !Array.isArray(data.result)) {
    return offset;
  }

  let nextOffset = offset;
  for (const update of data.result) {
    nextOffset = update.update_id + 1;
    try {
      await handleTelegramUpdate(update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[telegram] update failed:', message);
    }
  }

  return nextOffset;
}

/** Register HTTPS webhook with Telegram (required on Vercel). */
export async function telegramSetWebhook(params?: {
  url?: string;
  secretToken?: string;
}): Promise<{ ok: boolean; description?: string; url: string }> {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }

  const url = (params?.url || env.telegramWebhookUrl).trim();
  if (!url) {
    throw new Error(
      'TELEGRAM_WEBHOOK_URL is not configured (e.g. https://your-app.vercel.app/api/telegram/webhook).',
    );
  }

  const secretToken = (params?.secretToken || env.telegramWebhookSecret).trim();
  const body: Record<string, unknown> = {
    url,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  };
  if (secretToken) {
    body.secret_token = secretToken;
  }

  const response = await fetch(telegramApiUrl('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as TelegramApiResponse;
  if (!response.ok || !data.ok) {
    throw new Error(
      data.description || `Telegram setWebhook failed (${response.status}).`,
    );
  }
  return { ok: true, description: data.description, url };
}

export async function telegramDeleteWebhook(): Promise<void> {
  if (!env.telegramBotToken) return;
  await fetch(telegramApiUrl('deleteWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: true }),
  });
}

export function isValidTelegramWebhookSecret(
  headerValue: string | undefined,
): boolean {
  if (!env.telegramWebhookSecret) {
    // If no secret configured, accept (not recommended for production).
    return true;
  }
  return headerValue === env.telegramWebhookSecret;
}

export function isValidCronAuthorization(
  authorizationHeader: string | undefined,
): boolean {
  if (!env.cronSecret) {
    return false;
  }
  return authorizationHeader === `Bearer ${env.cronSecret}`;
}
