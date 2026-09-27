import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { todayIn } from '../public/lib/shared.js';
import { createAccessControl, validateInitData } from './auth.js';
import { createBot } from './bot.js';
import { HttpError, readBody, readJson, sendJson } from './http.js';
import { IMAGE_NAME, IMAGE_TYPES, imageExists, removeOrphanImages, saveImage } from './images.js';
import { cleanItemInput, newItem, normalizeLink, publicItem, userRef } from './items.js';
import { fetchLinkPreview } from './preview.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const PREVIEWS_PER_MINUTE = 20;

export function createApp(config, { telegram = new Telegram(config.botToken, config.telegramApiUrl) } = {}) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const store = new Store(config.dataDir);
  const access = createAccessControl(config, telegram);
  const bot = createBot({ config, telegram, store, access });
  const previewLog = new Map();
  const today = () => todayIn(config.timezone);

  const notify = (kind, item) =>
    Promise.resolve(bot.notify[kind](item)).catch((error) => console.error(`Notification failed: ${error.message}`));

  async function authenticate(req) {
    const header = req.headers.authorization || '';
    const session = validateInitData(header.startsWith('tma ') ? header.slice(4) : '', config.botToken);
    if (!session) throw new HttpError(401, 'Please open the wishlist from Telegram again.');
    let result;
    try {
      result = await access.check(session.user.id);
    } catch (error) {
      console.error(`Membership check failed: ${error.message}`);
      throw new HttpError(503, "Couldn't reach Telegram to check your membership. Try again in a moment.");
    }
    if (!result.allowed) throw new HttpError(403, 'This wishlist is only for HOROVOD members.');
    return { user: session.user, userId: session.user.id, isAdmin: result.admin };
  }

  function checkPreviewRate(userId) {
    const now = Date.now();
    const recent = (previewLog.get(userId) || []).filter((time) => now - time < 60_000);
    if (recent.length >= PREVIEWS_PER_MINUTE) throw new HttpError(429, 'Too many links at once. Wait a minute.');
    recent.push(now);
    previewLog.set(userId, recent);
  }

  /** "If a link is added it should add an image there." */
  async function imageFromLink(link) {
    try {
      const preview = await fetchLinkPreview(link, { uploadsDir: config.uploadsDir, allowPrivate: config.allowPrivateUrls });
      return preview.image;
    } catch {
      return null;
    }
  }

  function checkImage(patch) {
    if (patch.image && !imageExists(patch.image, config.uploadsDir)) {
      throw new HttpError(400, 'That photo is no longer here. Please add it again.');
    }
  }

  async function handleApi(req, res, url) {
    const ctx = await authenticate(req);
    const route = `${req.method} ${url.pathname}`;
    const view = (item) => publicItem(item, ctx.userId);

    if (route === 'GET /api/me') {
      return sendJson(res, 200, { user: userRef(ctx.user), isAdmin: ctx.isAdmin, currency: config.currency });
    }

    if (route === 'GET /api/items') {
      return sendJson(res, 200, { items: store.items.map(view) });
    }

    if (route === 'POST /api/items') {
      const patch = cleanItemInput(await readJson(req), { isAdmin: ctx.isAdmin, isNew: true, today: today() });
      checkImage(patch);
      const item = newItem(patch, { user: ctx.user, currency: config.currency });
      if (!item.link && !item.image) throw new HttpError(400, 'Add a photo or a link');
      if (item.link && !item.image) {
        item.image = await imageFromLink(item.link);
        if (item.image) item.imageSource = 'link';
      }
      store.insert(item);
      notify('added', item);
      return sendJson(res, 201, { item: view(item) });
    }

    if (route === 'GET /api/preview') {
      const link = normalizeLink(url.searchParams.get('url') || '');
      if (!link) throw new HttpError(400, 'Paste a link first');
      checkPreviewRate(ctx.userId);
      try {
        const preview = await fetchLinkPreview(link, { uploadsDir: config.uploadsDir, allowPrivate: config.allowPrivateUrls });
        return sendJson(res, 200, { ...preview, link, imageUrl: preview.image ? `/uploads/${preview.image}` : null });
      } catch (error) {
        console.warn(`Preview failed for ${link}: ${error.message}`);
        throw new HttpError(422, "Couldn't open that link. You can still save it, or add a photo yourself.");
      }
    }

    if (route === 'POST /api/uploads') {
      const image = saveImage(await readBody(req, MAX_UPLOAD_BYTES), config.uploadsDir);
      if (!image) throw new HttpError(415, 'Please use a JPG, PNG, WebP or GIF picture.');
      return sendJson(res, 201, { image, imageUrl: `/uploads/${image}` });
    }

    const match = url.pathname.match(/^\/api\/items\/([\w-]+)(\/vote)?$/);
    const item = match && store.get(match[1]);
    if (match && !item) throw new HttpError(404, 'That wish no longer exists.');
    const canEdit = item && (ctx.isAdmin || (item.createdBy?.id === ctx.userId && item.status === 'wanted'));

    if (match?.[2] && req.method === 'POST') {
      const index = item.votes.findIndex((vote) => vote.id === ctx.userId);
      if (index >= 0) item.votes.splice(index, 1);
      else item.votes.push({ id: ctx.userId, name: userRef(ctx.user).name });
      store.save();
      return sendJson(res, 200, { item: view(item) });
    }

    if (match && !match[2] && req.method === 'PATCH') {
      if (!canEdit) throw new HttpError(403, 'You can only edit wishes you added.');
      const patch = cleanItemInput(await readJson(req), { isAdmin: ctx.isAdmin, isNew: false, today: today() });
      checkImage(patch);
      const next = { ...item, ...patch };
      if (!next.link && !next.image) throw new HttpError(400, 'Add a photo or a link');
      if (next.link && !next.image && next.link !== item.link) {
        next.image = await imageFromLink(next.link);
        if (next.image) next.imageSource = 'link';
      }
      const becamePlanned = !item.planned && next.planned && next.status === 'wanted';
      const becameBought = item.status !== 'bought' && next.status === 'bought';
      Object.assign(item, next, { updatedAt: new Date().toISOString() });
      store.save();
      if (becamePlanned) notify('planned', item);
      if (becameBought) notify('bought', item);
      return sendJson(res, 200, { item: view(item) });
    }

    if (match && !match[2] && req.method === 'DELETE') {
      if (!canEdit) throw new HttpError(403, 'You can only delete wishes you added.');
      store.remove(item.id);
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, 'Not found');
  }

  function serveUpload(req, res, pathname) {
    const name = pathname.slice('/uploads/'.length);
    const file = path.join(config.uploadsDir, name);
    if (!IMAGE_NAME.test(name) || !fs.existsSync(file)) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': IMAGE_TYPES[name.split('.').pop()],
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(req, res, pathname) {
    let relative = 'index.html';
    if (pathname !== '/') {
      try {
        relative = decodeURIComponent(pathname.slice(1));
      } catch {
        throw new HttpError(404, 'Not found');
      }
    }
    const file = path.resolve(config.publicDir, relative);
    if (!file.startsWith(config.publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new HttpError(404, 'Not found');
    }
    const type = STATIC_TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (url.pathname.startsWith('/uploads/')) return serveUpload(req, res, url.pathname);
    return serveStatic(req, res, url.pathname);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on our side.' : error.message });
    });
  });

  const cleanupTimer = setInterval(() => removeOrphanImages(config.uploadsDir, store.items), 6 * 60 * 60_000);
  cleanupTimer.unref();

  return {
    server,
    store,
    bot,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      bot.stop();
      clearInterval(cleanupTimer);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
