// Data layer. Live: the Google Apps Script web app from config.js (every request carries
// Telegram's signed initData; the script checks it). Demo: a sample wishlist kept only in
// this browser — handy to look around before the Google side is set up.
import {
  WishError,
  applyWishPatch,
  canEditWish,
  cleanWishInput,
  localToday,
  newWish,
  publicWish,
  toggleVote,
  userRef,
} from './lib/shared.js';

const DEMO_KEY = 'horovod-wishlist-demo-v1';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/**
 * `early` is the list request index.html starts before this code has loaded
 * ({ url, initData, list: Promise<Response> }); the first list() uses its answer.
 */
export function createApi({ url, initData, telegramUser, early }) {
  return url ? liveApi(url, initData, early) : demoApi(telegramUser);
}

function liveApi(url, initData, early) {
  let earlyList = early && early.url === url && early.initData === initData ? early.list : null;

  function post(action, payload) {
    if (action === 'list' && earlyList) {
      const response = earlyList;
      earlyList = null; // an answer can be read once; retries ask again
      return response;
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // a "simple" request: no CORS preflight
      body: JSON.stringify({ action, payload, initData }),
    });
  }

  async function once(action, payload) {
    const response = await post(action, payload);
    // Google answers through a redirect that now and then returns an error page even though
    // the script ran. Such answers are worth another try.
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { retry: true });
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch {
      throw Object.assign(new Error('Сервер ответил непонятно'), { retry: true });
    }
    if (!data.ok) throw Object.assign(new Error(data.error || 'Ошибка сервера'), { status: data.status, code: data.code, bot: data.bot });
    return data.data;
  }

  async function call(action, payload = {}) {
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await once(action, payload);
      } catch (error) {
        if (!error.retry && !(error instanceof TypeError)) throw error; // "not a member" won't change on retry
        last = error;
        if (attempt < 3) await wait(800 * (attempt + 1));
      }
    }
    throw new Error(`Сервер не отвечает (${last?.message || '?'}). Попробуйте ещё раз.`);
  }

  return {
    demo: false,
    list: () => call('list'),
    // One request id per action, reused by the retries, so a lost answer can't add a wish twice.
    create: (wish) => call('create', { wish, rid: requestId() }),
    update: (id, patch) => call('update', { id, patch }),
    vote: (id) => call('vote', { id }),
    remove: (id) => call('delete', { id }),
    preview: (link) => call('preview', { url: link }),
    upload: (photo, thumb) => call('upload', { photo, thumb }),
  };
}

function demoApi(telegramUser) {
  const user = telegramUser?.id ? telegramUser : { id: 1, first_name: 'Миша' };
  const ctx = { userId: user.id, isAdmin: true };
  const today = () => localToday();
  let wishes = [];
  const loaded = (async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (Array.isArray(saved)) return saved;
    } catch {
      // storage unavailable: start from the sample
    }
    // Loaded only in demo mode, so the live app doesn't wait for it. Same ?v= as this file.
    const { demoWishes } = await import(`./demo/wishes.js${new URL(import.meta.url).search}`);
    return demoWishes(today());
  })().then((list) => {
    wishes = list;
  });
  const persist = () => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(wishes));
    } catch {
      // private mode: changes last until the page is closed
    }
  };
  const view = (wish) => publicWish(wish, user.id, (ref) => ref);
  const find = (id) => {
    const wish = wishes.find((w) => w.id === id);
    if (!wish) throw new WishError('Этого желания больше нет', 404);
    return wish;
  };
  const replace = (wish) => {
    wishes = wishes.map((w) => (w.id === wish.id ? wish : w));
    persist();
    return { item: view(wish) };
  };

  return {
    demo: true,
    async list() {
      await loaded;
      return { me: { user: userRef(user), isAdmin: true, currency: 'EUR' }, items: wishes.map(view) };
    },
    async create(input) {
      await loaded;
      const wish = newWish(cleanWishInput(input, { ...ctx, isNew: true, today: today() }), { user, currency: 'EUR' });
      if (!wish.link && !wish.image) throw new WishError('Добавьте фото или ссылку');
      wishes.unshift(wish);
      persist();
      return { item: view(wish) };
    },
    async update(id, input) {
      await loaded;
      const current = find(id);
      if (!canEditWish(current, ctx)) throw new WishError('Можно менять только свои желания', 403);
      return replace(applyWishPatch(current, cleanWishInput(input, { ...ctx, isNew: false, today: today() })).wish);
    },
    async vote(id) {
      await loaded;
      return replace(toggleVote(find(id), user));
    },
    async remove(id) {
      await loaded;
      find(id);
      wishes = wishes.filter((w) => w.id !== id);
      persist();
      return { ok: true };
    },
    async preview() {
      throw new WishError('В демо-режиме ссылки не открываются — картинка подтянется, когда вишлист подключат к Google');
    },
    async upload(photo) {
      return { image: photo, imageUrl: photo };
    },
  };
}
