import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { noisyPng, startApp, startShop } from './helpers.js';

const admin = { id: 1, first_name: 'Misha', username: 'misha' };
const member = { id: 2, first_name: 'Anna' };
const otherMember = { id: 3, first_name: 'Petr' };
const stranger = { id: 99, first_name: 'Eve' };

let ctx;
let shop;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

before(async () => {
  shop = await startShop({
    '/sm58': {
      body: `<meta property="og:title" content="Shure SM58"><meta property="og:image" content="/sm58.png">
             <meta property="product:price:amount" content="99"><meta property="product:price:currency" content="EUR">`,
    },
    '/sm58.png': { type: 'image/png', body: noisyPng() },
  });
  ctx = await startApp(
    { GROUP_CHAT_ID: '-100500' },
    { members: { 1: 'creator', 2: 'member', 3: 'member' } },
  );
  await ctx.app.bot.start();
});
after(async () => {
  await ctx.close();
  await shop.close();
});

test('requires valid Telegram data and group membership', async () => {
  const response = await fetch(`${ctx.base}/api/items`);
  assert.equal(response.status, 401);
  const denied = await ctx.as(stranger)('GET', '/api/items');
  assert.equal(denied.status, 403);
  const me = await ctx.as(member)('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { user: { id: 2, name: 'Anna', username: null }, isAdmin: false, currency: 'EUR' });
  assert.equal((await ctx.as(admin)('GET', '/api/me')).body.isAdmin, true);
});

test('a wish needs a photo or a link', async () => {
  const response = await ctx.as(member)('POST', '/api/items', { title: 'Cables' });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /фото или ссылку/);
});

test('uploading a photo and adding a wish with it', async () => {
  const upload = await ctx.as(member)('POST', '/api/uploads', noisyPng(), { 'Content-Type': 'image/png' });
  assert.equal(upload.status, 201);
  assert.match(upload.body.image, /^[a-f0-9]{32}\.png$/);

  const image = await fetch(ctx.base + upload.body.imageUrl);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const created = await ctx.as(member)('POST', '/api/items', {
    title: 'Acoustic panels',
    image: upload.body.image,
    imageSource: 'upload',
    category: 'hub',
    priority: 'must',
    price: '24,50',
    quantity: 6,
    note: 'For the back wall',
  });
  assert.equal(created.status, 201);
  const item = created.body.item;
  assert.equal(item.price, 24.5);
  assert.equal(item.quantity, 6);
  assert.equal(item.mine, true);
  assert.equal(item.planned, false);
  assert.equal(item.createdBy.name, 'Anna');

  await settle();
  const post = ctx.telegram.sent('sendPhoto').at(-1);
  assert.ok(post, 'posted to the group with the photo');
  assert.equal(post.params.chat_id, '-100500');
  assert.match(post.params.caption, /Anna<\/b> добавил\(а\) желание/);
  assert.match(post.params.caption, /Acoustic panels/);
});

test('rejects files that are not pictures', async () => {
  const response = await ctx.as(member)('POST', '/api/uploads', Buffer.from('<svg onload=alert(1)>'), {
    'Content-Type': 'image/svg+xml',
  });
  assert.equal(response.status, 415);
});

