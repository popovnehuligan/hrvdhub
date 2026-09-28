/**
 * HOROVOD · Вишлист — the backend, running as a Google Apps Script web app on top of
 * a Google Sheet (same setup as the bar bot, horovodart/hrvdbarbot).
 *
 * The bot token: the setup page (public/setup.html) puts it into PASTED_BOT_TOKEN below when
 * copying this script, and setup() moves it into the script properties. It never goes to the
 * app or to git.
 *
 * Script properties (Project Settings → Script Properties), all filled in by setup():
 *   BOT_TOKEN      — the wishlist bot's token from BotFather.
 *   GROUP_CHAT_ID  — the HOROVOD Telegram group. Its members can use the app, its admins are app admins.
 *                    setup() fills it in by itself if the bot has been added to exactly one group.
 *   ADMIN_IDS      — extra admins by Telegram id, comma separated (optional).
 *   NOTIFY_CHAT_ID — post news somewhere else than the group (optional).
 *   TOPIC_ID       — the topic (in a group with topics) to post in; setup() finds it.
 *   APP_URL        — the app's address (default: GitHub Pages); setup() puts it on the bot's menu button.
 *   CURRENCY       — default EUR. REMINDER_HOUR — default 10.
 *
 * Shared.gs is generated from public/lib/shared.js (tools/build-gs.mjs): the wish rules,
 * dates and money formatting are the same code in the app and here.
 *
 * Sheet «wishes»: one row per wish. The readable columns are for people looking at the
 * sheet; the last column («data») holds the full wish as JSON and is what the app reads.
 */

var PASTED_BOT_TOKEN = '';

var DEFAULT_APP_URL = 'https://popovnehuligan.github.io/hrvdhub/';
var AVATAR_VERSION = 'wishlist-avatar-1';
var BOT_DESCRIPTION = 'Вишлист HOROVOD: всё, что нужно купить для Хаба — инструменты, техника и остальное.\n\n' +
  'Добавляйте желания с фото или ссылкой на магазин, голосуйте за нужное и смотрите, что и когда мы планируем купить.\n\n' +
  'Откройте кнопкой «Вишлист» внизу.';
var BOT_SHORT_DESCRIPTION = 'Что купить для Хаба HOROVOD: желания, голоса и план покупок.';

var SHEET_NAME = 'wishes';
var HEADER = ['id', 'Название', 'Категория', 'Важность', 'Цена', 'Кол-во', 'Статус', 'Когда', 'Голоса', 'Ссылка', 'Добавил', 'data'];
var DATA_COL = HEADER.length;
var MAX_PHOTO_BYTES = 10 * 1024 * 1024;
var USER_AGENTS = [
  'TelegramBot (like TwitterBot)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
];

/* ---------------- entry points ---------------- */

// GET: a liveness check only. Wishes are served on POST with a Telegram signature.
function doGet() {
  return respond(function () { return { alive: true, version: prop('CODE_HASH') || '', ts: new Date().toISOString() } });
}

function doPost(e) {
  return respond(function () {
    var body;
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}') } catch (err) { throw new Error('Неверный запрос') }
    // Claude calls this after publishing a new version; the code comes only from GitHub Pages.
    if (body.action === 'refreshCode') return updateNow();
    var user = auth(body.initData);
    return handle(String(body.action || ''), body.payload || {}, user);
  });
}

