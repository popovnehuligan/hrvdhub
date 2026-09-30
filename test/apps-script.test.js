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

// What GitHub Pages serves: the script updates itself from these.
const published = {
  'https://popovnehuligan.github.io/hrvdhub/setup/wishlist-script.txt': { body: fs.readFileSync('public/setup/wishlist-script.txt', 'utf8') },
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
  assert.match(posted.params.caption, /^🆕 <b>НОВОЕ ЖЕЛАНИЕ<\/b>\n\n<b>Микрофон<\/b>/);
  assert.match(posted.params.caption, /Добавил\(а\): Настя$/);
  assert.equal(created.data.posted, true, 'the app hears that the post went out');
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

  const card = gas.sent('sendMessage').at(-1).params; // the new-wish card (no picture in this shop)
  assert.match(card.text, /^🆕 <b>НОВОЕ ЖЕЛАНИЕ<\/b>/);

  const planned = gas.call('update', { id, patch: { planned: true, plannedDate: '2026-11-17', plannedPrecision: 'month' } }, admin);
  assert.equal(planned.data.item.plannedDate, '2026-11-01');
  assert.equal(planned.data.posted, true);
  const message = gas.sent('sendMessage').at(-1).params;
  assert.match(message.text, /^📅 <b>ПЛАНИРУЕМ КУПИТЬ<\/b>\n\n<b>Малый барабан<\/b>\nКогда: <b>.*Ноябрь 2026/);
  assert.match(message.text, /Запланировал\(а\): Миша$/);
  assert.equal(message.reply_markup.inline_keyboard[0][0].url, 'https://t.me/horovod_wishlist_bot?startapp=plan');

  const moved = gas.call('update', { id, patch: { planned: true, plannedDate: '2026-12-05', plannedPrecision: 'day' } }, admin);
  assert.equal(moved.data.posted, true);
  assert.match(gas.sent('sendMessage').at(-1).params.text, /^📅 <b>ПЕРЕНЕСЛИ ПОКУПКУ<\/b>[\s\S]*Перенёс\(ла\): Миша$/);
  assert.equal(gas.call('update', { id, patch: { note: 'Ludwig' } }, admin).data.posted, null, 'a plain edit posts nothing');

  const bought = gas.call('update', { id, patch: { status: 'bought', boughtPrice: '149,9', boughtAt: '2026-11-20' } }, admin);
  assert.equal(bought.data.item.boughtPrice, 149.9);
  assert.match(gas.sent('sendMessage').at(-1).params.text, /^✅ <b>КУПЛЕНО<\/b>\n\n<b>Малый барабан<\/b>\nОплачено: 149,90[\s\S]*Отметил\(а\): Миша$/);
});

test('planned and bought posts reply to the wish card without repeating the picture', () => {
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', TOPIC_ID: '77', BOT_USERNAME: 'horovod_wishlist_bot', BOT_HAS_MAIN_APP: 'yes' }, members, pages: shop,
                          tg: (method) => (/^send/.test(method) ? { ok: true, result: { message_id: 501 } } : null) });
  const id = gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member).data.item.id;
  assert.equal(gas.sent('sendPhoto').length, 1, 'the new wish is a picture card');
  gas.call('update', { id, patch: { planned: true, plannedDate: null, plannedPrecision: null } }, admin);
  assert.equal(gas.sent('sendPhoto').length, 1, 'the plan is not a second picture');
  const reply = gas.sent('sendMessage').at(-1).params;
  assert.equal(reply.reply_parameters.message_id, 501);
  assert.equal(reply.message_thread_id, 77);
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
    pages: { ...published, 'https://popovnehuligan.github.io/hrvdhub/brand/bot-avatar.jpg': { body: avatar, type: 'image/jpeg' } },
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
  assert.deepEqual(gas.triggers.map((t) => [t.handler, t.hour ?? t.everyHours]), [['dailyReminders', 10], ['autoUpdate', 1]]);
  assert.ok(report.some((line) => line.startsWith('✓ Автообновление')), report.join('\n'));
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
  assert.equal(gas.triggers.length, 2, 'running setup again does not double the triggers');
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
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot', LAST_POST_ERROR: '01.10 10:00 — old' }, members, pages: shop,
                          tg: (method) => (method === 'sendPhoto' ? refuse : null) });
  assert.equal(gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member).ok, true);
  assert.match(gas.sent('sendMessage').at(-1).params.text, /Микрофон/);
  assert.equal(gas.properties.LAST_POST_ERROR, '', 'a post that went through clears the old error');

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

