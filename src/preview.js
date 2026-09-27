import { safeFetch } from './safe-fetch.js';
import { saveImage } from './images.js';

// Shops usually hand their preview tags to link-preview bots; fall back to a normal browser.
const USER_AGENTS = [
  'TelegramBot (like TwitterBot)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
];
const BROWSER_UA = USER_AGENTS[1];
const MIN_IMAGE_BYTES = 1024; // skip tracking pixels and tiny icons

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function parseAttributes(tag) {
  const attrs = {};
  const inner = tag.replace(/^<[\w-]+/, '').replace(/\/?>$/, '');
  for (const match of inner.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const key = match[1].toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

const clean = (text, max) => (text ? decodeEntities(String(text)).replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** "1 299,90 €" → 1299.9, "1,299.00" → 1299, "1.299" → 1299 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;
  const decimals = digits.match(/[.,](\d{1,2})$/);
  const whole = (decimals ? digits.slice(0, -decimals[0].length) : digits).replace(/[.,]/g, '');
  const number = Number(`${whole || '0'}${decimals ? `.${decimals[1]}` : ''}`);
  return Number.isFinite(number) ? number : null;
}

function findProducts(node, found, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return found;
  if (Array.isArray(node)) {
    for (const child of node) findProducts(child, found, depth + 1);
    return found;
  }
  const types = [].concat(node['@type'] || []).map(String);
  if (types.some((type) => /^(Product|ProductGroup|IndividualProduct|ProductModel)$/i.test(type))) found.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') findProducts(value, found, depth + 1);
  }
  return found;
}

function ldImages(image) {
  return [].concat(image || []).map((entry) => (typeof entry === 'string' ? entry : entry?.url || entry?.contentUrl));
}

function ldOffer(offers) {
  for (const offer of [].concat(offers || [])) {
    if (!offer || typeof offer !== 'object') continue;
    const spec = [].concat(offer.priceSpecification || [])[0] || {};
    const price = parsePrice(offer.price ?? offer.lowPrice ?? spec.price);
    if (price != null) return { price, currency: offer.priceCurrency || spec.priceCurrency || null };
  }
  return null;
}

/** Pulls the title, picture candidates and price out of a product page. */
export function parseHtmlMeta(html, pageUrl) {
  const meta = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = attrs.content.trim();
  }

  const tagImages = [];
  for (const [tag] of html.matchAll(/<(?:link|img)\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag);
    if ((attrs.rel || '').toLowerCase().split(/\s+/).includes('image_src')) tagImages.push(attrs.href);
    else if ((attrs.itemprop || '').toLowerCase() === 'image') tagImages.push(attrs.href || attrs.src || attrs['data-src']);
  }

  const products = [];
  for (const [, json] of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      findProducts(JSON.parse(json.trim()), products);
    } catch {
      // Broken JSON-LD is common; ignore it.
    }
  }
  const product = products[0] || {};
  const offer = ldOffer(product.offers);

  const candidates = [
    meta['og:image:secure_url'],
    meta['og:image'],
    meta['og:image:url'],
    meta['twitter:image'],
    meta['twitter:image:src'],
    ...ldImages(product.image),
    ...tagImages,
  ];
  const images = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    try {
      const url = new URL(decodeEntities(candidate.trim()), pageUrl);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !images.includes(url.href)) images.push(url.href);
    } catch {
      // not a usable URL
    }
  }

  const metaPrice = parsePrice(meta['product:price:amount'] ?? meta['og:price:amount'] ?? meta.price);
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || product.name || titleTag, 200),
    description: clean(meta['og:description'] || meta.description || product.description, 500),
    siteName: clean(meta['og:site_name'], 100),
    images,
    price: offer?.price ?? metaPrice,
    currency:
      clean(
        offer?.currency || meta['product:price:currency'] || meta['og:price:currency'] || meta.pricecurrency,
        3,
      ).toUpperCase() || null,
  };
}

function decodeHtml(buffer, contentType = '') {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const charset =
    contentType.match(/charset=["']?([\w-]+)/i)?.[1] ||
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ||
    'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/** Downloads a picture and stores it in uploads/. Returns the stored file name or null. */
export async function downloadImage(url, { uploadsDir, allowPrivate = false, referer } = {}) {
  const response = await safeFetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', ...(referer ? { Referer: referer } : {}) },
    maxBytes: 10 * 1024 * 1024,
    allowPrivate,
  });
  if (response.status !== 200 || response.body.length < MIN_IMAGE_BYTES) return null;
  return saveImage(response.body, uploadsDir);
}

/**
 * Opens a link and returns { title, description, siteName, price, currency, image },
 * where `image` is a picture from the page already saved to uploads/ (or null).
 */
export async function fetchLinkPreview(link, { uploadsDir, allowPrivate = false }) {
  let page = null;
  let pageUrl = link;
  let lastError = null;

  for (const userAgent of USER_AGENTS) {
    try {
      const response = await safeFetch(link, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en,sk;q=0.8,cs;q=0.6',
        },
        maxBytes: 3 * 1024 * 1024,
        truncate: true,
        allowPrivate,
      });
      const contentType = String(response.headers['content-type'] || '');
      if (response.status >= 400) {
        lastError = new Error(`Магазин ответил ошибкой (${response.status})`);
        continue;
      }
      if (contentType.startsWith('image/')) {
        // The link itself is a picture.
        page = { title: '', description: '', siteName: '', images: [response.url], price: null, currency: null };
        break;
      }
      page = parseHtmlMeta(decodeHtml(response.body, contentType), response.url);
      pageUrl = response.url;
      if (page.images.length) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!page) throw lastError || new Error('Не удалось открыть ссылку');

  let image = null;
  for (const candidate of page.images.slice(0, 4)) {
    image = await downloadImage(candidate, { uploadsDir, allowPrivate, referer: pageUrl }).catch(() => null);
    if (image) break;
  }
  const { images, ...details } = page;
  return { ...details, image };
}
