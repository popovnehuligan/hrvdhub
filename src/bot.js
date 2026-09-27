import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES,
  PRIORITIES,
  daysBetween,
  describePlan,
  findOption,
  formatMoney,
  groupPlan,
  itemTotal,
  monthsBetween,
  sumTotals,
  todayIn,
} from '../public/lib/shared.js';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

const PHOTO_TYPES = { jpg: 'image/jpeg', png: 'image/png' };

/** Planned items whose date has come: exact days within 2 days (or past), month plans once the month starts. */
export function isDue(item, today) {
  if (item.status !== 'wanted' || !item.planned || !item.plannedDate) return false;
  if (item.plannedPrecision === 'month') return monthsBetween(today, item.plannedDate) <= 0;
  return daysBetween(today, item.plannedDate) <= 2;
}

/**
 * The Telegram side: /commands, the chat menu button, posts to the group when
 * something is added, planned or bought, and a daily "coming up to buy" reminder.
 */
export function createBot({ config, telegram, store, access }) {
  let me = null;
  let running = false;
  let offset = 0;
  let abort = null;
  let reminderTimer = null;
  const today = () => todayIn(config.timezone);

  function appLink(startParam) {
    const base = config.appLink || (me?.username ? `https://t.me/${me.username}` : '');
    if (!base) return null;
    return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : `${base}?startapp`;
  }

  function openButton(startParam, text = 'Open wishlist') {
    const url = appLink(startParam);
    return url ? { inline_keyboard: [[{ text, url }]] } : undefined;
  }

  function priceText(item) {
    const total = itemTotal(item);
    if (total == null) return '';
    if (item.quantity > 1) return `${formatMoney(total, item.currency)} (${item.quantity} × ${formatMoney(item.price, item.currency)})`;
    return formatMoney(total, item.currency);
  }

  function planText(item) {
    const plan = describePlan(item, today());
    if (!plan) return '';
    if (plan.tone === 'nodate') return 'date not set yet';
    return `${plan.label.toLowerCase()} (${plan.detail})`;
  }

  function itemLines(item) {
    const category = findOption(CATEGORIES, item.category);
    const priority = findOption(PRIORITIES, item.priority);
    return [
      `${category.emoji} ${category.label} · ${priority.emoji} ${priority.label}`,
      priceText(item) && `💶 ${priceText(item)}`,
      item.note && `📝 ${escape(shorten(item.note, 300))}`,
    ].filter(Boolean);
  }

  async function post(item, text) {
    if (!config.notifyChatId) return;
    const params = { chat_id: config.notifyChatId, parse_mode: 'HTML', reply_markup: openButton(`item_${item.id}`) };
    const extension = item.image?.split('.').pop();
    if (PHOTO_TYPES[extension]) {
      try {
        const buffer = await fs.promises.readFile(path.join(config.uploadsDir, item.image));
        await telegram.upload('sendPhoto', { ...params, caption: text }, 'photo', {
          buffer,
          filename: item.image,
          contentType: PHOTO_TYPES[extension],
        });
        return;
      } catch (error) {
        console.warn(`Couldn't send the photo, sending text instead: ${error.message}`);
      }
    }
    try {
      await telegram.call('sendMessage', { ...params, text, link_preview_options: { is_disabled: true } });
    } catch (error) {
      console.error(`Couldn't post to the group: ${error.message}`);
    }
  }

  const notify = {
    added(item) {
      const lines = [`🆕 <b>${escape(item.createdBy.name)}</b> added a wish:`, `<b>${escape(item.title)}</b>`, ...itemLines(item)];
      if (item.planned) lines.push(`🗓 Planned: ${planText(item)}`);
      return post(item, lines.join('\n'));
    },
    planned(item) {
      const lines = [`🗓 <b>Planning to buy</b>: ${escape(item.title)}`, `When: <b>${planText(item)}</b>`];
      if (priceText(item)) lines.push(`💶 ${priceText(item)}`);
      return post(item, lines.join('\n'));
    },
    bought(item) {
      const paid = item.boughtPrice ?? itemTotal(item);
      const lines = [`✅ <b>Bought</b>: ${escape(item.title)}`];
      if (paid != null) lines.push(`💶 ${formatMoney(paid, item.currency)}`);
      return post(item, lines.join('\n'));
    },
  };

  function planSummary() {
    const now = today();
    const groups = groupPlan(store.items, now);
    const wishes = store.items.filter((item) => item.status === 'wanted' && !item.planned).length;
    if (!groups.length) return `🗓 Nothing is planned yet.\n${wishes} wishes are waiting on the wishlist.`;
    const lines = ['🗓 <b>Purchase plan</b>'];
    for (const group of groups) {
      const total = group.total ? ` — ${formatMoney(group.total, config.currency)}` : '';
      lines.push('', `<b>${escape(group.title)}</b>${group.note ? ` (${group.note.toLowerCase()})` : ''}${total}`);
      for (const item of group.items) {
        const plan = describePlan(item, now);
        const when = item.plannedPrecision === 'day' ? ` · ${plan.detail}` : '';
        const price = priceText(item) ? ` · ${priceText(item)}` : '';
        lines.push(`• ${escape(item.title)}${when}${price}`);
      }
    }
    const { total } = sumTotals(groups.flatMap((group) => group.items));
    lines.push('', `Total planned: <b>${formatMoney(total, config.currency)}</b>`);
    if (wishes) lines.push(`Plus ${wishes} more on the wishlist.`);
    return shorten(lines.join('\n'), 4000);
  }

  async function runReminders() {
    const now = today();
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()),
    );
    if (hour < config.reminderHour || store.meta.lastReminderDay === now) return;
    const due = store.items.filter((item) => isDue(item, now) && item.remindedFor !== item.plannedDate);
    if (due.length && config.notifyChatId) {
      const lines = ['⏰ <b>Coming up to buy</b>'];
      for (const item of due) {
        lines.push(`• <b>${escape(item.title)}</b> — ${planText(item)}${priceText(item) ? ` · ${priceText(item)}` : ''}`);
      }
      const { total } = sumTotals(due);
      if (total) lines.push('', `Total: <b>${formatMoney(total, config.currency)}</b>`);
      await telegram.call('sendMessage', {
        chat_id: config.notifyChatId,
        text: shorten(lines.join('\n'), 4000),
        parse_mode: 'HTML',
        reply_markup: openButton('plan', 'Open the plan'),
      });
      for (const item of due) item.remindedFor = item.plannedDate;
    }
    store.meta.lastReminderDay = now;
    store.save();
  }

  async function mayReadPlan(message) {
    const chatId = String(message.chat.id);
    if (chatId === config.groupChatId || chatId === config.notifyChatId) return true;
    if (!message.from) return false;
    return (await access.check(message.from.id)).allowed;
  }

  async function handleMessage(message) {
    const text = message.text || '';
    if (!text.startsWith('/')) return;
    const [command, mention] = text.split(/\s+/)[0].slice(1).split('@');
    if (mention && me && mention.toLowerCase() !== me.username.toLowerCase()) return;
    const chat = message.chat;
    const reply = (replyText, markup) =>
      telegram.call('sendMessage', { chat_id: chat.id, text: replyText, parse_mode: 'HTML', reply_markup: markup });

    switch (command.toLowerCase()) {
      case 'start':
      case 'wishlist':
      case 'help': {
        const canUseWebApp = chat.type === 'private' && config.publicUrl.startsWith('https://');
        const markup = canUseWebApp
          ? { inline_keyboard: [[{ text: '🛒 Open wishlist', web_app: { url: config.publicUrl } }]] }
          : openButton();
        return reply(
          [
            '<b>HOROVOD wishlist</b> 🎸',
            'Everything we want to get for the Horovod Hub: instruments, tech, and anything else we need to buy.',
            '',
            'Add a wish with a photo or a shop link, vote for the ones you want most, and see what we are planning to buy and when.',
            '',
            '/plan — what we are planning to buy',
            '/chatid — this chat’s ID (for setup)',
          ].join('\n'),
          markup,
        );
      }
      case 'plan':
        if (!(await mayReadPlan(message))) return reply('Sorry, the wishlist is only for HOROVOD members.');
        return reply(planSummary(), openButton('plan', 'Open the plan'));
      case 'chatid':
        return reply(
          `This chat’s ID: <code>${chat.id}</code>${message.from ? `\nYour user ID: <code>${message.from.id}</code>` : ''}`,
        );
      default:
        return undefined;
    }
  }

  async function setup() {
    await telegram.call('setMyCommands', {
      commands: [
        { command: 'wishlist', description: 'Open the wishlist' },
        { command: 'plan', description: 'What we are planning to buy' },
        { command: 'chatid', description: 'Show this chat’s ID (for setup)' },
      ],
    });
    if (config.publicUrl.startsWith('https://')) {
      await telegram.call('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Wishlist', web_app: { url: config.publicUrl } },
      });
    } else {
      console.warn('PUBLIC_URL is not an https:// address, so the bot has no "Wishlist" menu button yet.');
    }
  }

  async function poll() {
    await telegram.call('deleteWebhook').catch(() => {});
    while (running) {
      abort = new AbortController();
      try {
        const updates = await telegram.call(
          'getUpdates',
          { offset, timeout: 30, allowed_updates: ['message'] },
          { signal: abort.signal },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message).catch((error) => console.error(`Bot command failed: ${error.message}`));
          }
        }
      } catch (error) {
        if (!running) break;
        console.error(`Bot polling error: ${error.message}`);
        await sleep((error.retryAfter || 5) * 1000);
      }
    }
  }

  return {
    notify,
    handleMessage,
    runReminders,
    planSummary,
    appLink,
    async start() {
      running = true;
      for (let attempt = 0; running && !me; attempt += 1) {
        try {
          me = await telegram.call('getMe');
          console.log(`Bot @${me.username} is up.`);
        } catch (error) {
          console.error(`Can't reach Telegram yet (${error.message}); retrying…`);
          await sleep(Math.min(60_000, 2000 * 2 ** attempt));
        }
      }
      if (!running) return;
      await setup().catch((error) => console.warn(`Bot setup: ${error.message}`));
      const remind = () => runReminders().catch((error) => console.error(`Reminder failed: ${error.message}`));
      reminderTimer = setInterval(remind, 10 * 60_000);
      reminderTimer.unref();
      remind();
      if (config.botPolling) poll();
    },
    stop() {
      running = false;
      abort?.abort();
      clearInterval(reminderTimer);
    },
  };
}