test('every run switches to the code published on GitHub Pages', () => {
  const url = 'https://popovnehuligan.github.io/hrvdhub/setup/wishlist-script.txt';
  const latest = published[url].body.replace("alive: true,", "alive: 'latest',");
  const pages = { [url]: { body: latest } };
  const cache = new Map();
  const gas = createGas({ members, pages, cache });
  const status = JSON.parse(gas.context.doGet().text).data;
  assert.equal(status.alive, 'latest', 'the published code runs, not the pasted one');
  assert.match(status.version, /^[0-9a-f]{12}$/);

  // Claude publishes again and asks the script to pick it up; the next run uses it.
  pages[url] = { body: latest.replace("alive: 'latest',", "alive: 'newer',") };
  const refreshed = JSON.parse(gas.context.doPost({ postData: { contents: JSON.stringify({ action: 'refreshCode' }) } }).text);
  assert.equal(refreshed.ok, true, refreshed.error);
  assert.notEqual(refreshed.data.version, status.version);
  const next = createGas({ members, pages, cache });
  assert.equal(JSON.parse(next.context.doGet().text).data.alive, 'newer');
  assert.equal(JSON.parse(next.context.doGet().text).data.version, refreshed.data.version);

  // The app still works on the loaded code.
  next.context.PropertiesService.getScriptProperties().setProperty('GROUP_CHAT_ID', '-100555');
  assert.equal(next.call('list', {}, member).ok, true);

  // A broken download or something that isn't the wishlist never replaces the working code.
  for (const body of [latest.replace('function doPost(e) {', 'function doPost(e) {{'), '<html>404</html>']) {
    const safe = createGas({ members, pages: { [url]: { body } } });
    const data = JSON.parse(safe.context.doGet().text).data;
    assert.deepEqual([data.alive, data.version], [true, 'pasted']);
  }
  // No internet: the pasted copy keeps working.
  assert.equal(JSON.parse(createGas({ members }).context.doGet().text).data.version, 'pasted');
});

test('a post that did not go through is sent again later, once', () => {
  let down = true;
  const refuse = { ok: false, error_code: 502, description: 'Bad Gateway' };
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', TOPIC_ID: '77', BOT_USERNAME: 'horovod_wishlist_bot' }, members, pages: shop,
                          tg: (method) => (down && /^send/.test(method) ? refuse : null) });
  const created = gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  assert.equal(created.ok, true, created.error);
  assert.equal(JSON.parse(gas.context.doGet().text).data.status.posted, 0);

  down = false;
  assert.equal(gas.context.catchUpPosts(), 1);
  assert.match(gas.sent('sendPhoto').at(-1).params.caption, /Микрофон/);
  assert.equal(gas.sent('sendPhoto').at(-1).params.message_thread_id, '77');
  assert.equal(JSON.parse(gas.context.doGet().text).data.status.posted, 1);
  assert.equal(gas.context.catchUpPosts(), 0, 'not posted twice');

  gas.call('create', { wish: { title: 'Кабели', link: 'https://shop.example/cables' } }, member);
  assert.equal(gas.context.catchUpPosts(), 0, 'a wish posted right away is not posted again');
});

test('members of another group can come in once an admin adds the bot there', () => {
  const inGroup = { '-100555': { 1: 'creator', 2: 'member' }, '-100888': { 5: 'member', 7: 'administrator' }, '-100999': { 6: 'member', 7: 'creator' } };
  const updates = [
    { update_id: 10, my_chat_member: { chat: { id: -100888, type: 'supergroup', title: 'HOROVOD Команда' }, from: { id: 1 }, new_chat_member: { status: 'member' } } },
    { update_id: 11, my_chat_member: { chat: { id: -100999, type: 'group', title: 'Чужая группа' }, from: { id: 7 }, new_chat_member: { status: 'member' } } },
  ];
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'horovod_wishlist_bot' },
    tg: (method, params) => {
      if (method === 'getUpdates') return { ok: true, result: updates };
      if (method === 'getChatMember') {
        const status = (inGroup[String(params.chat_id)] || {})[params.user_id];
        return status ? { ok: true, result: { status } } : { ok: false, error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' };
      }
      return null;
    } });
  const five = { id: 5, first_name: 'Ира' };
  assert.equal(gas.call('list', {}, five).status, 403, 'not in the main group, not yet');
  assert.match(gas.properties.DENIED, /PARTICIPANT_ID_INVALID/);

  const groups = gas.context.learnGroups();
  assert.deepEqual(Array.from(groups, (g) => g.title), ['HOROVOD Команда'], 'only the group an admin of the main group added the bot to');
  assert.match(gas.sent('sendMessage').at(-1).params.text, /теперь могут открывать вишлист/);
  gas.cache.clear();
  const list = gas.call('list', {}, five);
  assert.equal(list.ok, true, list.error);
  assert.equal(list.data.me.isAdmin, false, 'admins of other groups are not wishlist admins');
  assert.equal(gas.call('list', {}, { id: 6, first_name: 'Чужой' }).status, 403);

  updates.push({ update_id: 12, my_chat_member: { chat: { id: -100888, type: 'supergroup', title: 'HOROVOD Команда' }, from: { id: 1 }, new_chat_member: { status: 'left' } } });
  assert.equal(gas.context.learnGroups().length, 0, 'bot removed: the group no longer counts');
  gas.cache.clear();
  assert.equal(gas.call('list', {}, five).status, 403);
});

