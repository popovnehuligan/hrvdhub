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

const world = () => createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot', BOT_HAS_MAIN_APP: 'yes' }, members, pages: shop });

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

test('the setup page can put the bot key into the script', () => {
  const code = fs.readFileSync('public/setup/wishlist-script.txt', 'utf8');
  assert.equal(code.split("var PASTED_BOT_TOKEN = '';").length, 2, 'exactly one place for the key');
  const setupPage = fs.readFileSync('public/setup.html', 'utf8');
  assert.ok(setupPage.includes(`const marker = "var PASTED_BOT_TOKEN = '';";`));
  assert.ok(fs.existsSync('public/brand/bot-avatar.jpg'), 'setup() downloads the bot picture from the site');
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

test('setup does the whole bot: key, group, button, description, picture, reminder', () => {
  const avatar = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]);
  const gas = createGas({
    props: { BOT_TOKEN: undefined },
    members,
    pages: { 'https://popovnehuligan.github.io/hrvdhub/brand/bot-avatar.jpg': { body: avatar, type: 'image/jpeg' } },
  });
  delete gas.properties.BOT_TOKEN;
  gas.context.PASTED_BOT_TOKEN = '777:TEST-wishlist-token';
  const report = gas.context.setup();

  assert.equal(gas.properties.BOT_TOKEN, '777:TEST-wishlist-token', 'the pasted key is saved');
  assert.equal(gas.properties.GROUP_CHAT_ID, '-100555', 'the group the bot is still in (not the one it left)');
  assert.equal(gas.properties.BOT_USERNAME, 'horovod_wishlist_bot');
  assert.equal(gas.sent('setChatMenuButton')[0].params.menu_button.web_app.url, 'https://popovnehuligan.github.io/hrvdhub/');
  assert.match(gas.sent('setMyDescription')[0].params.description, /Вишлист HOROVOD/);
  assert.ok(gas.sent('setMyShortDescription')[0].params.short_description.length <= 120);
  assert.ok(gas.sent('setMyDescription')[0].params.description.length <= 512);

  const photo = gas.sent('setMyProfilePhoto')[0].params;
  assert.deepEqual(JSON.parse(photo.photo), { type: 'static', photo: 'attach://avatar' });
  assert.equal(photo.avatar.getBytes().length, avatar.length, 'the picture itself is uploaded');
  assert.deepEqual(gas.triggers.map((t) => [t.handler, t.hour]), [['dailyReminders', 10]]);
  assert.ok(report.some((line) => line.includes('HOROVOD')));
  assert.equal(gas.properties.TOPIC_ID, '77', 'found the Wishlist topic');
  assert.ok(report.some((line) => line.includes('«Wishlist»')));

  // posts go into that topic
  gas.properties.BOT_HAS_MAIN_APP = 'yes';
  Object.assign(members, { 2: 'member' });
  gas.call('create', { wish: { title: 'Кабели', link: 'https://shop.example/cables' } }, member);
  assert.equal(gas.sent('sendMessage').at(-1).params.message_thread_id, 77);
  assert.ok(!report.some((line) => line.startsWith('✗')), report.join('\n'));

  gas.context.setup();
  assert.equal(gas.triggers.length, 1, 'running setup again does not double the reminder');
  assert.equal(gas.sent('setMyProfilePhoto').length, 1, 'and does not upload the picture again');
});

test('without the Main Mini App, group buttons open the bot chat', () => {
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot', BOT_HAS_MAIN_APP: 'no' }, members, pages: shop });
  gas.call('create', { wish: { title: 'Чайник', link: 'https://alza.sk/kettle' } }, member);
  const button = gas.sent('sendMessage').at(-1).params.reply_markup.inline_keyboard[0][0];
  assert.deepEqual({ ...button }, { text: 'Открыть вишлист', url: 'https://t.me/horovod_wishlist_bot' });
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

test('a wish with a photo is posted into the topic', () => {
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', TOPIC_ID: '77', BOT_USERNAME: 'horovod_wishlist_bot', BOT_HAS_MAIN_APP: 'yes' }, members, pages: shop });
  const created = gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  assert.equal(created.ok, true, created.error);
  const posted = gas.sent('sendPhoto').at(-1).params;
  assert.equal(posted.message_thread_id, '77', 'the topic goes along with the uploaded photo');
  assert.equal(typeof posted.photo.getBytes, 'function');
  assert.equal(gas.sent('sendMessage').length, 0, 'one post, not two');
});

test('if Telegram refuses the photo, the wish is posted as text, and the error is kept', () => {
  const refuse = { ok: false, error_code: 400, description: 'Bad Request: not enough rights to send photos to the chat' };
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot' }, members, pages: shop,
                          tg: (method) => (method === 'sendPhoto' ? refuse : null) });
  assert.equal(gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member).ok, true);
  assert.match(gas.sent('sendMessage').at(-1).params.text, /Микрофон/);
  assert.equal(gas.properties.LAST_POST_ERROR, '');

  const silent = createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot' }, members, pages: shop,
                             tg: (method) => (/^send/.test(method) ? refuse : null) });
  assert.equal(silent.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member).ok, true, 'the wish is saved anyway');
  assert.match(silent.properties.LAST_POST_ERROR, /not enough rights/);
});

test('check() finds what is wrong and posts a test message', () => {
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', TOPIC_ID: '77', BOT_USERNAME: 'horovod_wishlist_bot' }, members, pages: shop,
                          tg: (method, params) => (method === 'getChat' ? { ok: true, result: { id: params.chat_id, title: 'HOROVOD', is_forum: true } } : null) });
  let report = gas.context.check();
  assert.ok(report.some((line) => /нет ни одного желания/.test(line)), report.join('\n'));
  assert.equal(gas.sent('sendMessage').at(-1).params.message_thread_id, 77);

  gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  report = gas.context.check();
  assert.ok(report.some((line) => line.includes('«Микрофон»')));
  assert.ok(report.some((line) => line.startsWith('✓ Тестовое сообщение')), report.join('\n'));
  assert.match(gas.sent('sendPhoto').at(-1).params.caption, /Проверка связи/);

  const moved = createGas({ props: { GROUP_CHAT_ID: '-555' }, members,
    tg: (method, params) => (method === 'getChat'
      ? (params.chat_id === '-555' ? { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100555 } }
                                   : { ok: true, result: { title: 'HOROVOD' } })
      : null) });
  report = moved.context.check();
  assert.equal(moved.properties.GROUP_CHAT_ID, '-100555', 'follows the group to its new address');
});
