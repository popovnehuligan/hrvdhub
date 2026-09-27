import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const list = (value) =>
  (value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const ids = (value) => new Set(list(value).map(Number).filter(Number.isSafeInteger));

export function loadConfig(env = process.env) {
  const botToken = (env.BOT_TOKEN || '').trim();
  if (!botToken) {
    throw new Error('BOT_TOKEN is not set. Copy .env.example to .env and fill it in (see README).');
  }
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  const reminderHour = env.REMINDER_HOUR === undefined ? 10 : Number(env.REMINDER_HOUR);

  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    botToken,
    // Public HTTPS address of this app, e.g. https://wishlist.horovod.sk
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Link that opens the Mini App from group messages. Defaults to t.me/<bot>?startapp
    appLink: (env.APP_LINK || '').replace(/\/+$/, ''),
    // HOROVOD Telegram group: its members may use the app, its admins are app admins.
    groupChatId: (env.GROUP_CHAT_ID || '').trim(),
    // Where the bot posts news and reminders. Defaults to the group.
    notifyChatId: (env.NOTIFY_CHAT_ID || env.GROUP_CHAT_ID || '').trim(),
    adminIds: ids(env.ADMIN_IDS),
    allowedUserIds: ids(env.ALLOWED_USER_IDS),
    currency: (env.CURRENCY || 'EUR').trim().toUpperCase(),
    timezone: env.TIMEZONE || 'Europe/Bratislava',
    reminderHour: Number.isFinite(reminderHour) ? reminderHour : 10,
    botPolling: env.BOT_POLLING !== 'false',
    telegramApiUrl: (env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, ''),
    // Only for local testing: lets link previews fetch from localhost / private networks.
    allowPrivateUrls: env.ALLOW_PRIVATE_URLS === 'true',
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    publicDir: path.join(ROOT, 'public'),
  };
}