test('someone the bot has never met is asked to press «Старт», and gets in right after', () => {
  let met = false;
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', BOT_USERNAME: 'hrvd_wishlist_bot' },
    tg: (method, params) => (method === 'getChatMember' && params.user_id === 8
      ? (met ? { ok: true, result: { status: 'member' } } : { ok: false, error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' })
      : null) });
  const newcomer = { id: 8, first_name: 'Даша' };
  const first = gas.call('list', {}, newcomer);
  assert.deepEqual([first.status, first.code, first.bot], [403, 'meet_bot', 'hrvd_wishlist_bot']);
  met = true; // pressed «Старт»
  assert.equal(gas.call('list', {}, newcomer).ok, true, 'not held back by a cached refusal');
  assert.equal(gas.call('list', {}, { id: 99, first_name: 'Eve' }).code, undefined, 'a real outsider just gets the members-only message');
});

test('opening the app reads the cached list, not the sheet; every change refreshes it', () => {
  const gas = world();
  const sheets = gas.context.SpreadsheetApp;
  const noSheet = { getActive() { throw new Error('the sheet was opened'); }, openById() { throw new Error('the sheet was opened'); } };
  const list = (user) => {
    gas.context.SpreadsheetApp = noSheet;
    try { return gas.call('list', {}, user); } finally { gas.context.SpreadsheetApp = sheets; }
  };
  const id = gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member).data.item.id;
  const first = list(member);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.data.items.map((w) => [w.id, w.mine, w.voted]), [[id, true, false]]);

  gas.call('vote', { id }, other);
  assert.deepEqual(list(other).data.items.map((w) => [w.votes, w.voted, w.mine]), [[1, true, false]], 'voted and mine are per person');
  assert.deepEqual(list(member).data.items.map((w) => [w.votes, w.voted, w.voters]), [[1, false, ['Богдан']]]);

  gas.call('update', { id, patch: { title: 'Shure SM58' } }, member);
  assert.equal(list(member).data.items[0].title, 'Shure SM58');
  const second = gas.call('create', { wish: { title: 'Стойка', link: 'https://shop.example/stand' } }, admin).data.item.id;
  gas.call('delete', { id }, member);
  assert.deepEqual(list(admin).data.items.map((w) => w.id), [second]);
  assert.equal(list(admin).data.items[0].postedAt, undefined, 'the group-post bookkeeping stays on the server');

  gas.context.SpreadsheetApp = noSheet;
  assert.equal(JSON.parse(gas.context.doGet().text).data.status.wishes, 1, 'nor does the health check');
  gas.context.SpreadsheetApp = sheets;
});

test('edits made by hand in the sheet reach the app: right away (onEdit) or within the hour', () => {
  const gas = world();
  gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  const rows = gas.sheets.get('wishes').rows;
  const retitle = (title) => { const wish = JSON.parse(rows[1][11]); wish.title = title; rows[1][11] = JSON.stringify(wish); };
  const title = () => gas.call('list', {}, member).data.items[0].title;

  retitle('Микрофон (руками)');
  assert.equal(title(), 'Микрофон', 'the cached list');
  gas.context.onEdit({ range: { getSheet: () => ({ getName: () => 'wishes' }) } });
  assert.equal(title(), 'Микрофон (руками)');

  retitle('Микрофон SM58');
  gas.context.onEdit({ range: { getSheet: () => ({ getName: () => 'Лист1' }) } });
  assert.equal(title(), 'Микрофон (руками)', 'edits in other sheets change nothing');
  gas.context.autoUpdate();
  assert.equal(title(), 'Микрофон SM58', 'the hourly run reads the sheet again');
});

