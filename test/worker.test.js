// The Cloudflare Worker backend (worker/src/index.js), run in Node against a real SQLite database
// (node:sqlite, the engine D1 is built on), an in-memory KV and a pretend Telegram.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../worker/src/index.js';
import { signInitDataForTests } from './sign.js';

const TOKEN = '777:TEST-wishlist-token';
const ORIGIN = 'https://hrvd-wishlist.example.workers.dev';
const admin = { id: 1, first_name: 'Миша' };
const member = { id: 2, first_name: 'Настя' };
const other = { id: 3, first_name: 'Богдан' };

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync('worker/schema.sql', 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) || null,
    run: async () => (db.prepare(sql).run(...args), { success: true }),
  });
  return { raw: db, prepare: (sql) => statement(sql), batch: (list) => Promise.all(list.map((s) => s.all())) };
}

function kv() {
  const store = new Map();
  return {
    store,
    put: async (key, value, options = {}) => store.set(key, { value: new Uint8Array(value).slice().buffer, metadata: options.metadata || null }),
    getWithMetadata: async (key) => store.get(key) || { value: null, metadata: null },
  };
}

const jpeg = (size, fill = 1) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};
const dataUrl = (bytes) => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;

/** A world: env, the fetch Telegram and shops answer, and helpers to call the worker. */
function world({ members = { 1: 'creator', 2: 'member', 3: 'member' }, props = {}, telegram = () => null, pages = {} } = {}) {
  const env = { DB: d1(), PHOTOS: kv(), BOT_TOKEN: TOKEN, PUBLIC_URL: ORIGIN, VERSION: 'test' };
  const base = { GROUP_CHAT_ID: '-100555', TOPIC_ID: '77', BOT_USERNAME: 'hrvd_wishlist_bot', BOT_HAS_MAIN_APP: 'yes', ...props };
  for (const [key, value] of Object.entries(base)) env.DB.raw.prepare('INSERT INTO props (key, value) VALUES (?1, ?2)').run(key, value);
  const sent = [];
  let messageId = 100;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const tg = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (tg) {
      assert.equal(tg[1], TOKEN);
      const params = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
      sent.push({ method: tg[2], params });
      const custom = telegram(tg[2], params);
      if (custom) return Response.json(custom);
      if (tg[2] === 'getChatMember') {
        const status = members[params.user_id];
        return Response.json(
          status === 'unknown'
            ? { ok: false, error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' }
            : { ok: true, result: { status: status || 'left' } },
        );
      }
      if (tg[2] === 'getUpdates') return Response.json({ ok: true, result: [] });
      return Response.json({ ok: true, result: { message_id: ++messageId } });
    }
    const page = pages[url];
    if (!page) return new Response('not found', { status: 404 });
    return new Response(page.body, { status: 200, headers: { 'content-type': page.type || 'text/html' } });
  };
  const ctx = { waitUntil: () => {} };
  const call = async (action, payload = {}, user, initData) => {
    const body = JSON.stringify({ action, payload, initData: initData ?? (user ? signInitDataForTests(user, TOKEN) : '') });
    const response = await worker.fetch(new Request(`${ORIGIN}/`, { method: 'POST', body }), env, ctx);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    return response.json();
  };
  const get = (path) => worker.fetch(new Request(`${ORIGIN}${path}`), env, ctx);
  const hourly = () => new Promise((resolve) => worker.scheduled({}, env, { waitUntil: resolve }));
  return { env, sent, call, get, hourly, of: (method) => sent.filter((c) => c.method === method) };
}

const shop = {
  'https://shop.example/sm58': {
    body: `<meta property="og:title" content="Shure SM58 &amp; clip"><meta property="og:image" content="/img/sm58.jpg">
           <meta property="product:price:amount" content="99,00"><meta property="product:price:currency" content="EUR">`,
  },
  'https://shop.example/img/sm58.jpg': { body: jpeg(4096, 3), type: 'image/jpeg' },
};

test('worker: only members with a genuine Telegram signature get in', async () => {
  const w = world({ members: { 1: 'creator', 2: 'member', 8: 'unknown' } });
  assert.equal((await w.call('list', {}, null, 'user=%7B%22id%22%3A1%7D&auth_date=9999999999&hash=' + 'a'.repeat(64))).status, 401);
  const ok = await w.call('list', {}, member);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual([ok.data.me.isAdmin, ok.data.items.length], [false, 0]);
  assert.equal((await w.call('list', {}, admin)).data.me.isAdmin, true);
  assert.equal((await w.call('list', {}, { id: 99, first_name: 'Eve' })).status, 403);
  const meet = await w.call('list', {}, { id: 8, first_name: 'Даша' });
  assert.deepEqual([meet.status, meet.code, meet.bot], [403, 'meet_bot', 'hrvd_wishlist_bot']);
  const health = await (await w.get('/')).json();
  assert.equal(health.data.status.denied.count, 2);
});

