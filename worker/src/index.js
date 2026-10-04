/**
 * HOROVOD · Вишлист — the backend on Cloudflare Workers (it replaced the Google Apps Script one,
 * which took up to 20 s to wake up). Same protocol as before, so the app only changed its address:
 *   POST /            { action, payload, initData } → { ok: true, data } | { ok: false, error, status, code? }
 *   GET  /            health check: version and a status without names or ids
 *   GET  /photo/<id>  a photo (?w≤600 gives the small copy when there is one)
 * Hourly (cron): posts that didn't go through, groups the bot was added to, the morning reminder.
 *
 * Storage: D1 (env.DB) — wishes (one JSON per wish), votes (one row per heart, so two people voting
 * at once never lose a vote), props (settings), rids (retried saves). Photos: KV (env.PHOTOS).
 * Secret: BOT_TOKEN. Vars: PUBLIC_URL, VERSION.
 */
import {
  CATEGORIES,
  PRIORITIES,
  WishError,
  applyWishPatch,
  canEditWish,
  cleanWishInput,
  describePlan,
  findOption,
  formatMoney,
  isDue,
  itemTotal,
  newWish,
  newWishId,
  normalizeLink,
  publicWish,
  sumTotals,
  todayIn,
  userRef,
} from '../../public/lib/shared.js';

const TIME_ZONE = 'Europe/Bratislava';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const USER_AGENTS = [
  'TelegramBot (like TwitterBot)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET' && url.pathname.startsWith('/photo/')) return servePhoto(request, env, ctx, url);
    if (request.method === 'GET' && url.pathname === '/') return respond(() => health(app(env, url.origin)));
    if (request.method === 'POST' && url.pathname === '/') {
      return respond(async () => {
        let body;
        try {
          body = JSON.parse(await request.text());
        } catch {
          throw new WishError('Неверный запрос');
        }
        const a = app(env, url.origin);
        const user = await auth(a, body.initData);
        return handle(a, String(body.action || ''), body.payload || {}, user);
      });
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourly(app(env, env.PUBLIC_URL)));
  },
};

/** One request's (or cron run's) view of the world: settings are read once and kept here. */
function app(env, origin) {
  return { env, origin: origin || env.PUBLIC_URL, props: null };
}

async function respond(fn) {
  let out;
  try {
    out = { ok: true, data: await fn() };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err), status: (err && err.status) || 400 };
    if (err && err.code) Object.assign(out, { code: err.code, bot: err.bot });
    if (!(err instanceof WishError)) console.error(err && err.stack ? err.stack : err);
  }
  return new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

const fail = (message, status = 400) => {
  throw new WishError(message, status);
};

/* ---------------- settings (D1 table props) ---------------- */

// Settings rarely change; each isolate keeps them for a minute and updates its copy when it writes.
let propsCache = null;
let propsAt = 0;

async function loadProps(a) {
  if (a.props) return a.props;
  if (propsCache && Date.now() - propsAt < 60000) return (a.props = propsCache);
  const { results } = await a.env.DB.prepare('SELECT key, value FROM props').all();
  propsCache = Object.fromEntries(results.map((row) => [row.key, row.value]));
  propsAt = Date.now();
  return (a.props = propsCache);
}

const prop = (a, key) => (a.props && a.props[key]) || '';

