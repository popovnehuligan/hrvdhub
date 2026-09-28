// A pretend Google Apps Script world (Sheets, Drive, Telegram, …) for running
// apps-script/*.gs in Node. Only what Code.gs uses is implemented.
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { signInitDataForTests } from './sign.js';

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (arr) => Buffer.from(arr.map((b) => b & 0xff));
const toBytes = (data) => (typeof data === 'string' ? signed(Buffer.from(data, 'utf8')) : data);

export const BOT_TOKEN = '777:TEST-wishlist-token';

export function createGas({ props = {}, members = {}, pages = {} } = {}) {
  const properties = { BOT_TOKEN, ...props };
  const cache = new Map();
  const telegram = [];
  const files = new Map();
  const triggers = [];
  const sheets = new Map();

  function makeSheet(name) {
    const rows = [];
    const sheet = {
      name,
      rows,
      getLastRow: () => rows.length,
      getMaxRows: () => Math.max(1000, rows.length),
      setFrozenRows() {},
      appendRow: (row) => rows.push(row.map(String)),
      deleteRow: (index) => rows.splice(index - 1, 1),
      getRange(row, col, numRows = 1, numCols = 1) {
        return {
          setNumberFormat() { return this; },
          getValues: () =>
            Array.from({ length: numRows }, (_, r) =>
              Array.from({ length: numCols }, (_, c) => (rows[row - 1 + r] || [])[col - 1 + c] ?? ''),
            ),
          setValues(values) {
            values.forEach((vals, r) => {
              const target = (rows[row - 1 + r] ||= []);
              vals.forEach((v, c) => (target[col - 1 + c] = String(v)));
            });
            return this;
          },
        };
      },
    };
    sheets.set(name, sheet);
    return sheet;
  }

  const spreadsheet = { getSheetByName: (n) => sheets.get(n) || null, insertSheet: (n) => makeSheet(n) };

  function blob(data, type, name) {
    const bytes = toBytes(data);
    const b = { getBytes: () => bytes, getContentType: () => type, getName: () => name, setName: (n) => ((name = n), b) };
    return b;
  }

  function response(status, body, type = 'text/html') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return {
      getResponseCode: () => status,
      getContentText: () => buf.toString('utf8'),
      getContent: () => signed(buf),
      getBlob: () => blob(signed(buf), type, null),
      getHeaders: () => ({ 'Content-Type': type }),
    };
  }

  const UrlFetchApp = {
    fetch(url, options = {}) {
      const tgMatch = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
      if (tgMatch) {
        const params = options.contentType === 'application/json' ? JSON.parse(options.payload) : options.payload;
        telegram.push({ method: tgMatch[2], params });
        if (tgMatch[2] === 'getChatMember') {
          const status = members[params.user_id];
          return response(200, JSON.stringify(status ? { ok: true, result: { status } } : { ok: false, error_code: 400, description: 'Bad Request: user not found' }));
        }
        if (tgMatch[2] === 'getMe') return response(200, JSON.stringify({ ok: true, result: { username: 'horovod_wishlist_bot', first_name: 'HOROVOD Вишлист', has_main_web_app: Boolean(properties.TEST_HAS_MAIN_APP) } }));
        if (tgMatch[2] === 'getUpdates') {
          return response(200, JSON.stringify({ ok: true, result: [
            { update_id: 1, my_chat_member: { chat: { id: -100555, type: 'supergroup', title: 'HOROVOD' }, new_chat_member: { status: 'member' } } },
            { update_id: 2, message: { chat: { id: 42, type: 'private' } } },
            { update_id: 3, my_chat_member: { chat: { id: -100777, type: 'group', title: 'Old test group' }, new_chat_member: { status: 'member' } } },
            { update_id: 4, my_chat_member: { chat: { id: -100777, type: 'group', title: 'Old test group' }, new_chat_member: { status: 'left' } } },
          ] }));
        }
        return response(200, JSON.stringify({ ok: true, result: true }));
      }
      const page = pages[url];
      if (!page) return response(404, 'not found');
      return response(page.status || 200, page.body, page.type);
    },
  };

  let folderCount = 0;
  const makeFolder = (id, name) => ({
    getId: () => id,
    getName: () => name,
    createFile(b) {
      const fileId = `file${files.size + 1}abcdefghij`;
      const file = { id: fileId, blob: b, shared: false, getId: () => fileId, getBlob: () => b, setSharing() { file.shared = true; } };
      files.set(fileId, file);
      return file;
    },
  });
  const folders = new Map();

  const context = {
    console: { log() {}, warn() {}, error() {} },
    Logger: { log() {} },
    SpreadsheetApp: { getActive: () => spreadsheet, openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in properties ? properties[k] : null),
        setProperty: (k, v) => { properties[k] = v; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), removeAll() {} }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      computeHmacSha256Signature: (value, key) =>
        signed(crypto.createHmac('sha256', unsigned(key)).update(unsigned(value)).digest()),
      newBlob: blob,
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      formatDate: (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date),
    },
    UrlFetchApp,
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { VIEW: 'VIEW' },
      createFolder(name) { const id = `folder${++folderCount}`; const f = makeFolder(id, name); folders.set(id, f); return f; },
      getFolderById(id) { if (!folders.has(id)) throw new Error('no folder'); return folders.get(id); },
      getFileById(id) { if (!files.has(id)) throw new Error('no file'); return files.get(id); },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
    Session: { getScriptTimeZone: () => 'Europe/Bratislava' },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger(handler) {
        const t = { handler, getHandlerFunction: () => handler };
        const chain = { timeBased: () => chain, atHour: (h) => ((t.hour = h), chain), everyDays: () => chain, inTimezone: () => chain, create: () => (triggers.push(t), t) };
        return chain;
      },
    },
  };
  vm.createContext(context);
  const code = ['apps-script/Shared.gs', 'apps-script/Code.gs'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  vm.runInContext(code, context, { filename: 'apps-script' });

  function call(action, payload = {}, user) {
    const initData = user ? signInitDataForTests(user, BOT_TOKEN) : '';
    const out = context.doPost({ postData: { contents: JSON.stringify({ action, payload, initData }) } });
    return JSON.parse(out.text);
  }

  return { context, call, properties, telegram, files, triggers, sheets, cache, sent: (m) => telegram.filter((c) => c.method === m) };
}