test('worker: an uploaded photo is kept with a small copy, served, and posted to the topic', async () => {
  const w = world();
  const up = await w.call('upload', { photo: dataUrl(jpeg(5000)), thumb: dataUrl(jpeg(1200, 2)) }, member);
  assert.equal(up.ok, true, up.error);
  assert.match(up.data.image, /^photo:[\w-]+$/);
  assert.equal(up.data.imageUrl, `${ORIGIN}/photo/${up.data.image.slice(6)}`);
  assert.equal((await w.call('upload', { photo: `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` }, member)).status, 415);

  const created = await w.call('create', { wish: { title: 'Микрофон', image: up.data.image, imageSource: 'upload' } }, member);
  assert.equal(created.ok, true, created.error);
  assert.equal(created.data.posted, true);
  const card = w.of('sendPhoto').at(-1).params;
  assert.equal(card.chat_id, '-100555');
  assert.equal(card.message_thread_id, '77');
  assert.ok(card.photo instanceof Blob && card.photo.size === 5000, 'the photo itself is sent');
  assert.match(card.caption, /^🆕 <b>НОВОЕ ЖЕЛАНИЕ<\/b>\n\n<b>Микрофон<\/b>[\s\S]*Добавил\(а\): Настя$/);

  const full = await w.get(`/photo/${up.data.image.slice(6)}`);
  assert.equal((await full.arrayBuffer()).byteLength, 5000);
  assert.match(full.headers.get('cache-control'), /immutable/);
  assert.equal((await (await w.get(`/photo/${up.data.image.slice(6)}?w=480`)).arrayBuffer()).byteLength, 1200, 'cards get the small copy');
  assert.equal((await w.get('/photo/nope!')).status, 404);
});

test('worker: a shop link brings its picture, title and price', async () => {
  const w = world({ pages: shop });
  const preview = await w.call('preview', { url: 'shop.example/sm58' }, member);
  assert.equal(preview.ok, true, preview.error);
  assert.deepEqual([preview.data.title, preview.data.price, preview.data.currency], ['Shure SM58 & clip', 99, 'EUR']);
  assert.match(preview.data.image, /^photo:/);
  const created = await w.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  assert.match(created.data.item.image, /^photo:/, 'a wish with only a link gets the picture');
  assert.equal((await w.call('preview', { url: 'https://shop.example/missing' }, member)).status, 422);
});

test('worker: hearts are per person and never lost; plans and purchases reply to the card', async () => {
  const w = world({ pages: shop });
  const { item } = (await w.call('create', { wish: { title: 'Малый барабан', link: 'https://shop.example/nothing-here' } }, member)).data;
  const cardId = 101; // the first message the pretend Telegram sent: the wish card
  await Promise.all([w.call('vote', { id: item.id }, member), w.call('vote', { id: item.id }, other)]);
  let mine = (await w.call('list', {}, member)).data.items[0];
  assert.deepEqual([mine.votes, mine.voted], [2, true]);
  await w.call('vote', { id: item.id }, member);
  mine = (await w.call('list', {}, member)).data.items[0];
  assert.deepEqual([mine.votes, mine.voted, mine.voters], [1, false, ['Богдан']]);

  assert.equal((await w.call('update', { id: item.id, patch: { planned: true } }, member)).status, 403);
  const planned = await w.call('update', { id: item.id, patch: { planned: true, plannedDate: '2026-11-17', plannedPrecision: 'month' } }, admin);
  assert.equal(planned.ok, true, planned.error);
  assert.equal(planned.data.posted, true);
  const reply = w.of('sendMessage').at(-1).params;
  assert.match(reply.text, /^📅 <b>ПЛАНИРУЕМ КУПИТЬ<\/b>[\s\S]*Ноябрь 2026[\s\S]*Запланировал\(а\): Миша$/);
  assert.equal(reply.reply_parameters.message_id, cardId);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].url, 'https://t.me/hrvd_wishlist_bot?startapp=plan');
  assert.equal((await w.call('update', { id: item.id, patch: { note: 'Ludwig' } }, admin)).data.posted, null);
  const bought = await w.call('update', { id: item.id, patch: { status: 'bought', boughtPrice: '149,9', boughtAt: '2026-11-20' } }, admin);
  assert.equal(bought.data.item.boughtPrice, 149.9);
  assert.match(w.of('sendMessage').at(-1).params.text, /^✅ <b>КУПЛЕНО<\/b>[\s\S]*Оплачено: 149,90/);
  assert.equal((await w.call('list', {}, other)).data.items[0].voted, true, 'votes survive other edits');
});

