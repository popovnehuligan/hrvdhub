import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { createGas } from './gas-harness.js';

const admin = { id: 1, first_name: 'Миша' };
const member = { id: 2, first_name: 'Настя' };
const other = { id: 3, first_name: 'Богдан' };
const stranger = { id: 99, first_name: 'Eve' };
const members = { 1: 'creator', 2: 'member', 3: 'member' };

function png() {
  const bytes = Buffer.alloc(2048, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

const shop = {
  'https://shop.example/sm58': {
    body: `<meta property="og:title" content="Shure SM58 &amp; clip"><meta property="og:image" content="/img/sm58.png">
           <meta property="product:price:amount" content="99,00"><meta property="product:price:currency" content="EUR">`,
  },
  'https://shop.example/img/sm58.png': { body: png(), type: 'image/png' },
};

const world = () => createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot' }, members, pages: shop });

test('Shared.gs is up to date with public/lib/shared.js', () => {
  execFileSync(process.execPath, ['tools/build-gs.mjs', '--check']);
});

test('the script uses only syntax Google Apps Script can parse', () => {
  // Apps Script's editor rejects some newer JavaScript that Node accepts.
  const code = fs.readFileSync('public/setup/wishlist-script.txt', 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [name, pattern] of [
    ['numeric separators like 1_000', /\b\d+_\d/],
    ['nullish coalescing ??', /\?\?/],
    ['optional chaining ?.', /\?\.(?![0-9])/],
    ['logical assignment ||= &&=', /(\|\||&&)=/],
    ['private #fields', /(^|[^\w'"/&])#[a-z_]\w*\s*[=(;]/im],
    ['import/export', /^\s*(import|export)\s/m],
  ]) {
    const match = code.match(pattern);
    assert.equal(match, null, `${name}: …${match && code.slice(Math.max(0, match.index - 40), match.index + 20)}…`);
  }
});

test('only signed Telegram users from the group get in', () => {
  const gas = world();
  assert.match(gas.call('list').error, /через Telegram/);
  assert.equal(gas.call('list', {}, stranger).status, 403);
  const list = gas.call('list', {}, member);
  assert.equal(list.ok, true);
  assert.deepEqual(list.data.me, { user: { id: 2, name: 'Настя', username: null }, isAdmin: false, currency: 'EUR' });
  assert.equal(gas.call('list', {}, admin).data.me.isAdmin, true, 'group creator is an admin');

  const forged = gas.context.doPost({ postData: { contents: JSON.stringify({ action: 'list', initData: 'user=%7B%22id%22%3A1%7D&auth_date=9999999999&hash=' + 'a'.repeat(64) }) } });
  assert.match(JSON.parse(forged.text).error, /Подпись/);
});

test('a wish needs a photo or a link; a link brings its picture from the shop', () => {
  const gas = world();
  assert.match(gas.call('create', { wish: { title: 'Кабели' } }, member).error, /фото или ссылку/);

  const created = gas.call('create', { wish: { title: 'Микрофон', link: 'shop.example/sm58', category: 'tech' } }, member);
  assert.equal(created.ok, true, created.error);
  const item = created.data.item;
  assert.equal(item.link, 'https://shop.example/sm58');
  assert.match(item.imageUrl, /^https:\/\/lh3\.googleusercontent\.com\/d\/file1\w+=w1000$/);
  assert.equal([...gas.files.values()][0].shared, true, 'photo is shared by link');

  const posted = gas.sent('sendPhoto')[0];
  assert.equal(posted.params.chat_id, '-100555');
  assert.match(posted.params.caption, /Настя<\/b> добавил\(а\) желание/);
  assert.equal(typeof posted.params.photo.getBytes, 'function', 'the photo itself is sent');

  const row = gas.sheets.get('wishes').rows[1];
  assert.deepEqual(Array.from(row.slice(0, 4)), [item.id, 'Микрофон', 'Техника и звук', 'Желательно']);
});

test('link previews read the page', () => {
  const gas = world();
  const preview = gas.call('preview', { url: 'https://shop.example/sm58' }, member);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.data.title, 'Shure SM58 & clip');
  assert.equal(preview.data.price, 99);
  assert.equal(preview.data.currency, 'EUR');
  assert.match(preview.data.image, /^drive:/);
  assert.equal(gas.call('preview', { url: 'https://shop.example/missing' }, member).status, 422);
});

test('uploads must be real pictures', () => {
  const gas = world();
  const ok = gas.call('upload', { photo: `data:image/png;base64,${png().toString('base64')}` }, member);
  assert.match(ok.data.image, /^drive:file/);
  const svg = gas.call('upload', { photo: `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` }, member);
  assert.equal(svg.status, 415);
});

test('only admins plan and buy, and the group hears about it', () => {
  const gas = world();
  const id = gas.call('create', { wish: { title: 'Малый барабан', link: 'https://muziker.sk/snare' } }, member).data.item.id;

  assert.equal(gas.call('update', { id, patch: { planned: true } }, member).status, 403);

  const planned = gas.call('update', { id, patch: { planned: true, plannedDate: '2026-11-17', plannedPrecision: 'month' } }, admin);
  assert.equal(planned.data.item.plannedDate, '2026-11-01');
  const message = gas.sent('sendMessage').at(-1).params;
  assert.match(message.text, /Планируем купить<\/b>: Малый барабан/);
  assert.match(message.text, /Ноябрь 2026/);
  assert.equal(message.reply_markup.inline_keyboard[0][0].url, `https://t.me/horovod_wishlist_bot?startapp=item_${id}`);

  const bought = gas.call('update', { id, patch: { status: 'bought', boughtPrice: '149,9', boughtAt: '2026-11-20' } }, admin);
  assert.equal(bought.data.item.boughtPrice, 149.9);
  assert.match(gas.sent('sendMessage').at(-1).params.text, /Куплено<\/b>: Малый барабан\nОплачено: 149,90/);
});

test('members change only their own wishes; votes toggle', () => {
  const gas = world();
  const id = gas.call('create', { wish: { title: 'Струны', link: 'https://shop.example/strings' } }, member).data.item.id;
  assert.equal(gas.call('update', { id, patch: { title: 'Моё' } }, other).status, 403);
  assert.equal(gas.call('delete', { id }, other).status, 403);
  assert.equal(gas.call('update', { id, patch: { link: '' } }, member).ok, false, 'neither photo nor link left');
  assert.equal(gas.call('update', { id, patch: { title: 'Струны 10-46' } }, member).data.item.title, 'Струны 10-46');

  const voted = gas.call('vote', { id }, other).data.item;
  assert.deepEqual([voted.votes, voted.voted, voted.voters], [1, true, ['Богдан']]);
  assert.equal(gas.call('vote', { id }, other).data.item.votes, 0);

  assert.equal(gas.call('delete', { id }, member).ok, true);
  assert.equal(gas.call('update', { id, patch: { title: 'x' } }, member).status, 404);
});

test('a retried save does not add the wish twice', () => {
  const gas = world();
  const payload = { rid: 'abc123', wish: { title: 'Чайник', link: 'https://alza.sk/kettle' } };
  const first = gas.call('create', payload, member).data.item;
  const again = gas.call('create', payload, member).data.item;
  assert.equal(again.id, first.id);
  assert.equal(gas.call('list', {}, member).data.items.length, 1);
});

test('the morning reminder goes out once per planned date', () => {
  const gas = world();
  const today = gas.context.today();
  const id = gas.call('create', { wish: { title: 'Прожекторы', link: 'https://muziker.sk/led', price: 35, quantity: 4 } }, admin).data.item.id;
  gas.call('update', { id, patch: { planned: true, plannedDate: today } }, admin);

  const before = gas.sent('sendMessage').length;
  gas.context.dailyReminders();
  const reminder = gas.sent('sendMessage').slice(before);
  assert.equal(reminder.length, 1);
  assert.match(reminder[0].params.text, /Скоро покупаем/);
  assert.match(reminder[0].params.text, /Прожекторы<\/b> — сегодня/);
  gas.context.dailyReminders();
  assert.equal(gas.sent('sendMessage').length, before + 1, 'not repeated');
});

test('setup finds the group, sets the menu button and the reminder', () => {
  const gas = createGas({ props: { APP_URL: 'https://popovnehuligan.github.io/hrvdhub/' }, members });
  const report = gas.context.setup();
  assert.equal(gas.properties.GROUP_CHAT_ID, '-100555');
  assert.equal(gas.properties.BOT_USERNAME, 'horovod_wishlist_bot');
  assert.equal(gas.sent('setChatMenuButton')[0].params.menu_button.web_app.url, 'https://popovnehuligan.github.io/hrvdhub/');
  assert.deepEqual(gas.triggers.map((t) => [t.handler, t.hour]), [['dailyReminders', 10]]);
  assert.ok(report.some((line) => line.includes('HOROVOD')));
  gas.context.setup();
  assert.equal(gas.triggers.length, 1, 'running setup again does not double the reminder');
});

test('parses shop pages: Open Graph, JSON-LD, relative addresses', () => {
  const { context } = world();
  const ld = context.parseHtmlMeta(
    `<title>Mixer | Shop</title><script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Behringer X32",
      "image":["//cdn.example/x32.png"],"offers":{"@type":"AggregateOffer","lowPrice":"2 199,90","priceCurrency":"EUR"}}]}</script>`,
    'https://shop.example/a/x32',
  );
  assert.equal(ld.title, 'Behringer X32');
  assert.deepEqual(Array.from(ld.images), ['https://cdn.example/x32.png']);
  assert.equal(ld.price, 2199.9);
  assert.equal(context.resolveUrl('https://shop.example/a/b?x=1', 'img.png'), 'https://shop.example/a/img.png');
  assert.equal(context.parsePrice('1.299'), 1299);
});