function respond(fn) {
  var out;
  try { out = { ok: true, data: fn() } }
  catch (err) { out = { ok: false, error: String((err && err.message) || err), status: (err && err.status) || 400 } }
  // Non-ASCII as \uXXXX, so the answer doesn't depend on how the client guesses the encoding.
  var json = JSON.stringify(out).replace(/[\u0080-￿]/g, function (c) {
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- access ---------------- */

function fail(message, status) { throw new WishError(message, status || 400) }

/** Checks Telegram's signature on initData. https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function auth(initData) {
  var token = botToken();
  if (!token) fail('Вишлист ещё не настроен: нет ключа бота', 503);
  if (!initData) fail('Откройте вишлист через Telegram', 401);

  var fields = {}, hash = '';
  String(initData).split('&').forEach(function (part) {
    var eq = part.indexOf('=');
    if (eq < 0) return;
    var key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
    var value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (key === 'hash') hash = value; else fields[key] = value;
  });
  var check = Object.keys(fields).sort().map(function (k) { return k + '=' + fields[k] }).join('\n');
  var secret = Utilities.computeHmacSha256Signature(Utilities.newBlob(token).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  var signature = Utilities.computeHmacSha256Signature(Utilities.newBlob(check).getBytes(), secret);
  if (hex(signature) !== String(hash).toLowerCase()) fail('Подпись Telegram не сошлась. Откройте вишлист заново', 401);

  var authAt = Number(fields.auth_date) * 1000;
  if (!isFinite(authAt) || authAt < Date.now() - 24 * 3600 * 1000) fail('Сессия устарела, откройте вишлист заново', 401);

  var user = JSON.parse(fields.user || '{}');
  if (!user.id) fail('Откройте вишлист через Telegram', 401);
  var rights = access(user.id);
  if (!rights.allowed) fail('Этот вишлист только для участников HOROVOD (ваш id ' + user.id + ')', 403);
  user.isAdmin = rights.admin;
  return user;
}

function hex(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2) }).join('');
}

function ids(value) {
  return String(value || '').split(',').map(function (s) { return s.trim() }).filter(String);
}

/** Group members may use the app; group admins and ADMIN_IDS are admins. Cached for 10 minutes. */
function access(userId) {
  var id = String(userId);
  var cache = CacheService.getScriptCache();
  var cached = cache.get('access:' + id);
  if (cached) return JSON.parse(cached);

  var result = { allowed: false, admin: false };
  if (ids(prop('ADMIN_IDS')).indexOf(id) >= 0) result = { allowed: true, admin: true };
  var group = prop('GROUP_CHAT_ID');
  if (!result.admin && group) {
    var member = tgTry('getChatMember', { chat_id: group, user_id: Number(id) });
    if (member.ok) {
      var status = member.result.status;
      if (status === 'creator' || status === 'administrator') result = { allowed: true, admin: true };
      else if (status === 'member' || (status === 'restricted' && member.result.is_member)) result = { allowed: true, admin: false };
    } else if (member.error_code !== 400) {
      fail('Не удалось проверить участие через Telegram. Попробуйте чуть позже', 503);
    }
  }
  if (!group && !ids(prop('ADMIN_IDS')).length) fail('Вишлист ещё не настроен: запустите setup() в Apps Script', 503);
  cache.put('access:' + id, JSON.stringify(result), result.allowed ? 600 : 60);
  return result;
}

/* ---------------- actions ---------------- */

function handle(action, p, user) {
  var ctx = { userId: user.id, isAdmin: user.isAdmin };
  if (action === 'list') {
    return {
      me: { user: userRef(user), isAdmin: user.isAdmin, currency: currency() },
      items: readWishes().map(view(user))
    };
  }
  if (action === 'preview') return preview(p.url);
  if (action === 'upload') return upload(p.photo);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // The app retries when Google's answer gets lost; the same request id must not add a wish twice.
    var rid = p.rid ? 'rid:' + String(p.rid).slice(0, 64) : null;
    var cache = CacheService.getScriptCache();
    if (rid && cache.get(rid)) {
      var done = findWish(cache.get(rid));
      return { item: done ? view(user)(done) : null };
    }

    if (action === 'create') {
      var patch = checkImageRef(cleanWishInput(p.wish || {}, { isAdmin: ctx.isAdmin, isNew: true, today: today() }));
      var wish = newWish(patch, { user: user, currency: currency() });
      if (!wish.link && !wish.image) fail('Добавьте фото или ссылку');
      if (wish.link && !wish.image) attachLinkImage(wish);
      saveWish(wish);
      if (rid) cache.put(rid, wish.id, 21600);
      notify('added', wish);
      return { item: view(user)(wish) };
    }

    var current = findWish(p.id);
    if (!current) fail('Этого желания больше нет', 404);

    if (action === 'vote') {
      var voted = toggleVote(current, user);
      saveWish(voted);
      return { item: view(user)(voted) };
    }
    if (action === 'update') {
      if (!canEditWish(current, ctx)) fail('Можно менять только свои желания', 403);
      var changes = checkImageRef(cleanWishInput(p.patch || {}, { isAdmin: ctx.isAdmin, isNew: false, today: today() }));
      var result = applyWishPatch(current, changes);
      var next = result.wish;
      if (next.link && !next.image && next.link !== current.link) attachLinkImage(next);
      saveWish(next);
      if (result.becamePlanned) notify('planned', next);
      if (result.becameBought) notify('bought', next);
      return { item: view(user)(next) };
    }
    if (action === 'delete') {
      if (!canEditWish(current, ctx)) fail('Можно удалять только свои желания', 403);
      removeWish(current.id);
      return { ok: true };
    }
  } finally {
    lock.releaseLock();
  }
  fail('Неизвестное действие');
}

function view(user) {
  return function (wish) { return publicWish(wish, user.id, imageUrl) };
}

/** Pictures are uploaded separately (upload); a wish only ever points at them. */
function checkImageRef(patch) {
  if (patch.image && /^data:/.test(patch.image)) fail('Сначала загрузите фото');
  return patch;
}

/** 'drive:ID' → a public Google Drive picture address; anything else is already an address. */
function imageUrl(ref) {
  var match = /^drive:(.+)$/.exec(ref || '');
  return match ? 'https://lh3.googleusercontent.com/d/' + match[1] + '=w1000' : ref;
}

/* ---------------- the sheet ---------------- */

function book() {
  var id = prop('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function wishSheet() {
  var spreadsheet = book();
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
    // Plain text everywhere, or Sheets turns "2026-10-01" into a date and "1,5" into a number.
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADER.length).setNumberFormat('@');
  }
  return sheet;
}

function readWishes() {
  var sheet = wishSheet();
  var count = sheet.getLastRow() - 1;
  if (count < 1) return [];
  return sheet.getRange(2, DATA_COL, count, 1).getValues()
    .map(function (row) { try { return JSON.parse(row[0]) } catch (e) { return null } })
    .filter(function (wish) { return wish && wish.id });
}

function findWish(id) {
  if (!id) return null;
  return readWishes().filter(function (wish) { return wish.id === String(id) })[0] || null;
}

function rowIndex(sheet, id) {
  var count = sheet.getLastRow() - 1;
  if (count < 1) return -1;
  var column = sheet.getRange(2, 1, count, 1).getValues();
  for (var i = 0; i < column.length; i++) if (String(column[i][0]) === id) return i + 2;
  return -1;
}

function readableRow(wish) {
  var category = findOption(CATEGORIES, wish.category);
  var priority = findOption(PRIORITIES, wish.priority);
  var status = { wanted: wish.planned ? 'В плане' : 'Желание', bought: 'Куплено', dropped: 'Отменено' }[wish.status];
  var when = wish.status === 'bought' ? (wish.boughtAt || '') : wish.planned ? (wish.plannedDate || 'без даты') : '';
  var total = itemTotal(wish);
  return [
    wish.id, wish.title, category.label, priority.label, total == null ? '' : formatMoney(total, wish.currency),
    String(wish.quantity || 1), status, when, String(wish.votes.length), wish.link || '',
    wish.createdBy ? wish.createdBy.name : '', JSON.stringify(wish)
  ];
}

function saveWish(wish) {
  var sheet = wishSheet();
  var row = rowIndex(sheet, wish.id);
  if (row < 0) sheet.appendRow(readableRow(wish));
  else sheet.getRange(row, 1, 1, HEADER.length).setValues([readableRow(wish)]);
}

function removeWish(id) {
  var sheet = wishSheet();
  var row = rowIndex(sheet, id);
  if (row > 0) sheet.deleteRow(row);
}

/* ---------------- photos (Google Drive) ---------------- */

function photosFolder() {
  var id = prop('PHOTOS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id) } catch (e) { /* deleted: make a new one */ } }
  var folder = DriveApp.createFolder('HOROVOD Вишлист — фото');
  setProp('PHOTOS_FOLDER_ID', folder.getId());
  return folder;
}

var IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** The picture format from its first bytes. SVG is never accepted. */
function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  var b = function (i) { return bytes[i] & 0xff };
  var ascii = function (from, to) { var s = ''; for (var i = from; i < to; i++) s += String.fromCharCode(b(i)); return s };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
  if (b(0) === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

function savePhoto(bytes, name) {
  var type = detectImageType(bytes);
  if (!type) fail('Нужна картинка JPG, PNG, WebP или GIF', 415);
  if (bytes.length > MAX_PHOTO_BYTES) fail('Файл слишком большой', 413);
  var file = photosFolder().createFile(Utilities.newBlob(bytes, IMAGE_TYPES[type], (name || 'photo') + '.' + type));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'drive:' + file.getId();
}

/** photo — "data:image/jpeg;base64,…", already made smaller by the app. */
function upload(photo) {
  var match = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(String(photo || ''));
  if (!match) fail('Нужна картинка JPG, PNG, WebP или GIF', 415);
  var image = savePhoto(Utilities.base64Decode(match[1]), 'upload-' + newWishId());
  return { image: image, imageUrl: imageUrl(image) };
}

/* ---------------- link previews ---------------- */

var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (match, code) {
    if (code.charAt(0) === '#') {
      var n = code.charAt(1).toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] || match;
  });
}

function parseAttributes(tag) {
  var attrs = {};
  var inner = tag.replace(/^<[\w-]+/, '').replace(/\/?>$/, '');
  var re = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g, m;
  while ((m = re.exec(inner))) {
    var key = m[1].toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  }
  return attrs;
}

/** "1 299,90 €" → 1299.9, "1,299.00" → 1299, "1.299" → 1299 */
function parsePrice(value) {
  if (typeof value === 'number') return isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  var digits = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;
  var decimals = digits.match(/[.,](\d{1,2})$/);
  var whole = (decimals ? digits.slice(0, -decimals[0].length) : digits).replace(/[.,]/g, '');
  var number = Number((whole || '0') + (decimals ? '.' + decimals[1] : ''));
  return isFinite(number) ? number : null;
}

function resolveUrl(base, ref) {
  ref = String(ref || '').trim();
  if (/^https?:\/\//i.test(ref)) return ref;
  var origin = (/^(https?:\/\/[^\/?#]+)/i.exec(base) || [])[1];
  if (!origin) return null;
  if (ref.indexOf('//') === 0) return base.split(':')[0] + ':' + ref;
  if (ref.charAt(0) === '/') return origin + ref;
  var path = base.replace(/[?#].*$/, '');
  return path.slice(0, path.lastIndexOf('/') + 1) + ref;
}

function findProducts(node, found, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return found;
  if (Array.isArray(node)) { node.forEach(function (child) { findProducts(child, found, depth + 1) }); return found }
  var types = [].concat(node['@type'] || []).map(String);
  if (types.some(function (t) { return /^(Product|ProductGroup|IndividualProduct|ProductModel)$/i.test(t) })) found.push(node);
  Object.keys(node).forEach(function (k) { if (node[k] && typeof node[k] === 'object') findProducts(node[k], found, depth + 1) });
  return found;
}

/** Pulls the title, picture candidates and price out of a product page. */
function parseHtmlMeta(html, pageUrl) {
  var meta = {}, m;
  var metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    var a = parseAttributes(m[0]);
    var key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = a.content.trim();
  }
  var tagImages = [];
  var tagRe = /<(?:link|img)\b[^>]*>/gi;
  while ((m = tagRe.exec(html))) {
    var t = parseAttributes(m[0]);
    if ((t.rel || '').toLowerCase().split(/\s+/).indexOf('image_src') >= 0) tagImages.push(t.href);
    else if ((t.itemprop || '').toLowerCase() === 'image') tagImages.push(t.href || t.src || t['data-src']);
  }
  var products = [];
  var ldRe = /<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) { try { findProducts(JSON.parse(m[1].trim()), products, 0) } catch (e) { /* broken JSON-LD is common */ } }
  var product = products[0] || {};

  var offer = null;
  [].concat(product.offers || []).some(function (o) {
    if (!o || typeof o !== 'object') return false;
    var spec = [].concat(o.priceSpecification || [])[0] || {};
    var price = parsePrice(o.price != null ? o.price : o.lowPrice != null ? o.lowPrice : spec.price);
    if (price == null) return false;
    offer = { price: price, currency: o.priceCurrency || spec.priceCurrency || null };
    return true;
  });

  var candidates = [meta['og:image:secure_url'], meta['og:image'], meta['og:image:url'], meta['twitter:image'], meta['twitter:image:src']]
    .concat([].concat(product.image || []).map(function (x) { return typeof x === 'string' ? x : x && (x.url || x.contentUrl) }))
    .concat(tagImages);
  var images = [];
  candidates.forEach(function (c) {
    if (!c || typeof c !== 'string') return;
    var url = resolveUrl(pageUrl, decodeEntities(c));
    if (url && /^https?:\/\//i.test(url) && images.indexOf(url) < 0) images.push(url);
  });

  var clean = function (v, max) { return v ? decodeEntities(String(v)).replace(/\s+/g, ' ').trim().slice(0, max) : '' };
  var titleTag = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  var metaPrice = parsePrice(meta['product:price:amount'] || meta['og:price:amount'] || meta.price);
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || product.name || titleTag, 200),
    siteName: clean(meta['og:site_name'], 100),
    images: images,
    price: offer ? offer.price : metaPrice,
    currency: clean((offer && offer.currency) || meta['product:price:currency'] || meta['og:price:currency'] || meta.pricecurrency, 3).toUpperCase() || null
  };
}

function fetchUrl(url, userAgent, referer) {
  var headers = { 'User-Agent': userAgent, 'Accept-Language': 'en,sk;q=0.8,cs;q=0.6' };
  if (referer) headers.Referer = referer;
  return UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: headers });
}

/** Downloads a picture into the Drive folder. Returns 'drive:ID' or null. */
function downloadImage(url, referer) {
  try {
    var response = fetchUrl(url, USER_AGENTS[1], referer);
    if (response.getResponseCode() !== 200) return null;
    var bytes = response.getContent();
    if (bytes.length < 1024 || !detectImageType(bytes)) return null;
    return savePhoto(bytes, 'link-' + newWishId());
  } catch (e) {
    return null;
  }
}

/** Opens a shop link: { title, siteName, price, currency, image } with the picture already in Drive. */
function linkPreview(link) {
  var page = null, lastError = null;
  for (var i = 0; i < USER_AGENTS.length; i++) {
    try {
      var response = fetchUrl(link, USER_AGENTS[i]);
      var code = response.getResponseCode();
      if (code >= 400) { lastError = 'Магазин ответил ошибкой (' + code + ')'; continue }
      var type = String(response.getHeaders()['Content-Type'] || response.getHeaders()['content-type'] || '');
      if (type.indexOf('image/') === 0) { page = { title: '', siteName: '', images: [link], price: null, currency: null }; break }
      page = parseHtmlMeta(response.getContentText(), link);
      if (page.images.length) break;
    } catch (e) {
      lastError = e.message;
    }
  }
  if (!page) throw new Error(lastError || 'Не удалось открыть ссылку');
  var image = null;
  for (var j = 0; j < Math.min(page.images.length, 4) && !image; j++) image = downloadImage(page.images[j], link);
  return { title: page.title, siteName: page.siteName, price: page.price, currency: page.currency, image: image };
}

function preview(url) {
  var link = normalizeLink(url || '');
  if (!link) fail('Сначала вставьте ссылку');
  try {
    var p = linkPreview(link);
    return { title: p.title, siteName: p.siteName, price: p.price, currency: p.currency, link: link,
             image: p.image, imageUrl: p.image ? imageUrl(p.image) : null };
  } catch (e) {
    fail('Не получилось открыть ссылку. Её всё равно можно сохранить или добавить фото вручную', 422);
  }
}

/** "If a link is added it should add an image there." */
function attachLinkImage(wish) {
  try {
    var image = linkPreview(wish.link).image;
    if (image) { wish.image = image; wish.imageSource = 'link' }
  } catch (e) { /* the link alone is enough */ }
}

/* ---------------- Telegram ---------------- */

function tgTry(method, payload) {
  var token = botToken();
  var options = { method: 'post', muteHttpExceptions: true };
  var multipart = Object.keys(payload).some(function (k) { return payload[k] && typeof payload[k].getBytes === 'function' });
  if (multipart) {
    var form = {};
    Object.keys(payload).forEach(function (k) {
      var v = payload[k];
      if (v == null) return;
      // A form takes only text and files: numbers (like the topic's id) must become text too.
      form[k] = typeof v.getBytes === 'function' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    options.payload = form;
  } else {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, options);
  try { return JSON.parse(response.getContentText()) } catch (e) { return { ok: false, error_code: response.getResponseCode() } }
}

function tg(method, payload) {
  var result = tgTry(method, payload);
  if (!result.ok) throw new Error('Telegram ' + method + ': ' + (result.description || result.error_code));
  return result.result;
}

var escapeHtml = function (text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
var shorten = function (text, max) { return text.length > max ? text.slice(0, max - 1) + '…' : text };

/**
 * Where the buttons in group posts lead. With the bot's Main Mini App switched on in BotFather,
 * straight to the wish (or the plan); otherwise to the chat with the bot, which has the «Вишлист» button.
 */
function appLink(startParam) {
  if (prop('APP_LINK')) return prop('APP_LINK') + '?startapp=' + encodeURIComponent(startParam);
  if (!prop('BOT_USERNAME')) return null;
  var chat = 'https://t.me/' + prop('BOT_USERNAME');
  return prop('BOT_HAS_MAIN_APP') === 'yes' ? chat + '?startapp=' + encodeURIComponent(startParam) : chat;
}

function openButton(startParam, text) {
  var link = appLink(startParam);
  if (!link) return undefined;
  var direct = prop('APP_LINK') || prop('BOT_HAS_MAIN_APP') === 'yes';
  return { inline_keyboard: [[{ text: direct ? text : 'Открыть вишлист', url: link }]] };
}

function priceText(wish) {
  var total = itemTotal(wish);
  if (total == null) return '';
  return wish.quantity > 1
    ? formatMoney(total, wish.currency) + ' (' + wish.quantity + ' × ' + formatMoney(wish.price, wish.currency) + ')'
    : formatMoney(total, wish.currency);
}

function planText(wish) {
  var plan = describePlan(wish, today());
  if (!plan) return '';
  if (plan.tone === 'nodate') return 'дата пока не выбрана';
  return plan.label.toLowerCase() + ' (' + plan.detail + ')';
}

function notifyChat() { return prop('NOTIFY_CHAT_ID') || prop('GROUP_CHAT_ID') }

/** Where posts go: the chat, plus the topic when the group has topics. */
function target(chat) {
  var params = { chat_id: chat };
  if (prop('TOPIC_ID') && !prop('NOTIFY_CHAT_ID')) params.message_thread_id = Number(prop('TOPIC_ID'));
  return params;
}

/** Sends to the topic; if the topic is gone, to the group's main chat, so nothing gets lost. */
function sendTo(method, params) {
  var result = tgTry(method, params);
  if (!result.ok && params.message_thread_id && /thread|topic/i.test(result.description || '')) {
    var plain = Object.assign({}, params);
    delete plain.message_thread_id;
    result = tgTry(method, plain);
  }
  return result;
}

/**
 * Posts to the group with the picture and a button that opens the wish. Never breaks the save:
 * without the picture it tries plain text, and a failure is kept in LAST_POST_ERROR for check().
 */
function post(wish, text) {
  var chat = notifyChat();
  if (!chat) return { ok: false, description: 'группа не задана (GROUP_CHAT_ID)' };
  var params = Object.assign(target(chat), { parse_mode: 'HTML' });
  var button = openButton('item_' + wish.id, 'Открыть в вишлисте');
  if (button) params.reply_markup = button;
  var result = null;
  try {
    var photo = null;
    var drive = /^drive:(.+)$/.exec(wish.image || '');
    if (drive) photo = DriveApp.getFileById(drive[1]).getBlob();
    else if (/^https:\/\//.test(wish.image || '')) photo = wish.image;
    if (photo) result = sendTo('sendPhoto', Object.assign({}, params, { photo: photo, caption: shorten(text, 1000) }));
  } catch (e) {
    result = { ok: false, description: e.message };
  }
  if (!result || !result.ok) {
    try {
      result = sendTo('sendMessage', Object.assign({}, params, { text: text, link_preview_options: { is_disabled: true } }));
    } catch (e) {
      result = { ok: false, description: e.message };
    }
  }
  if (result.ok) setProp('LAST_POST_ERROR', '');
  else {
    console.warn('Не удалось написать в группу: ' + result.description);
    setProp('LAST_POST_ERROR', Utilities.formatDate(new Date(), timeZone(), 'dd.MM HH:mm') + ' — ' + (result.description || result.error_code));
  }
  return result;
}

function notify(kind, wish) {
  var lines;
  if (kind === 'added') {
    var category = findOption(CATEGORIES, wish.category), priority = findOption(PRIORITIES, wish.priority);
    lines = ['<b>' + escapeHtml(wish.createdBy.name) + '</b> добавил(а) желание:', '<b>' + escapeHtml(wish.title) + '</b>',
             category.label + ' · ' + priority.label];
    if (priceText(wish)) lines.push('Цена: ' + priceText(wish));
    if (wish.note) lines.push(escapeHtml(shorten(wish.note, 300)));
    if (wish.planned) lines.push('В плане: ' + planText(wish));
  } else if (kind === 'planned') {
    lines = ['<b>Планируем купить</b>: ' + escapeHtml(wish.title), 'Когда: <b>' + planText(wish) + '</b>'];
    if (priceText(wish)) lines.push('Цена: ' + priceText(wish));
  } else {
    var paid = wish.boughtPrice != null ? wish.boughtPrice : itemTotal(wish);
    lines = ['<b>Куплено</b>: ' + escapeHtml(wish.title)];
    if (paid != null) lines.push('Оплачено: ' + formatMoney(paid, wish.currency));
  }
  return post(wish, lines.join('\n'));
}

/** Runs every morning (setup() installs the trigger): one message about purchases that are due. */
function dailyReminders() {
  var chat = notifyChat();
  if (!chat) return;
  var now = today();
  var wishes = readWishes();
  var due = wishes.filter(function (w) { return isDue(w, now) && w.remindedFor !== w.plannedDate });
  if (!due.length) return;
  var lines = ['<b>Скоро покупаем</b>'];
  due.forEach(function (w) {
    lines.push('• <b>' + escapeHtml(w.title) + '</b> — ' + planText(w) + (priceText(w) ? ' · ' + priceText(w) : ''));
  });
  var total = sumTotals(due).total;
  if (total) lines.push('', 'Итого: <b>' + formatMoney(total, currency()) + '</b>');
  refreshBotInfo();
  var sent = sendTo('sendMessage', Object.assign(target(chat), { text: shorten(lines.join('\n'), 4000), parse_mode: 'HTML',
                                                           reply_markup: openButton('plan', 'Открыть план') }));
  if (!sent.ok) throw new Error('Telegram sendMessage: ' + (sent.description || sent.error_code));
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    due.forEach(function (w) {
      var fresh = findWish(w.id);
      if (fresh) { fresh.remindedFor = fresh.plannedDate; saveWish(fresh) }
    });
  } finally { lock.releaseLock() }
}

/* ---------------- updating itself ---------------- */

/**
 * The script keeps itself up to date with the version published on GitHub Pages: new code →
 * a new version → the web app's deployment points at it. Runs every hour, at the end of setup(),
 * and when Claude asks (POST action «refreshCode») after publishing. Needs the Apps Script API
 * switched on at https://script.google.com/home/usersettings.
 */
function selfUpdate(force) {
  var bust = '?t=' + Date.now();
  var code = fetchText(appUrlSetting() + 'setup/wishlist-script.txt' + bust);
  var manifest = fetchText(appUrlSetting() + 'setup/appsscript.json' + bust);
  if (code.indexOf('function doPost') < 0 || manifest.indexOf('oauthScopes') < 0) throw new Error('на GitHub Pages не тот скрипт');
  var hash = codeHash(code + manifest);
  if (!force && prop('CODE_HASH') === hash) return { updated: false, version: hash };

  var id = ScriptApp.getScriptId();
  scriptApi('put', '/projects/' + id + '/content', { files: [
    { name: 'appsscript', type: 'JSON', source: manifest },
    { name: 'Code', type: 'SERVER_JS', source: code }
  ] });
  var version = scriptApi('post', '/projects/' + id + '/versions', { description: 'wishlist ' + hash });
  var deployments = scriptApi('get', '/projects/' + id + '/deployments').deployments || [];
  var moved = 0;
  deployments.forEach(function (d) {
    var web = (d.entryPoints || []).some(function (e) { return e.entryPointType === 'WEB_APP' });
    if (!web || !d.deploymentConfig || !d.deploymentConfig.versionNumber) return; // @HEAD follows the code by itself
    scriptApi('put', '/projects/' + id + '/deployments/' + d.deploymentId, { deploymentConfig: {
      scriptId: id, versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: 'wishlist ' + hash } });
    moved++;
  });
  setProp('CODE_HASH', hash);
  return { updated: true, version: hash, versionNumber: version.versionNumber, deployments: moved };
}

/** Hourly trigger. */
function autoUpdate() {
  try { selfUpdate(false) } catch (e) { console.warn('Автообновление: ' + e.message) }
}

function updateNow() {
  var cache = CacheService.getScriptCache();
  if (cache.get('updating')) return { updated: false, busy: true, version: prop('CODE_HASH') || '' };
  cache.put('updating', '1', 30);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return selfUpdate(false) } finally { lock.releaseLock() }
}

function fetchText(url) {
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error(url + ' не скачался (' + response.getResponseCode() + ')');
  return response.getContentText();
}

function codeHash(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2) }).join('').slice(0, 12);
}

function scriptApi(method, path, body) {
  var options = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body) }
  var response = UrlFetchApp.fetch('https://script.googleapis.com/v1' + path, options);
  var data = {};
  try { data = JSON.parse(response.getContentText() || '{}') } catch (e) { /* not JSON */ }
  if (response.getResponseCode() >= 300) {
    var message = (data.error && data.error.message) || ('HTTP ' + response.getResponseCode());
    if (/Apps Script API|has not been used|is disabled/i.test(message)) message = 'включите Google Apps Script API на https://script.google.com/home/usersettings';
    else if (/insufficient|scope/i.test(message)) message = 'нет разрешения: запустите setup и нажмите «Разрешить»';
    throw new Error(message);
  }
  return data;
}

