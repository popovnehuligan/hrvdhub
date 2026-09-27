import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { signInitData } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

export const BOT_TOKEN = '123456:TEST-token-for-automated-tests-only';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG: `paint(x, y)` returns [r, g, b]. */
export function makePng(width, height, paint) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) row.set(paint(x, y), 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const noisyPng = () =>
  makePng(48, 48, (x, y) => [(x * 37 + y * 11) % 256, (x * y * 7) % 256, (x * 5 + y * 91) % 256]);

/** Stand-in for the Telegram API that records every call. */
export function fakeTelegram({ members = {} } = {}) {
  const calls = [];
  return {
    calls,
    sent: (method) => calls.filter((call) => call.method === method),
    async call(method, params = {}) {
      calls.push({ method, params });
      if (method === 'getMe') return { id: 42, is_bot: true, username: 'horovod_test_bot' };
      if (method === 'getChatMember') {
        const status = members[params.user_id];
        if (!status) {
          const error = new Error('Bad Request: user not found');
          error.code = 400;
          throw error;
        }
        return { status, user: { id: params.user_id } };
      }
      return true;
    },
    async upload(method, params, field, file) {
      calls.push({ method, params, field, file });
      return true;
    },
  };
}

export function initDataFor(user, { authDate = Math.floor(Date.now() / 1000) } = {}) {
  return signInitData({ auth_date: authDate, query_id: 'AAE-test', user }, BOT_TOKEN);
}

export async function startApp(env = {}, telegramOptions) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishlist-test-'));
  const config = loadConfig({
    BOT_TOKEN,
    DATA_DIR: dataDir,
    BOT_POLLING: 'false',
    ALLOW_PRIVATE_URLS: 'true',
    ...env,
  });
  const telegram = fakeTelegram(telegramOptions);
  const app = createApp(config, { telegram });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  const as = (user) => async (method, url, body, headers = {}) => {
    const options = { method, headers: { Authorization: `tma ${initDataFor(user)}`, ...headers } };
    if (Buffer.isBuffer(body)) {
      options.body = body;
    } else if (body !== undefined) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(base + url, options);
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  return {
    app,
    config,
    telegram,
    base,
    as,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A tiny fake shop on localhost. `pages` maps paths to { status, type, body }. */
export async function startShop(pages) {
  const server = http.createServer((req, res) => {
    const page = pages[req.url];
    if (!page) {
      res.writeHead(404).end('not found');
      return;
    }
    if (page.redirect) {
      res.writeHead(302, { Location: page.redirect }).end();
      return;
    }
    res.writeHead(page.status || 200, { 'Content-Type': page.type || 'text/html; charset=utf-8' });
    res.end(page.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}