test('a link fills in the picture automatically', async () => {
  const preview = await ctx.as(member)('GET', `/api/preview?url=${encodeURIComponent(`${shop.base}/sm58`)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.title, 'Shure SM58');
  assert.equal(preview.body.price, 99);
  assert.ok(preview.body.imageUrl);

  // Saving straight away (without using the preview) also grabs the picture.
  const created = await ctx.as(member)('POST', '/api/items', { title: 'Mic', link: `${shop.base}/sm58`, category: 'tech' });
  assert.equal(created.status, 201);
  assert.match(created.body.item.imageUrl, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal(created.body.item.imageSource, 'link');
});

test('only admins plan and buy; the group hears about it', async () => {
  const created = await ctx.as(member)('POST', '/api/items', { title: 'Snare drum', link: 'https://shop.example/snare' });
  const id = created.body.item.id;

  const blocked = await ctx.as(member)('PATCH', `/api/items/${id}`, { planned: true });
  assert.equal(blocked.status, 403);

  const plan = await ctx.as(admin)('PATCH', `/api/items/${id}`, {
    planned: true,
    plannedDate: '2026-11-17',
    plannedPrecision: 'month',
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.item.plannedDate, '2026-11-01', 'month plans are stored as the 1st');
  await settle();
  const planned = ctx.telegram.sent('sendMessage').at(-1);
  assert.match(planned.params.text, /Планируем купить<\/b>: Snare drum/);
  assert.match(planned.params.text, /Ноябрь 2026/);
  assert.equal(planned.params.reply_markup.inline_keyboard[0][0].url, `https://t.me/horovod_test_bot?startapp=item_${id}`);

  const bought = await ctx.as(admin)('PATCH', `/api/items/${id}`, {
    status: 'bought',
    boughtPrice: '149.9',
    boughtAt: '2026-11-20',
  });
  assert.equal(bought.body.item.status, 'bought');
  assert.equal(bought.body.item.boughtPrice, 149.9);
  await settle();
  assert.match(ctx.telegram.sent('sendMessage').at(-1).params.text, /Куплено<\/b>: Snare drum\nОплачено: 149,90\s€/);

  const unplan = await ctx.as(admin)('PATCH', `/api/items/${id}`, { status: 'wanted' });
  assert.equal(unplan.body.item.boughtAt, null);
});

test('members edit and delete only their own wishes', async () => {
  const created = await ctx.as(member)('POST', '/api/items', { title: 'Strings', link: 'https://shop.example/strings' });
  const id = created.body.item.id;

  assert.equal((await ctx.as(otherMember)('PATCH', `/api/items/${id}`, { title: 'Mine now' })).status, 403);
  assert.equal((await ctx.as(otherMember)('DELETE', `/api/items/${id}`)).status, 403);

  const edited = await ctx.as(member)('PATCH', `/api/items/${id}`, { title: 'Guitar strings 10-46', link: '' });
  assert.equal(edited.status, 400, 'removing the link would leave neither photo nor link');

  const renamed = await ctx.as(member)('PATCH', `/api/items/${id}`, { title: 'Guitar strings 10-46' });
  assert.equal(renamed.body.item.title, 'Guitar strings 10-46');

  assert.equal((await ctx.as(member)('DELETE', `/api/items/${id}`)).status, 200);
  assert.equal((await ctx.as(member)('PATCH', `/api/items/${id}`, { title: 'x' })).status, 404);
});

test('voting toggles and shows who voted', async () => {
  const created = await ctx.as(member)('POST', '/api/items', { title: 'Keyboard stand', link: 'shop.example/stand' });
  const id = created.body.item.id;
  assert.equal(created.body.item.link, 'https://shop.example/stand');

  const first = await ctx.as(otherMember)('POST', `/api/items/${id}/vote`);
  assert.equal(first.body.item.votes, 1);
  assert.equal(first.body.item.voted, true);
  assert.deepEqual(first.body.item.voters, ['Petr']);

  const second = await ctx.as(admin)('POST', `/api/items/${id}/vote`);
  assert.equal(second.body.item.votes, 2);
  assert.equal(second.body.item.voted, true);

  const undone = await ctx.as(otherMember)('POST', `/api/items/${id}/vote`);
  assert.equal(undone.body.item.votes, 1);
  assert.equal(undone.body.item.voted, false);
});

test('validates input', async () => {
  const cases = [
    [{ title: '', link: 'https://shop.example/a' }, /Название: обязательное поле/],
    [{ title: 'x', link: 'javascript:alert(1)' }, /веб-ссылки/],
    [{ title: 'x', link: 'https://shop.example/a', category: 'boats' }, /категория/],
    [{ title: 'x', link: 'https://shop.example/a', price: 'lots' }, /Цена/],
    [{ title: 'x', link: 'https://shop.example/a', quantity: 0 }, /Количество/],
    [{ title: 'x', image: '../../etc/passwd' }, /Неизвестная картинка/],
    [{ title: 'x', image: `${'a'.repeat(32)}.png` }, /потерялось/],
  ];
  for (const [body, error] of cases) {
    const response = await ctx.as(admin)('POST', '/api/items', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(response.body.error, error);
  }
});

test('serves the app with a content security policy and blocks path tricks', async () => {
  const page = await fetch(`${ctx.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/telegram.org/);
  assert.match(await page.text(), /Horovod Wishlist/);
  assert.equal((await fetch(`${ctx.base}/lib/shared.js`)).status, 200);
  assert.equal((await fetch(`${ctx.base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/uploads/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/%E0%A4%A`)).status, 404);
});