/* ---------------- one-time setup ---------------- */

/**
 * Run once from the Apps Script editor (and again whenever you like). Does everything:
 * saves the bot key, creates the sheet and the photo folder, finds the HOROVOD group, gives the
 * bot its picture, description and «Вишлист» button, and turns on the morning reminder.
 * Prints what it did.
 */
function setup() {
  if (PASTED_BOT_TOKEN && prop('BOT_TOKEN') !== PASTED_BOT_TOKEN) setProp('BOT_TOKEN', PASTED_BOT_TOKEN);
  if (!botToken()) throw new Error('Нет ключа бота: скопируйте скрипт заново со страницы настройки, вставив ключ');
  var report = [];
  wishSheet();
  report.push('✓ Лист «' + SHEET_NAME + '» готов');
  report.push('✓ Папка для фото: «' + photosFolder().getName() + '» на Google Диске');

  var me = refreshBotInfo();
  report.push('✓ Бот: @' + me.username + ' («' + me.first_name + '»)');

  if (!prop('GROUP_CHAT_ID')) {
    var groups = findGroups();
    if (groups.length === 1) {
      setProp('GROUP_CHAT_ID', groups[0].id);
      report.push('✓ Группа: «' + groups[0].title + '»');
    } else if (!groups.length) {
      report.push('✗ Группа не найдена. Добавьте бота в группу HOROVOD (если он уже там — удалите и добавьте снова) и запустите setup ещё раз');
    } else {
      report.push('✗ Бот состоит в нескольких группах. Впишите нужную в свойство GROUP_CHAT_ID: ' +
                  groups.map(function (g) { return '«' + g.title + '» = ' + g.id }).join('; '));
    }
  } else {
    report.push('✓ Группа: ' + prop('GROUP_CHAT_ID'));
  }
  if (prop('GROUP_CHAT_ID')) report.push(findTopic());

  var appUrl = appUrlSetting();
  tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Вишлист', web_app: { url: appUrl } } });
  report.push('✓ Кнопка «Вишлист» у бота: ' + appUrl);

  tg('setMyDescription', { description: BOT_DESCRIPTION });
  tg('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION });
  report.push('✓ Описание бота');

  report.push(setBotPicture(appUrl));

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReminders') ScriptApp.deleteTrigger(t);
  });
  var hour = Number(prop('REMINDER_HOUR') || 10);
  ScriptApp.newTrigger('dailyReminders').timeBased().atHour(hour).everyDays(1).inTimezone(timeZone()).create();
  report.push('✓ Напоминания: каждый день около ' + hour + ':00');

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoUpdate') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoUpdate').timeBased().everyHours(1).create();
  try {
    var update = selfUpdate(true);
    report.push('✓ Автообновление включено: веб-приложение на версии ' + update.version +
                (update.deployments ? '' : ' (опубликованного веб-приложения не нашлось: Deploy → New deployment → Web app)'));
  } catch (e) {
    report.push('✗ Автообновление не работает: ' + e.message);
  }

  if (me.has_main_web_app) report.push('✓ Кнопки в группе открывают нужное желание сразу');
  else report.push('• Кнопки в группе открывают чат с ботом. Чтобы они открывали желание сразу: BotFather → бот → Bot Settings → Configure Mini App → Enable, адрес ' + appUrl);

  report.forEach(function (line) { Logger.log(line) });
  return report;
}