async function setProp(a, key, value) {
  await a.env.DB.prepare('INSERT INTO props (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value))
    .run();
  if (a.props) a.props[key] = String(value);
}

const ids = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
const currency = (a) => String(prop(a, 'CURRENCY') || 'EUR').toUpperCase();
const today = () => todayIn(TIME_ZONE);

/* ---------------- wishes (D1 tables wishes, votes) ---------------- */

function withVotes(rows, votes) {
  const byWish = new Map();
  for (const v of votes) {
    if (!byWish.has(v.wish_id)) byWish.set(v.wish_id, []);
    byWish.get(v.wish_id).push({ id: v.user_id, name: v.name });
  }
  return rows
    .map((row) => {
      try {
        return { ...JSON.parse(row.data), votes: byWish.get(row.id) || [] };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readWishes(a) {
  const [wishes, votes] = await a.env.DB.batch([
    a.env.DB.prepare('SELECT id, data FROM wishes ORDER BY rowid'),
    a.env.DB.prepare('SELECT wish_id, user_id, name FROM votes ORDER BY at, rowid'),
  ]);
  return withVotes(wishes.results, votes.results);
}

async function findWish(a, id) {
  if (!id) return null;
  const [wishes, votes] = await a.env.DB.batch([
    a.env.DB.prepare('SELECT id, data FROM wishes WHERE id = ?1').bind(String(id)),
    a.env.DB.prepare('SELECT wish_id, user_id, name FROM votes WHERE wish_id = ?1 ORDER BY at, rowid').bind(String(id)),
  ]);
  return withVotes(wishes.results, votes.results)[0] || null;
}

/** Saves everything but the votes (they have their own table). */
async function saveWish(a, wish) {
  const { votes, ...data } = wish;
  await a.env.DB.prepare(
    'INSERT INTO wishes (id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
  )
    .bind(wish.id, JSON.stringify(data), wish.createdAt || new Date().toISOString())
    .run();
}

async function removeWish(a, id) {
  await a.env.DB.batch([
    a.env.DB.prepare('DELETE FROM votes WHERE wish_id = ?1').bind(id),
    a.env.DB.prepare('DELETE FROM wishes WHERE id = ?1').bind(id),
  ]);
}

async function toggleVote(a, wish, user) {
  const me = userRef(user);
  const had = wish.votes.some((v) => Number(v.id) === Number(user.id));
  await (had
    ? a.env.DB.prepare('DELETE FROM votes WHERE wish_id = ?1 AND user_id = ?2').bind(wish.id, user.id)
    : a.env.DB.prepare('INSERT OR IGNORE INTO votes (wish_id, user_id, name, at) VALUES (?1, ?2, ?3, ?4)').bind(
        wish.id,
        user.id,
        me.name,
        new Date().toISOString(),
      )
  ).run();
  return findWish(a, wish.id);
}

/* ---------------- access ---------------- */

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof message === 'string' ? new TextEncoder().encode(message) : message));
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Checks Telegram's signature on initData. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
async function auth(a, initData) {
  const token = a.env.BOT_TOKEN;
  if (!token) fail('Вишлист ещё не настроен: нет ключа бота', 503);
  if (!initData) fail('Откройте вишлист через Telegram', 401);
  const fields = {};
  let hash = '';
  for (const part of String(initData).split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
    const value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (key === 'hash') hash = value;
    else fields[key] = value;
  }
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), token);
  if (hex(await hmac(secret, check)) !== String(hash).toLowerCase()) fail('Подпись Telegram не сошлась. Откройте вишлист заново', 401);
  const authAt = Number(fields.auth_date) * 1000;
  if (!Number.isFinite(authAt) || authAt < Date.now() - 24 * 3600 * 1000) fail('Сессия устарела, откройте вишлист заново', 401);

  const user = JSON.parse(fields.user || '{}');
  if (!user.id) fail('Откройте вишлист через Telegram', 401);
  await loadProps(a);
  const rights = await access(a, user.id);
  if (!rights.allowed && rights.unknown) {
    const meet = new WishError('Бот вас ещё не знает, поэтому не может проверить, что вы в группе HOROVOD.', 403);
    meet.code = 'meet_bot';
    meet.bot = prop(a, 'BOT_USERNAME');
    throw meet;
  }
  if (!rights.allowed) fail(`Этот вишлист только для участников HOROVOD (ваш id ${user.id})`, 403);
  user.isAdmin = rights.admin;
  return user;
}

const accessGroups = (a) => {
  try {
    return JSON.parse(prop(a, 'ACCESS_GROUPS') || '[]');
  } catch {
    return [];
  }
};

// Membership answers, kept by each isolate: 10 minutes for members, 1 minute for refusals.
const accessCache = new Map();

/** Group members may use the app; the main group's admins and ADMIN_IDS are admins. */
async function access(a, userId) {
  const id = String(userId);
  const cached = accessCache.get(id);
  if (cached && cached.until > Date.now()) return cached.result;
  if (ids(prop(a, 'ADMIN_IDS')).includes(id)) return { allowed: true, admin: true };

  let result = { allowed: false, admin: false };
  let member = null;
  const group = prop(a, 'GROUP_CHAT_ID');
  if (!group) fail('Вишлист ещё не настроен: не задана группа', 503);
  // The main group first (its admins are the app's admins), then the other groups admins added the bot to.
  const groups = [group, ...accessGroups(a).map((g) => g.id)];
  for (let i = 0; i < groups.length && !result.allowed; i++) {
    member = await tgTry(a, 'getChatMember', { chat_id: groups[i], user_id: Number(id) });
    if (member.ok) {
      const status = member.result.status;
      const inGroup = ['creator', 'administrator', 'member'].includes(status) || (status === 'restricted' && member.result.is_member);
      if (inGroup) result = { allowed: true, admin: i === 0 && (status === 'creator' || status === 'administrator') };
    } else if (member.error_code === 400 && /PARTICIPANT_ID_INVALID|user not found/i.test(member.description || '')) {
      // Telegram lets a bot check only people it has met: pressing «Старт» in the bot's chat is enough.
      result.unknown = true;
    } else if (member.error_code !== 400) {
      fail('Не удалось проверить участие через Telegram. Попробуйте чуть позже', 503);
    }
  }
  if (result.allowed) delete result.unknown;
  else {
    // For check-ups from outside (GET /): how many were turned away and why, never who.
    let denied = { count: 0 };
    try {
      denied = JSON.parse(prop(a, 'DENIED') || '{"count":0}');
    } catch {
      // start over
    }
    denied.count += 1;
    denied.last = new Date().toISOString();
    denied.reason = member ? (member.ok ? `status ${member.result.status}` : String(member.description || member.error_code)) : 'no group';
    await setProp(a, 'DENIED', JSON.stringify(denied));
  }
  if (!result.unknown) accessCache.set(id, { result, until: Date.now() + (result.allowed ? 600000 : 60000) });
  return result;
}

/* ---------------- actions ---------------- */

async function handle(a, action, p, user) {
  const ctx = { userId: user.id, isAdmin: user.isAdmin };
  const view = (wish) => publicWish(wish, user.id, (ref) => imageUrl(a, ref));

  if (action === 'list') {
    if (p.client && typeof p.client === 'object') await noteClient(a, p.client);
    return { me: { user: userRef(user), isAdmin: user.isAdmin, currency: currency(a) }, items: (await readWishes(a)).map(view) };
  }
  if (action === 'preview') return preview(a, p.url);
  if (action === 'upload') return upload(a, p.photo, p.thumb);
  if (action === 'export') {
    if (!user.isAdmin) fail('Только для админов', 403);
    return { wishes: await readWishes(a) };
  }

  if (action === 'create') {
    // The app retries when an answer gets lost; the same request id must not add a wish twice.
    const rid = p.rid ? String(p.rid).slice(0, 64) : null;
    if (rid) {
      const done = await a.env.DB.prepare('SELECT wish_id FROM rids WHERE rid = ?1').bind(rid).first();
      if (done) {
        const wish = await findWish(a, done.wish_id);
        return { item: wish ? view(wish) : null };
      }
    }
    const patch = checkImageRef(cleanWishInput(p.wish || {}, { isAdmin: ctx.isAdmin, isNew: true, today: today() }));
    const wish = { ...newWish(patch, { user, currency: currency(a) }), votes: [] };
    if (!wish.link && !wish.image) fail('Добавьте фото или ссылку');
    if (wish.link && !wish.image) await attachLinkImage(a, wish);
    await saveWish(a, wish);
    if (rid) {
      await a.env.DB.prepare('INSERT OR IGNORE INTO rids (rid, wish_id, at) VALUES (?1, ?2, ?3)')
        .bind(rid, wish.id, new Date().toISOString())
        .run();
    }
    const sent = await announce(a, wish);
    return { item: view(wish), posted: Boolean(sent && sent.ok) };
  }

  if (!['vote', 'update', 'delete'].includes(action)) fail('Неизвестное действие');
  const current = await findWish(a, p.id);
  if (!current) fail('Этого желания больше нет', 404);

  if (action === 'vote') return { item: view(await toggleVote(a, current, user)) };

  if (action === 'update') {
    if (!canEditWish(current, ctx)) fail('Можно менять только свои желания', 403);
    const changes = checkImageRef(cleanWishInput(p.patch || {}, { isAdmin: ctx.isAdmin, isNew: false, today: today() }));
    const result = applyWishPatch(current, changes);
    const next = result.wish;
    if (next.link && !next.image && next.link !== current.link) await attachLinkImage(a, next);
    await saveWish(a, next);
    const kind = result.becameBought ? 'bought' : result.becamePlanned ? 'planned' : result.planMoved ? 'moved' : null;
    const sent = kind ? await notify(a, kind, next, user) : null;
    await correctCard(a, current, next);
    return { item: view(next), posted: sent ? Boolean(sent.ok) : null };
  }

  if (!canEditWish(current, ctx)) fail('Можно удалять только свои желания', 403);
  await removeWish(a, current.id);
  return { ok: true };
}

/** Pictures are uploaded separately (upload); a wish only ever points at them. */
function checkImageRef(patch) {
  if (patch.image && /^data:/.test(patch.image)) fail('Сначала загрузите фото');
  return patch;
}

/** 'photo:ID' → this server; 'drive:ID' → the old Google Drive photos; anything else is an address already. */
function imageUrl(a, ref) {
  const photo = /^photo:([\w-]+)$/.exec(ref || '');
  if (photo) return `${a.origin}/photo/${photo[1]}`;
  const drive = /^drive:(.+)$/.exec(ref || '');
  return drive ? `https://lh3.googleusercontent.com/d/${drive[1]}=w1000` : ref;
}

/** The last 12 screens the app was opened on (sizes and platform only), shown by GET /. */
async function noteClient(a, client) {
  try {
    const clean = {};
    for (const [k, v] of Object.entries(client).slice(0, 16)) {
      if (['number', 'boolean'].includes(typeof v) || v === null) clean[k] = v;
      else if (typeof v === 'string') clean[k] = v.slice(0, 160);
    }
    clean.at = new Date().toISOString();
    let list = [];
    try {
      list = JSON.parse(prop(a, 'CLIENTS') || '[]');
    } catch {
      // start over
    }
    await setProp(a, 'CLIENTS', JSON.stringify([clean, ...list].slice(0, 12)));
  } catch {
    // never stands in the way of opening the app
  }
}

async function health(a) {
  await loadProps(a);
  const wishes = await readWishes(a);
  let denied = { count: 0 };
  try {
    denied = JSON.parse(prop(a, 'DENIED') || '{"count":0}');
  } catch {
    // keep zero
  }
  return {
    alive: true,
    version: a.env.VERSION || 'dev',
    ts: new Date().toISOString(),
    status: {
      group: Boolean(prop(a, 'GROUP_CHAT_ID')),
      topic: Boolean(prop(a, 'TOPIC_ID')),
      wishes: wishes.length,
      posted: wishes.filter((w) => w.postedAt).length,
      newestWish: wishes.map((w) => w.createdAt || '').sort().pop() || null,
      lastPostError: prop(a, 'LAST_POST_ERROR') || null,
      extraAdmins: ids(prop(a, 'ADMIN_IDS')).length,
      accessGroups: accessGroups(a).length,
      denied,
    },
    clients: (() => {
      try {
        return JSON.parse(prop(a, 'CLIENTS') || '[]');
      } catch {
        return [];
      }
    })(),
  };
}

/* ---------------- photos (KV) ---------------- */

const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** The picture format from its first bytes. SVG is never accepted. */
function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

function decodeDataUrl(value) {
  const match = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(String(value || ''));
  if (!match) return null;
  try {
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function savePhoto(a, bytes, thumb) {
  const type = detectImageType(bytes);
  if (!type) fail('Нужна картинка JPG, PNG, WebP или GIF', 415);
  if (bytes.length > MAX_PHOTO_BYTES) fail('Файл слишком большой', 413);
  const id = newWishId();
  await a.env.PHOTOS.put(`photo:${id}`, bytes, { metadata: { type: IMAGE_TYPES[type] } });
  const thumbType = thumb && detectImageType(thumb);
  if (thumbType && thumb.length < bytes.length) {
    await a.env.PHOTOS.put(`thumb:${id}`, thumb, { metadata: { type: IMAGE_TYPES[thumbType] } });
  }
  return `photo:${id}`;
}

/** photo — "data:image/jpeg;base64,…", already made smaller by the app; thumb — a ~480px copy for the cards. */
async function upload(a, photo, thumb) {
  const bytes = decodeDataUrl(photo);
  if (!bytes) fail('Нужна картинка JPG, PNG, WebP или GIF', 415);
  const image = await savePhoto(a, bytes, decodeDataUrl(thumb));
  return { image, imageUrl: imageUrl(a, image) };
}

async function servePhoto(request, env, ctx, url) {
  const id = url.pathname.slice('/photo/'.length);
  if (!/^[\w-]{6,64}$/.test(id)) return new Response('Not found', { status: 404, headers: CORS });
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const small = Number(url.searchParams.get('w')) > 0 && Number(url.searchParams.get('w')) <= 600;
  let found = small ? await env.PHOTOS.getWithMetadata(`thumb:${id}`, 'arrayBuffer') : null;
  if (!found || !found.value) found = await env.PHOTOS.getWithMetadata(`photo:${id}`, 'arrayBuffer');
  if (!found || !found.value) return new Response('Not found', { status: 404, headers: CORS });
  const response = new Response(found.value, {
    headers: {
      'Content-Type': (found.metadata && found.metadata.type) || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...CORS,
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function photoBlob(a, ref) {
  const id = (/^photo:([\w-]+)$/.exec(ref || '') || [])[1];
  if (!id) return null;
  const found = await a.env.PHOTOS.getWithMetadata(`photo:${id}`, 'arrayBuffer');
  if (!found || !found.value) return null;
  return new Blob([found.value], { type: (found.metadata && found.metadata.type) || 'image/jpeg' });
}

/* ---------------- link previews ---------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] || match;
  });
}

function parseAttributes(tag) {
  const attrs = {};
  const inner = tag.replace(/^<[\w-]+/, '').replace(/\/?>$/, '');
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const key = m[1].toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** "1 299,90 €" → 1299.9, "1,299.00" → 1299, "1.299" → 1299 */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;
  const decimals = digits.match(/[.,](\d{1,2})$/);
  const whole = (decimals ? digits.slice(0, -decimals[0].length) : digits).replace(/[.,]/g, '');
  const number = Number((whole || '0') + (decimals ? `.${decimals[1]}` : ''));
  return Number.isFinite(number) ? number : null;
}

function resolveUrl(base, ref) {
  try {
    const url = new URL(String(ref || '').trim(), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function findProducts(node, found, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return found;
  if (Array.isArray(node)) {
    node.forEach((child) => findProducts(child, found, depth + 1));
    return found;
  }
  const types = [].concat(node['@type'] || []).map(String);
  if (types.some((t) => /^(Product|ProductGroup|IndividualProduct|ProductModel)$/i.test(t))) found.push(node);
  for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') findProducts(node[k], found, depth + 1);
  return found;
}

/** Pulls the title, picture candidates and price out of a product page. */
export function parseHtmlMeta(html, pageUrl) {
  const meta = {};
  let m;
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const attr = parseAttributes(m[0]);
    const key = (attr.property || attr.name || attr.itemprop || '').toLowerCase();
    if (key && attr.content && !(key in meta)) meta[key] = attr.content.trim();
  }
  const tagImages = [];
  const tagRe = /<(?:link|img)\b[^>]*>/gi;
  while ((m = tagRe.exec(html))) {
    const t = parseAttributes(m[0]);
    if ((t.rel || '').toLowerCase().split(/\s+/).includes('image_src')) tagImages.push(t.href);
    else if ((t.itemprop || '').toLowerCase() === 'image') tagImages.push(t.href || t.src || t['data-src']);
  }
  const products = [];
  const ldRe = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) {
    try {
      findProducts(JSON.parse(m[1].trim()), products, 0);
    } catch {
      // broken JSON-LD is common
    }
  }
  const product = products[0] || {};
  let offer = null;
  for (const o of [].concat(product.offers || [])) {
    if (!o || typeof o !== 'object') continue;
    const spec = [].concat(o.priceSpecification || [])[0] || {};
    const price = parsePrice(o.price ?? o.lowPrice ?? spec.price);
    if (price == null) continue;
    offer = { price, currency: o.priceCurrency || spec.priceCurrency || null };
    break;
  }
  const candidates = [meta['og:image:secure_url'], meta['og:image'], meta['og:image:url'], meta['twitter:image'], meta['twitter:image:src']]
    .concat([].concat(product.image || []).map((x) => (typeof x === 'string' ? x : x && (x.url || x.contentUrl))))
    .concat(tagImages);
  const images = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    const url = resolveUrl(pageUrl, decodeEntities(c));
    if (url && !images.includes(url)) images.push(url);
  }
  const clean = (v, max) => (v ? decodeEntities(String(v)).replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const titleTag = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  const metaPrice = parsePrice(meta['product:price:amount'] || meta['og:price:amount'] || meta.price);
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || product.name || titleTag, 200),
    siteName: clean(meta['og:site_name'], 100),
    images,
    price: offer ? offer.price : metaPrice,
    currency: clean((offer && offer.currency) || meta['product:price:currency'] || meta['og:price:currency'] || meta.pricecurrency, 3).toUpperCase() || null,
  };
}

function fetchUrl(url, userAgent, referer) {
  const headers = { 'User-Agent': userAgent, 'Accept-Language': 'en,sk;q=0.8,cs;q=0.6' };
  if (referer) headers.Referer = referer;
  return fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(8000) });
}

/** Downloads a picture and keeps it as one of our photos. Returns 'photo:ID' or null. */
async function downloadImage(a, url, referer) {
  try {
    const response = await fetchUrl(url, USER_AGENTS[1], referer);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1024 || bytes.length > MAX_PHOTO_BYTES || !detectImageType(bytes)) return null;
    return await savePhoto(a, bytes, null);
  } catch {
    return null;
  }
}

/** Opens a shop link: { title, siteName, price, currency, image } with the picture already saved. */
async function linkPreview(a, link) {
  let page = null;
  let lastError = null;
  for (const agent of USER_AGENTS) {
    try {
      const response = await fetchUrl(link, agent);
      if (response.status >= 400) {
        lastError = `Магазин ответил ошибкой (${response.status})`;
        continue;
      }
      const type = response.headers.get('content-type') || '';
      if (type.startsWith('image/')) {
        page = { title: '', siteName: '', images: [link], price: null, currency: null };
        break;
      }
      page = parseHtmlMeta(await response.text(), response.url || link);
      if (page.images.length) break;
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!page) throw new Error(lastError || 'Не удалось открыть ссылку');
  let image = null;
  for (let j = 0; j < Math.min(page.images.length, 4) && !image; j++) image = await downloadImage(a, page.images[j], link);
  return { title: page.title, siteName: page.siteName, price: page.price, currency: page.currency, image };
}

async function preview(a, url) {
  const link = normalizeLink(url || '');
  if (!link) fail('Сначала вставьте ссылку');
  try {
    const p = await linkPreview(a, link);
    return { title: p.title, siteName: p.siteName, price: p.price, currency: p.currency, link, image: p.image, imageUrl: p.image ? imageUrl(a, p.image) : null };
  } catch {
    fail('Не получилось открыть ссылку. Её всё равно можно сохранить или добавить фото вручную', 422);
  }
}

/** "If a link is added it should add an image there." */
async function attachLinkImage(a, wish) {
  try {
    const { image } = await linkPreview(a, wish.link);
    if (image) Object.assign(wish, { image, imageSource: 'link' });
  } catch {
    // the link alone is enough
  }
}

/* ---------------- Telegram ---------------- */

async function tgTry(a, method, payload) {
  const files = Object.keys(payload).some((k) => payload[k] instanceof Blob);
  let init;
  if (files) {
    const form = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (v == null) continue;
      if (v instanceof Blob) form.append(k, v, 'photo.jpg');
      else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    init = { method: 'POST', body: form };
  } else {
    init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${a.env.BOT_TOKEN}/${method}`, { ...init, signal: AbortSignal.timeout(15000) });
    try {
      return await response.json();
    } catch {
      return { ok: false, error_code: response.status };
    }
  } catch (error) {
    return { ok: false, description: error.message };
  }
}

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shorten = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Where the buttons in group posts lead: straight to the wish when the bot has its Main Mini App. */
function appLink(a, startParam) {
  if (prop(a, 'APP_LINK')) return `${prop(a, 'APP_LINK')}?startapp=${encodeURIComponent(startParam)}`;
  if (!prop(a, 'BOT_USERNAME')) return null;
  const chat = `https://t.me/${prop(a, 'BOT_USERNAME')}`;
  return prop(a, 'BOT_HAS_MAIN_APP') === 'yes' ? `${chat}?startapp=${encodeURIComponent(startParam)}` : chat;
}

function openButton(a, startParam, label) {
  const link = appLink(a, startParam);
  if (!link) return undefined;
  const direct = prop(a, 'APP_LINK') || prop(a, 'BOT_HAS_MAIN_APP') === 'yes';
  return { inline_keyboard: [[{ text: direct ? label : 'Открыть вишлист', url: link }]] };
}

function priceText(wish) {
  const total = itemTotal(wish);
  if (total == null) return '';
  return wish.quantity > 1
    ? `${formatMoney(total, wish.currency)} (${wish.quantity} × ${formatMoney(wish.price, wish.currency)})`
    : formatMoney(total, wish.currency);
}

function planText(wish) {
  const plan = describePlan(wish, today());
  if (!plan) return '';
  if (plan.tone === 'nodate') return 'дата пока не выбрана';
  return `${plan.label.toLowerCase()} (${plan.detail})`;
}

const notifyChat = (a) => prop(a, 'NOTIFY_CHAT_ID') || prop(a, 'GROUP_CHAT_ID');

/** Where posts go: the chat, plus the topic when the group has topics. */
function target(a, chat) {
  const params = { chat_id: chat };
  if (prop(a, 'TOPIC_ID') && !prop(a, 'NOTIFY_CHAT_ID')) params.message_thread_id = Number(prop(a, 'TOPIC_ID'));
  return params;
}

/** Sends to the topic; if the topic is gone, to the group's main chat, so nothing gets lost. */
async function sendTo(a, method, params) {
  let result = await tgTry(a, method, params);
  if (!result.ok && params.message_thread_id && /thread|topic/i.test(result.description || '')) {
    const { message_thread_id: _, ...plain } = params;
    result = await tgTry(a, method, plain);
  }
  return result;
}

/**
 * Posts to the group. A new wish comes as a picture card; planned, moved and bought come as short
 * text replies to that card. Never breaks the save: without the picture it tries plain text, and a
 * failure is kept in LAST_POST_ERROR for check-ups.
 */
async function post(a, wish, text, options = {}) {
  await loadProps(a);
  const chat = notifyChat(a);
  if (!chat) return { ok: false, description: 'группа не задана (GROUP_CHAT_ID)' };
  const params = { ...target(a, chat), parse_mode: 'HTML' };
  const button = options.compact ? null : openButton(a, `item_${wish.id}`, options.button || 'Открыть в вишлисте');
  if (button) params.reply_markup = button;
  if (options.reply && wish.postMessageId) {
    params.reply_parameters = { message_id: Number(wish.postMessageId), allow_sending_without_reply: true };
  }
  let result = null;
  if (!options.compact && !params.reply_parameters && wish.image) {
    // A reply points at the card with the picture already; the picture again would only repeat it.
    let photo = await photoBlob(a, wish.image);
    if (!photo && /^(drive:|https:\/\/)/.test(wish.image)) photo = imageUrl(a, wish.image);
    if (photo) {
      result = await sendTo(a, 'sendPhoto', { ...params, photo, caption: shorten(text, 1000) });
      if (result.ok) result.via = 'photo';
    }
  }
  if (!result || !result.ok) {
    result = await sendTo(a, 'sendMessage', { ...params, text, link_preview_options: { is_disabled: true } });
    if (result.ok) result.via = 'text';
  }
  if (result.ok) {
    if (prop(a, 'LAST_POST_ERROR')) await setProp(a, 'LAST_POST_ERROR', '');
  } else {
    const when = new Intl.DateTimeFormat('ru-RU', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
    await setProp(a, 'LAST_POST_ERROR', `${when} — ${result.description || result.error_code}`);
  }
  return result;
}

/**
 * The group's posts. Each kind opens with its own marker line in capitals, so they are told apart
 * at a glance: 🆕 new wish (a picture card), 📅 planned or moved, ✅ bought (replies to the card).
 */
/** The text of a new wish's card in the group; also used to correct the card after an edit. */
function cardText(wish) {
  const category = findOption(CATEGORIES, wish.category);
  const priority = findOption(PRIORITIES, wish.priority);
  const lines = ['🆕 <b>НОВОЕ ЖЕЛАНИЕ</b>', '', `<b>${escapeHtml(wish.title)}</b>`, `${category.label} · ${priority.label}`];
  if (priceText(wish)) lines.push(`Цена: ${priceText(wish)}`);
  if (wish.note) lines.push('', `<i>${escapeHtml(shorten(wish.note, 300))}</i>`);
  if (wish.planned) lines.push('', `📅 В плане: ${planText(wish)}`);
  lines.push('', `Добавил(а): ${escapeHtml(wish.createdBy.name)}`);
  return lines.join('\n');
}

const CARD_FIELDS = ['title', 'price', 'quantity', 'currency', 'note', 'category', 'priority'];

/**
 * The wish's card in the group was posted with what the wish said then. After an edit of its title,
 * price or note the card is corrected in place, so the group never keeps a wrong price.
 */
async function correctCard(a, before, wish) {
  if (!wish.postMessageId || !CARD_FIELDS.some((k) => before[k] !== wish[k])) return null;
  await loadProps(a);
  const chat = notifyChat(a);
  if (!chat) return null;
  const params = { chat_id: chat, message_id: Number(wish.postMessageId), parse_mode: 'HTML' };
  const button = openButton(a, `item_${wish.id}`, 'Открыть и проголосовать');
  if (button) params.reply_markup = button;
  const text = cardText(wish);
  const asCaption = () => tgTry(a, 'editMessageCaption', { ...params, caption: shorten(text, 1000) });
  const asText = () => tgTry(a, 'editMessageText', { ...params, text, link_preview_options: { is_disabled: true } });
  // Cards from before postKind was kept: a picture card most likely, else a text one.
  let result = await (wish.postKind === 'text' ? asText() : asCaption());
  if (!result.ok && !wish.postKind && !/not modified/i.test(result.description || '')) result = await asText();
  return result;
}

function notify(a, kind, wish, actor) {
  const who = actor ? escapeHtml(userRef(actor).name) : '';
  const title = `<b>${escapeHtml(wish.title)}</b>`;
  let lines;
  let options = {};
  if (kind === 'added') {
    lines = [cardText(wish)];
    options.button = 'Открыть и проголосовать';
  } else if (kind === 'planned' || kind === 'moved') {
    // Short: two lines, no picture and no button — the card above has both.
    const plan = describePlan(wish, today());
    const when = !plan || plan.tone === 'nodate' ? 'дата пока не выбрана' : plan.detail;
    lines = [`📅 <b>${kind === 'moved' ? 'Перенесли' : 'В план'}:</b> ${escapeHtml(wish.title)}`, [when, priceText(wish), who].filter(Boolean).join(' · ')];
    options = { reply: true, compact: true };
  } else {
    const paid = wish.boughtPrice != null ? wish.boughtPrice : itemTotal(wish);
    lines = [`✅ <b>Куплено:</b> ${escapeHtml(wish.title)}`, [paid != null ? formatMoney(paid, wish.currency) : '', who].filter(Boolean).join(' · ')];
    options = { reply: true, compact: true };
  }
  return post(a, wish, lines.join('\n'), options);
}

/** Posts a new wish to the group and remembers that it did, so a failed post can be retried. */
async function announce(a, wish) {
  const sent = await notify(a, 'added', wish);
  if (sent && sent.ok) {
    Object.assign(wish, { postedAt: new Date().toISOString(), postMessageId: sent.result && sent.result.message_id, postKind: sent.via });
  }
  else wish.postTries = (wish.postTries || 0) + 1;
  await saveWish(a, wish);
  return sent;
}

/* ---------------- hourly ---------------- */

async function hourly(a) {
  await loadProps(a);
  const jobs = [catchUpPosts, learnGroups, morningReminder];
  for (const job of jobs) {
    try {
      await job(a);
    } catch (error) {
      console.error(job.name, error && error.stack ? error.stack : error);
    }
  }
}

/** New wishes (last 24 hours) whose post to the group didn't go through: tries again, 3 times at most. */
export async function catchUpPosts(a) {
  if (!notifyChat(a)) return 0;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const missed = (await readWishes(a)).filter(
    (w) => w.status === 'wanted' && !w.postedAt && (w.postTries || 0) < 3 && String(w.createdAt || '') >= since,
  );
  let sent = 0;
  for (const wish of missed) if ((await announce(a, wish)).ok) sent++;
  return sent;
}

/** Notices the bot being added to or removed from other groups, by admins of the main group only. */
async function learnGroups(a) {
  const main = prop(a, 'GROUP_CHAT_ID');
  if (!main) return;
  const updates = await tgTry(a, 'getUpdates', { allowed_updates: ['message', 'my_chat_member'] });
  const known = Object.fromEntries(accessGroups(a).map((g) => [g.id, g]));
  for (const u of updates.result || []) {
    const change = u.my_chat_member;
    if (!change || !change.from || (change.chat.type !== 'group' && change.chat.type !== 'supergroup')) continue;
    const chatId = String(change.chat.id);
    if (chatId === String(main)) continue;
    const status = change.new_chat_member.status;
    if (status === 'left' || status === 'kicked') {
      delete known[chatId];
      continue;
    }
    if (known[chatId]) continue;
    const by = await tgTry(a, 'getChatMember', { chat_id: main, user_id: change.from.id });
    if (!by.ok || (by.result.status !== 'creator' && by.result.status !== 'administrator')) continue;
    known[chatId] = { id: chatId, title: change.chat.title || '' };
    await tgTry(a, 'sendMessage', { chat_id: chatId, text: 'Участники этой группы теперь могут открывать вишлист HOROVOD: кнопка «Вишлист» в чате с ботом.' });
  }
  const next = JSON.stringify(Object.values(known));
  if (next !== (prop(a, 'ACCESS_GROUPS') || '[]')) await setProp(a, 'ACCESS_GROUPS', next);
}

/** Once a day at REMINDER_HOUR (Bratislava time): one message about purchases that are due. */
async function morningReminder(a) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour !== Number(prop(a, 'REMINDER_HOUR') || 10)) return;
  const chat = notifyChat(a);
  if (!chat) return;
  const now = today();
  const due = (await readWishes(a)).filter((w) => isDue(w, now) && w.remindedFor !== w.plannedDate);
  if (!due.length) return;
  const lines = ['<b>Скоро покупаем</b>'];
  for (const w of due) lines.push(`• <b>${escapeHtml(w.title)}</b> — ${planText(w)}${priceText(w) ? ` · ${priceText(w)}` : ''}`);
  const total = sumTotals(due).total;
  if (total) lines.push('', `Итого: <b>${formatMoney(total, currency(a))}</b>`);
  const sent = await sendTo(a, 'sendMessage', {
    ...target(a, chat),
    text: shorten(lines.join('\n'), 4000),
    parse_mode: 'HTML',
    reply_markup: openButton(a, 'plan', 'Открыть план'),
  });
  if (!sent.ok) throw new Error(`Telegram sendMessage: ${sent.description || sent.error_code}`);
  for (const w of due) {
    w.remindedFor = w.plannedDate;
    await saveWish(a, w);
  }
}
