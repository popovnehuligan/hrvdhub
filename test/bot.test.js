import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addDays, todayIn } from '../public/lib/shared.js';
import { isDue } from '../src/bot.js';
import { startApp } from './helpers.js';

const TODAY = '2026-09-27';
const item = (extra) => ({ status: 'wanted', planned: true, plannedPrecision: 'day', ...extra });

test('isDue: exact days within two days, months once they start', () => {
  assert.equal(isDue(item({ plannedDate: '2026-09-29' }), TODAY), true);
  assert.equal(isDue(item({ plannedDate: '2026-09-30' }), TODAY), false);
  assert.equal(isDue(item({ plannedDate: '2026-09-01' }), TODAY), true, 'overdue');
  assert.equal(isDue(item({ plannedDate: '2026-09-01', plannedPrecision: 'month' }), TODAY), true);
  assert.equal(isDue(item({ plannedDate: '2026-10-01', plannedPrecision: 'month' }), TODAY), false);
  assert.equal(isDue(item({ plannedDate: null }), TODAY), false);
  assert.equal(isDue(item({ plannedDate: '2026-09-28', status: 'bought' }), TODAY), false);
  assert.equal(isDue(item({ plannedDate: '2026-09-28', planned: false }), TODAY), false);
});

let ctx;
before(async () => {
  ctx = await startApp(
    { GROUP_CHAT_ID: '-100500', REMINDER_HOUR: '0', PUBLIC_URL: 'https://wishlist.example' },
    { members: { 1: 'administrator', 2: 'member' } },
  );
  await ctx.app.bot.start();
});
after(() => ctx.close());

test('start-up registers commands and the menu button', () => {
  assert.ok(ctx.telegram.sent('setMyCommands').length);
  const menu = ctx.telegram.sent('setChatMenuButton')[0];
  assert.equal(menu.params.menu_button.web_app.url, 'https://wishlist.example');
});

test('sends a reminder once per planned date', async () => {
  const today = todayIn(ctx.config.timezone);
  const store = ctx.app.store;
  store.meta.lastReminderDay = null;
  store.insert({
    id: 'soon',
    title: 'PA speakers',
    status: 'wanted',
    planned: true,
    plannedDate: addDays(today, 1),
    plannedPrecision: 'day',
    price: 450,
    quantity: 2,
    currency: 'EUR',
    votes: [],
    remindedFor: null,
  });
  const before = ctx.telegram.sent('sendMessage').length;
  await ctx.app.bot.runReminders();
  const messages = ctx.telegram.sent('sendMessage').slice(before);
  assert.equal(messages.length, 1);
  assert.match(messages[0].params.text, /Скоро покупаем/);
  assert.match(messages[0].params.text, /PA speakers<\/b> — завтра/);
  assert.match(messages[0].params.text, /900\s€/);

  store.meta.lastReminderDay = null;
  await ctx.app.bot.runReminders();
  assert.equal(ctx.telegram.sent('sendMessage').length, before + 1, 'not repeated');
});

test('/plan lists planned purchases for members only', async () => {
  const reply = async (from, chat = { id: from, type: 'private' }) => {
    const before = ctx.telegram.sent('sendMessage').length;
    await ctx.app.bot.handleMessage({ text: '/plan', chat, from: { id: from } });
    return ctx.telegram.sent('sendMessage').slice(before)[0].params.text;
  };
  assert.match(await reply(2), /План покупок/);
  assert.match(await reply(2), /PA speakers/);
  assert.match(await reply(99), /только для участников HOROVOD/);
  assert.match(await reply(99, { id: -100500, type: 'supergroup' }), /План покупок/);
});

test('/chatid helps with setup and /start offers the app', async () => {
  const before = ctx.telegram.sent('sendMessage').length;
  await ctx.app.bot.handleMessage({ text: '/chatid@horovod_test_bot', chat: { id: -100777, type: 'group' }, from: { id: 5 } });
  await ctx.app.bot.handleMessage({ text: '/start', chat: { id: 5, type: 'private' }, from: { id: 5 } });
  await ctx.app.bot.handleMessage({ text: '/plan@some_other_bot', chat: { id: 5, type: 'private' }, from: { id: 5 } });
  const [chatId, start, ...rest] = ctx.telegram.sent('sendMessage').slice(before);
  assert.match(chatId.params.text, /-100777/);
  assert.equal(start.params.reply_markup.inline_keyboard[0][0].web_app.url, 'https://wishlist.example');
  assert.equal(rest.length, 0, 'commands for other bots are ignored');
});