/**
 * Run from the Apps Script editor when the bot is quiet in the group. Checks the group, the topic
 * and the bot's rights, fixes what it can, and posts a test message about the newest wish.
 */
function check() {
  var report = [];
  var me = refreshBotInfo();
  report.push('✓ Бот: @' + me.username);
  var group = prop('GROUP_CHAT_ID');
  if (!group) {
    report.push('✗ Группа не задана: добавьте бота в группу, напишите в теме Wishlist /start@' + me.username + ' и запустите setup');
    report.forEach(function (line) { Logger.log(line) });
    return report;
  }
  var chat = tgTry('getChat', { chat_id: group });
  var moved = chat.parameters && chat.parameters.migrate_to_chat_id;
  if (moved) {
    // The group became a supergroup and got a new id.
    setProp('GROUP_CHAT_ID', moved);
    group = String(moved);
    chat = tgTry('getChat', { chat_id: group });
    report.push('✓ Группа сменила адрес (стала супергруппой), исправил');
  }
  if (!chat.ok) report.push('✗ Бот не видит группу (' + chat.description + '). Добавьте его в группу снова и запустите setup');
  else report.push('✓ Группа: «' + chat.result.title + '»' + (chat.result.is_forum ? ', с темами' : ''));

  var self = tgTry('getChatMember', { chat_id: group, user_id: me.id });
  if (self.ok) {
    var status = self.result.status;
    if (status === 'left' || status === 'kicked') report.push('✗ Бота нет в группе. Добавьте его снова');
    else if (status === 'restricted' && (self.result.can_send_messages === false || self.result.can_send_photos === false)) {
      report.push('✗ Боту запрещено писать или отправлять фото в группе. Разрешите в настройках группы → Участники → бот');
    } else report.push('✓ Бот в группе' + (status === 'administrator' ? ' (админ)' : ''));
  }

  if (prop('NOTIFY_CHAT_ID')) report.push('• Сообщения идут в отдельный чат NOTIFY_CHAT_ID = ' + prop('NOTIFY_CHAT_ID'));
  else if (prop('TOPIC_ID')) report.push('✓ Тема для сообщений: ' + prop('TOPIC_ID'));
  else if (chat.ok && chat.result.is_forum) report.push(findTopic());

  if (prop('LAST_POST_ERROR')) report.push('• Последняя ошибка при отправке: ' + prop('LAST_POST_ERROR'));

  var wishes = readWishes().filter(function (w) { return w.status !== 'dropped' });
  wishes.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) });
  var sent;
  if (wishes.length) {
    report.push('✓ Желаний в таблице: ' + wishes.length + ', последнее: «' + wishes[0].title + '»');
    sent = post(wishes[0], '<b>Проверка связи</b>: так бот пишет о новых желаниях.\n<b>' + escapeHtml(wishes[0].title) + '</b>');
  } else {
    report.push('✗ В таблице нет ни одного желания. Если вы уже добавляли желание, оно осталось только в телефоне: ' +
                'приложение было в демо-режиме (внизу списка надпись «Демо-режим»). Закройте мини-приложение и откройте снова');
    sent = sendTo('sendMessage', Object.assign(target(notifyChat()), { text: 'Проверка связи: вишлист будет писать сюда.' }));
  }
  report.push(sent.ok ? '✓ Тестовое сообщение отправлено — посмотрите в группу'
                      : '✗ Тестовое сообщение не ушло: ' + (sent.description || sent.error_code));
  report.forEach(function (line) { Logger.log(line) });
  return report;
}