test('worker: members edit and delete only their own; a retried save adds one wish', async () => {
  const w = world();
  const rid = 'r-123';
  const first = await w.call('create', { wish: { title: 'Струны', link: 'https://shop.example/strings' }, rid }, member);
  const again = await w.call('create', { wish: { title: 'Струны', link: 'https://shop.example/strings' }, rid }, member);
  assert.equal(again.data.item.id, first.data.item.id);
  assert.equal((await w.call('list', {}, member)).data.items.length, 1);
  const id = first.data.item.id;
  assert.equal((await w.call('update', { id, patch: { title: 'Чужое' } }, other)).status, 403);
  assert.equal((await w.call('delete', { id }, other)).status, 403);
  assert.equal((await w.call('update', { id, patch: { title: 'Струны Elixir' } }, member)).data.item.title, 'Струны Elixir');
  await w.call('vote', { id }, other);
  assert.equal((await w.call('delete', { id }, member)).ok, true);
  assert.equal((await w.call('list', {}, member)).data.items.length, 0);
  assert.equal(w.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0, 'its hearts go too');
  assert.equal((await w.call('vote', { id }, member)).status, 404);
  assert.equal((await w.call('nonsense', {}, member)).error, 'Неизвестное действие');
});

test('worker: a post that did not go through is sent again by the hourly run, once', async () => {
  let down = true;
  const w = world({ telegram: (method) => (down && /^send/.test(method) ? { ok: false, error_code: 502, description: 'Bad Gateway' } : null) });
  const created = await w.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/x' } }, member);
  assert.equal(created.data.posted, false);
  let health = await (await w.get('/')).json();
  assert.deepEqual([health.data.status.posted, /Bad Gateway/.test(health.data.status.lastPostError)], [0, true]);
  down = false;
  await w.hourly();
  health = await (await w.get('/')).json();
  assert.deepEqual([health.data.status.posted, health.data.status.lastPostError], [1, null]);
  const before = w.of('sendMessage').length;
  await w.hourly();
  assert.equal(w.of('sendMessage').length, before, 'not posted twice');
});

test('worker: admins export everything, with voters', async () => {
  const w = world();
  const { item } = (await w.call('create', { wish: { title: 'Кабели', link: 'https://shop.example/c' } }, member)).data;
  await w.call('vote', { id: item.id }, other);
  assert.equal((await w.call('export', {}, member)).status, 403);
  const out = await w.call('export', {}, admin);
  assert.deepEqual(out.data.wishes[0].votes, [{ id: 3, name: 'Богдан' }]);
});

test('worker: «8.499» is eight thousand, and editing the price corrects the card in the group', async () => {
  const w = world();
  const created = await w.call('create', { wish: { title: 'Ford Transit', link: 'https://autobazar.example/ford', price: '8.499' } }, member);
  assert.equal(created.data.item.price, 8499);
  assert.match(w.of('sendMessage').at(-1).params.text, /Цена: 8\s499\s€/);
  const id = created.data.item.id;
  await w.call('update', { id, patch: { price: '7 990' } }, member);
  const edit = w.of('editMessageText').at(-1) || w.of('editMessageCaption').at(-1);
  assert.ok(edit, 'the card is edited');
  assert.match(edit.params.text || edit.params.caption, /7\s990/);
  assert.equal(edit.params.message_id, 101);
  const before = w.sent.length;
  await w.call('vote', { id }, other);
  await w.call('update', { id, patch: { planned: false } }, admin);
  assert.equal(w.sent.filter((c) => /^edit/.test(c.method)).length, 1, 'other changes leave the card alone');
  assert.ok(w.sent.length >= before);
});

test('worker: screen sizes sent with list are kept (12 at most) for check-ups', async () => {
  const w = world();
  for (let i = 0; i < 14; i++) await w.call('list', { client: { w: 1460 + i, dpr: 1.25, platform: 'tdesktop', junk: { a: 1 } } }, member);
  const { clients } = (await (await w.get('/')).json()).data;
  assert.equal(clients.length, 12);
  assert.deepEqual([clients[0].w, clients[0].dpr, clients[0].platform, clients[0].junk], [1473, 1.25, 'tdesktop', undefined]);
});
