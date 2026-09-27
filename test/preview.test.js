import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { detectImageType } from '../src/images.js';
import { fetchLinkPreview, parseHtmlMeta, parsePrice } from '../src/preview.js';
import { isPrivateAddress, safeFetch } from '../src/safe-fetch.js';
import { noisyPng, startShop } from './helpers.js';

test('reads Open Graph tags', () => {
  const html = `<html><head>
    <title>Ignored title</title>
    <meta property="og:title" content="Fender Player II Stratocaster &amp; Case">
    <meta content="/images/strat.jpg" property="og:image" />
    <meta property="og:site_name" content="Music Shop">
    <meta property="product:price:amount" content="799.00">
    <meta property="product:price:currency" content="eur">
  </head></html>`;
  const meta = parseHtmlMeta(html, 'https://shop.example/guitars/strat?id=1');
  assert.equal(meta.title, 'Fender Player II Stratocaster & Case');
  assert.deepEqual(meta.images, ['https://shop.example/images/strat.jpg']);
  assert.equal(meta.siteName, 'Music Shop');
  assert.equal(meta.price, 799);
  assert.equal(meta.currency, 'EUR');
});

test('falls back to JSON-LD products and the <title>', () => {
  const html = `<title> Mixer | Shop </title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"BreadcrumbList"},
      {"@type":"Product","name":"Behringer X32","image":["//cdn.example/x32.png"],
       "offers":{"@type":"AggregateOffer","lowPrice":"2 199,90","priceCurrency":"EUR"}}]}
    </script>`;
  const meta = parseHtmlMeta(html, 'https://shop.example/x32');
  assert.equal(meta.title, 'Behringer X32', 'the product name beats the page title');
  assert.deepEqual(meta.images, ['https://cdn.example/x32.png']);
  assert.equal(meta.price, 2199.9);
  assert.equal(meta.currency, 'EUR');
});

test('parses prices written in different styles', () => {
  assert.equal(parsePrice('1 299,90 €'), 1299.9);
  assert.equal(parsePrice('1,299.00'), 1299);
  assert.equal(parsePrice('1.299'), 1299);
  assert.equal(parsePrice('49'), 49);
  assert.equal(parsePrice(12.5), 12.5);
  assert.equal(parsePrice('free'), null);
});

test('blocks private and local addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '2606:4700::1111', '1.1.1.1', '::ffff:1.1.1.1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('refuses to fetch localhost unless explicitly allowed', async () => {
  await assert.rejects(safeFetch('http://127.0.0.1:9/'), /private/);
  await assert.rejects(safeFetch('http://localhost:9/'), /private/);
  await assert.rejects(safeFetch('http://[::ffff:7f00:1]:9/'), /private/);
  await assert.rejects(safeFetch('file:///etc/passwd'), /http/);
});

let shop;
let uploadsDir;
before(async () => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishlist-preview-'));
  shop = await startShop({
    '/product': {
      body: `<meta property="og:title" content="Drum throne"><meta property="og:image" content="/missing.jpg">
             <meta name="twitter:image" content="/throne.png"><meta itemprop="price" content="89,90">`,
    },
    '/moved': { redirect: '/product' },
    '/throne.png': { type: 'image/png', body: noisyPng() },
    '/photo.png': { type: 'image/png', body: noisyPng() },
    '/no-image': { body: '<title>Plain page</title>' },
    '/broken': { status: 500, body: 'oops' },
  });
});
after(async () => {
  await shop.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('fetches a product page, follows redirects and saves the first working picture', async () => {
  const preview = await fetchLinkPreview(`${shop.base}/moved`, { uploadsDir, allowPrivate: true });
  assert.equal(preview.title, 'Drum throne');
  assert.equal(preview.price, 89.9);
  assert.ok(preview.image, 'image saved');
  assert.equal(detectImageType(fs.readFileSync(path.join(uploadsDir, preview.image))), 'png');
});

test('a link straight to a picture uses that picture', async () => {
  const preview = await fetchLinkPreview(`${shop.base}/photo.png`, { uploadsDir, allowPrivate: true });
  assert.match(preview.image, /\.png$/);
});

test('pages without a picture still give a title', async () => {
  const preview = await fetchLinkPreview(`${shop.base}/no-image`, { uploadsDir, allowPrivate: true });
  assert.equal(preview.title, 'Plain page');
  assert.equal(preview.image, null);
});

test('shop errors are reported', async () => {
  await assert.rejects(fetchLinkPreview(`${shop.base}/broken`, { uploadsDir, allowPrivate: true }), /500/);
});