/** The bot's username and whether it has a Main Mini App (switched on in BotFather). */
function refreshBotInfo() {
  var me = tg('getMe', {});
  setProp('BOT_USERNAME', me.username);
  setProp('BOT_HAS_MAIN_APP', me.has_main_web_app ? 'yes' : 'no');
  return me;
}

/** Uploads the bot's profile picture (from the app's site), once per picture version. */
function setBotPicture(appUrl) {
  if (prop('AVATAR_VERSION') === AVATAR_VERSION) return '✓ Картинка бота уже стоит';
  try {
    var response = UrlFetchApp.fetch(appUrl + 'brand/bot-avatar.jpg', { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('картинка не скачалась (' + response.getResponseCode() + ')');
    var picture = response.getBlob().setName('bot-avatar.jpg');
    var result = tgTry('setMyProfilePhoto', { photo: { type: 'static', photo: 'attach://avatar' }, avatar: picture });
    if (!result.ok) throw new Error(result.description || 'Telegram не принял картинку');
    setProp('AVATAR_VERSION', AVATAR_VERSION);
    return '✓ Картинка бота';
  } catch (e) {
    return '✗ Картинку бота поставить не вышло (' + e.message + '). Можно вручную: BotFather → /setuserpic, файл ' + appUrl + 'brand/bot-avatar.png';
  }
}

/**
 * In a group with topics: the topic to post in. Found from a command sent to the bot inside
 * that topic (bots see commands even with privacy mode on). A topic named like «Wishlist»
 * wins; otherwise the only topic the bot was written to in.
 */
function findTopic() {
  var group = String(prop('GROUP_CHAT_ID'));
  var updates = tgTry('getUpdates', { allowed_updates: ['message', 'my_chat_member'] });
  var topics = {}, order = [];
  (updates.result || []).forEach(function (u) {
    var m = u.message;
    if (!m || String(m.chat.id) !== group || !m.chat.is_forum || !m.is_topic_message || !m.message_thread_id) return;
    var created = m.reply_to_message && m.reply_to_message.forum_topic_created;
    if (!topics[m.message_thread_id]) order.push(m.message_thread_id);
    topics[m.message_thread_id] = created ? created.name : (topics[m.message_thread_id] || '');
  });
  var named = order.filter(function (id) { return /wish|вишлист|желан/i.test(topics[id]) });
  var pick = named.length ? named[0] : order.length === 1 ? order[0] : null;
  if (pick) {
    setProp('TOPIC_ID', pick);
    return '✓ Тема для сообщений: «' + (topics[pick] || pick) + '»';
  }
  if (prop('TOPIC_ID')) return '✓ Тема для сообщений: ' + prop('TOPIC_ID');
  var forum = (updates.result || []).some(function (u) {
    var chat = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
    return chat && String(chat.id) === group && chat.is_forum;
  });
  return forum
    ? '✗ Тема не найдена. В теме Wishlist отправьте /start@' + prop('BOT_USERNAME') + ' и запустите setup ещё раз'
    : '• Сообщения пойдут в общий чат группы';
}

/** Groups the bot is in, from its recent updates (being added to a group is one). */
function findGroups() {
  var updates = tgTry('getUpdates', { allowed_updates: ['message', 'my_chat_member'] });
  var groups = {}, order = [];
  (updates.result || []).forEach(function (u) {
    var chat = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
    var status = u.my_chat_member ? u.my_chat_member.new_chat_member.status : 'member';
    if (!groups[chat.id]) order.push(chat.id);
    groups[chat.id] = { id: String(chat.id), title: chat.title || '', present: status === 'member' || status === 'administrator' };
  });
  return order.map(function (id) { return groups[id] }).filter(function (g) { return g.present });
}

/* ---------------- small helpers ---------------- */

function prop(key) { return PropertiesService.getScriptProperties().getProperty(key) }
function botToken() { return prop('BOT_TOKEN') || PASTED_BOT_TOKEN }
function appUrlSetting() {
  var url = prop('APP_URL') || DEFAULT_APP_URL;
  return /\/$/.test(url) ? url : url + '/';
}
function setProp(key, value) { PropertiesService.getScriptProperties().setProperty(key, String(value)) }
function currency() { return String(prop('CURRENCY') || 'EUR').toUpperCase() }
// A script pasted by hand has no manifest, so its time zone is the account's; Bratislava by default.
function timeZone() { return prop('TIMEZONE') || 'Europe/Bratislava' }
function today() { return Utilities.formatDate(new Date(), timeZone(), 'yyyy-MM-dd') }