test('the cached list stays true to the sheet: failed changes, busy moments, long lists', () => {
  const gas = world();
  gas.call('create', { wish: { title: 'Первое', link: 'https://shop.example/a' } }, member);

  // A change that fails halfway (the row is added, its update after posting is not) drops the cache.
  const sheet = gas.sheets.get('wishes');
  const getRange = sheet.getRange;
  sheet.getRange = (...args) => ({ ...getRange(...args), setValues() { throw new Error('Service Spreadsheets failed'); } });
  assert.equal(gas.call('create', { wish: { title: 'Второе', link: 'https://shop.example/b' } }, member).ok, false);
  sheet.getRange = getRange;
  assert.deepEqual(gas.call('list', {}, member).data.items.map((w) => w.title), ['Первое', 'Второе']);

  // While a change holds the lock, a read from the sheet is not kept: it could be older than the change.
  gas.context.forgetWishes();
  const locks = gas.context.LockService;
  gas.context.LockService = { getScriptLock: () => ({ tryLock: () => false, waitLock() {}, releaseLock() {} }) };
  assert.equal(gas.call('list', {}, member).data.items.length, 2);
  assert.equal(gas.cache.has('wishes0'), false);
  gas.context.LockService = locks;
  gas.call('list', {}, member);
  assert.equal(gas.cache.has('wishes0'), true);

  // Parts of two different saves are never glued together.
  gas.context.cacheWishes(Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, note: 'Заметка. '.repeat(300) })));
  assert.ok(gas.cache.has('wishes9'), 'a long list takes many parts');
  assert.equal(gas.context.cachedWishes().length, 100);
  gas.context.WISHLIST_VERSION = 'abcdef123456';
  assert.equal(gas.context.cachedWishes(), null, 'a list kept by another version of the script is read afresh');
  delete gas.context.WISHLIST_VERSION;
  assert.equal(gas.context.cachedWishes().length, 100);
  gas.cache.set('wishes9', gas.cache.get('wishes9').replace(/\/\w+:/, '/other:'));
  assert.equal(gas.context.cachedWishes(), null);
});

test('a request reads all the settings in one trip, and the published code in one trip', () => {
  const gas = world();
  gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  const properties = gas.context.PropertiesService;
  const trips = { one: 0, all: 0 };
  gas.context.PropertiesService = { getScriptProperties: () => {
    const p = properties.getScriptProperties();
    return { ...p, getProperty: (k) => (trips.one++, p.getProperty(k)), getProperties: () => (trips.all++, p.getProperties()) };
  } };
  gas.call('create', { wish: { title: 'Стойка', link: 'https://shop.example/sm58' } }, member);
  gas.call('list', {}, member);
  gas.context.doGet();
  assert.deepEqual(trips, { one: 0, all: 3 });

  const url = 'https://popovnehuligan.github.io/hrvdhub/setup/wishlist-script.txt';
  const cache = new Map();
  createGas({ members, pages: published, cache });
  const offline = createGas({ members, cache });
  assert.match(JSON.parse(offline.context.doGet().text).data.version, /^[0-9a-f]{12}$/, 'runs the cached code');
  let cacheTrips = 0;
  const service = offline.context.CacheService;
  offline.context.CacheService = { getScriptCache: () => {
    const c = service.getScriptCache();
    return { ...c, get: (k) => (cacheTrips++, c.get(k)), getAll: (k) => (cacheTrips++, c.getAll(k)) };
  } };
  assert.equal(offline.context.cachedCode().code, published[url].body);
  assert.equal(cacheTrips, 1);
});

test('cache entries are cut between characters, never inside an emoji', () => {
  // A store that keeps text as UTF-8, where half an emoji does not survive.
  class Utf8Cache extends Map { set(k, v) { return super.set(k, Buffer.from(String(v), 'utf8').toString('utf8')); } }
  const gas = createGas({ members, cache: new Utf8Cache() });
  assert.deepEqual(Array.from(gas.context.splitParts('a'.repeat(24999) + '🆕b'), (p) => p.length), [24999, 3]);
  for (let shift = 0; shift < 2; shift++) {
    const title = 'x'.repeat(24975 + shift) + '🎸'.repeat(5);
    gas.context.cacheWishes([{ id: 'w1', title }]);
    assert.equal(gas.context.cachedWishes()[0].title, title);
  }
});

test('admins can export the raw wishes for a move; members cannot', () => {
  const gas = createGas({ props: { GROUP_CHAT_ID: '-100555', TOPIC_ID: '77', BOT_USERNAME: 'b' }, members, pages: shop });
  gas.call('create', { wish: { title: 'Микрофон', link: 'https://shop.example/sm58' } }, member);
  assert.equal(gas.call('export', {}, member).status, 403);
  const out = gas.call('export', {}, admin);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.data.wishes[0].title, 'Микрофон');
  assert.equal(out.data.props.TOPIC_ID, '77');
});
