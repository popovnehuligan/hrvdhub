import {
  CATEGORIES,
  PRIORITIES,
  SORTS,
  addMonths,
  compareItems,
  describePlan,
  findOption,
  formatDay,
  formatMoney,
  formatShortMonth,
  groupBought,
  groupPlan,
  hostOf,
  isValidDate,
  itemTotal,
  localToday,
  plural,
  sumTotals,
} from './lib/shared.js';
import { createApi } from './api.js';

const tg = window.Telegram?.WebApp;
const initData = tg?.initData || new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';
const API = createApi({
  url: window.WISHLIST_CONFIG?.API || '',
  initData,
  telegramUser: tg?.initDataUnsafe?.user,
  early: window.WISHLIST_EARLY, // the list request index.html has already started
});
const today = () => localToday();

const state = {
  me: null,
  items: [],
  loaded: false,
  error: null,
  tab: 'wishlist',
  category: 'all',
  query: '',
  sort: 'schedule',
  showDropped: false,
};

const currency = () => state.me?.currency || 'EUR';
const money = (amount) => formatMoney(amount, currency());
const isAdmin = () => Boolean(state.me?.isAdmin);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Builds DOM nodes. Children are text or nodes, never HTML, so user text is always safe. */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Like node.replaceChildren, but skips null/false so conditional pieces can be passed directly. */
function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((child) => child != null && child !== false));
}

/** Wraps a click handler so tapping a button inside a card doesn't also open the card. */
const stop = (handler) => (event) => {
  event.stopPropagation();
  handler(event);
};

const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred?.('light'),
  success: () => tg?.HapticFeedback?.notificationOccurred?.('success'),
  error: () => tg?.HapticFeedback?.notificationOccurred?.('error'),
};

const supports = (version) => Boolean(tg?.isVersionAtLeast?.(version));

function openExternal(url) {
  if (tg?.openLink && supports('6.1')) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** The bot's chat, where «Старт» introduces the person to the bot. Closes the app: it reopens from that chat. */
function openBotChat(bot) {
  const link = `https://t.me/${bot || 'hrvd_wishlist_bot'}?start=hello`;
  if (tg?.openTelegramLink && supports('6.1')) {
    tg.openTelegramLink(link);
    tg.close?.();
  } else window.open(link, '_blank', 'noopener');
}

function confirmAction(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm && supports('6.2')) tg.showConfirm(message, (ok) => resolve(ok));
    else resolve(window.confirm(message));
  });
}

let toastTimer;
function toast(message, kind = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
  }, 2800);
}

// ---------------------------------------------------------------------------
// Bottom sheets (with Telegram's back button)
// ---------------------------------------------------------------------------

const sheets = [];

function syncBackButton() {
  if (!tg?.BackButton || !supports('6.1')) return;
  if (sheets.length) tg.BackButton.show();
  else tg.BackButton.hide();
}
if (tg?.BackButton && supports('6.1')) tg.BackButton.onClick(() => sheets.at(-1)?.close());

/**
 * Opens a sheet. `render(sheet)` returns its content. Sheets marked `live`
 * are re-rendered whenever the data changes.
 */
function openSheet({ title = '', render, live = false, tall = false }) {
  const body = h('div', { class: 'sheet-body' });
  const panel = h(
    'div',
    { class: `sheet${tall ? ' tall' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Подробнее' },
    h(
      'header',
      { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Закрыть', onclick: () => sheet.close() }, '✕'),
    ),
    body,
  );
  const overlay = h('div', { class: 'overlay', onclick: (event) => event.target === overlay && sheet.close() }, panel);
  const sheet = {
    live,
    ui: {},
    refresh() {
      fill(body, render(sheet));
    },
    close() {
      const index = sheets.indexOf(sheet);
      if (index === -1) return;
      sheets.splice(index, 1);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 220);
      document.body.classList.toggle('locked', sheets.length > 0);
      syncBackButton();
    },
  };
  sheet.refresh();
  document.getElementById('sheets').append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  sheets.push(sheet);
  document.body.classList.add('locked');
  syncBackButton();
  return sheet;
}

// ---------------------------------------------------------------------------
// Data changes
// ---------------------------------------------------------------------------

function refreshAll() {
  forgetGoneCards();
  renderData();
  for (const sheet of sheets) if (sheet.live) sheet.refresh();
}

/**
 * Changes made on this device that a list answer might not include yet (Google takes
 * seconds, so the answer may have been read before them): id → { seq, item, pending }.
 * `item` is null once deleted; `pending` while a vote is still on its way.
 */
const edits = new Map();
let editSeq = 0;

function noteEdit(id, item, pending = false) {
  edits.set(id, { seq: ++editSeq, item, pending });
}

/** A list answer, with this device's newer changes laid over it. */
function withLocalEdits(items, since) {
  const newer = new Map();
  for (const [id, edit] of edits) {
    if (edit.seq > since || edit.pending) newer.set(id, edit.item);
    else edits.delete(id); // made before the request: the answer has it
  }
  if (!newer.size) return items;
  const merged = items.filter((item) => !newer.has(item.id) || newer.get(item.id)).map((item) => newer.get(item.id) || item);
  for (const [id, item] of newer) if (item && !merged.some((other) => other.id === id)) merged.unshift(item);
  return merged;
}

function upsert(item) {
  noteEdit(item.id, item);
  const index = state.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) state.items[index] = item;
  else state.items.unshift(item);
  refreshAll();
  saveSnapshot();
}

// ---------------------------------------------------------------------------
// The last list seen, kept on this device: the app opens with it at once and
// swaps in Google's answer when it comes (seconds; much longer when cold).
// ---------------------------------------------------------------------------

const SNAPSHOT_PREFIX = 'horovod-wishlist-snapshot-v1 ';
// Per script address and person: another deployment or account never sees this copy.
const snapshotKey = `${SNAPSHOT_PREFIX}${window.WISHLIST_CONFIG?.API || ''} ${tg?.initDataUnsafe?.user?.id || ''}`;

function readSnapshot() {
  if (API.demo) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(snapshotKey));
    if (saved?.me && Array.isArray(saved.items)) return saved;
  } catch {
    // no storage here: open the slow way
  }
  return null;
}

function saveSnapshot() {
  if (API.demo || !state.loaded) return;
  const isData = (value) => typeof value === 'string' && value.startsWith('data:');
  // Pictures stay addresses; a photo's bytes would crowd out the storage.
  const items = state.items.map((item) => (isData(item.image) || isData(item.imageUrl) ? { ...item, image: null, imageUrl: null } : item));
  try {
    localStorage.setItem(snapshotKey, JSON.stringify({ me: state.me, items, savedAt: new Date().toISOString() }));
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(SNAPSHOT_PREFIX) && key !== snapshotKey) localStorage.removeItem(key); // an older address's copy
    }
  } catch {
    // full or unavailable: next time opens the slow way
  }
}

function dropSnapshot() {
  try {
    localStorage.removeItem(snapshotKey);
  } catch {
    // nothing saved then
  }
}

/** "обновляется…" in the header while Google is asked; one node, so showing it redraws nothing. */
const syncBadge = h('span', { class: 'top-sync', hidden: true }, 'обновляется…');

function setSyncing(on) {
  syncBadge.hidden = !on;
}

let syncing = null;

/**
 * Asks Google for the list and shows it; one request at a time. `quiet`: if it fails,
 * keep showing what's there without a word (used when the app comes back to the front).
 */
function sync({ quiet = false } = {}) {
  syncing ||= pull(quiet).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function pull(quiet) {
  const since = editSeq;
  setSyncing(true);
  try {
    const { me, items } = await API.list();
    setSyncing(false);
    const merged = withLocalEdits(items, since);
    const changed = !state.loaded || JSON.stringify([me, merged]) !== JSON.stringify([state.me, state.items]);
    Object.assign(state, { me, items: merged, loaded: true });
    if (!changed) return; // the same list as on screen (and saved): nothing moves
    saveSnapshot();
    refreshAll();
  } catch (error) {
    setSyncing(false);
    const refused = error.code === 'meet_bot' || error.status === 403;
    if (refused) dropSnapshot();
    if (!state.loaded || refused || error.status === 401) showLoadError(error);
    else if (!quiet) toast('Не удалось обновить — показан сохранённый список', 'error');
  }
}

function showLoadError(error) {
  for (const sheet of [...sheets]) sheet.close();
  Object.assign(state, { me: null, items: [], loaded: false });
  state.error =
    error.code === 'meet_bot'
      ? {
          title: 'Познакомьтесь с ботом',
          text: `${error.message} Нажмите кнопку ниже, в чате с ботом нажмите «Старт» и откройте вишлист снова.`,
          action: h('button', { type: 'button', class: 'button primary', onclick: () => openBotChat(error.bot) }, 'Познакомиться с ботом'),
        }
      : error.status === 403
        ? { emoji: '🔒', title: 'Только для своих', text: `${error.message} Попросите админа добавить вас в группу HOROVOD.` }
        : { title: 'Не удалось загрузить вишлист', text: error.message, retry: true };
  render();
}

/** What happened to the group post, for the toast after a save. */
function postedNote(posted) {
  if (posted === true) return ' · в группе';
  if (posted === false) return ' · в группу не ушло';
  return '';
}

async function save(id, patch, message) {
  try {
    const { item, posted } = await API.update(id, patch);
    upsert(item);
    haptic.success();
    if (message) toast(message + postedNote(posted), posted === false ? 'error' : 'info');
    return { item, posted };
  } catch (error) {
    haptic.error();
    toast(error.message, 'error');
    throw error;
  }
}

async function toggleVote(id) {
  // By id: the card may have been drawn from an older copy of the list.
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  haptic.tap();
  const before = { votes: item.votes, voted: item.voted, voters: item.voters };
  item.voted = !item.voted;
  item.votes += item.voted ? 1 : -1;
  noteEdit(id, item, true);
  refreshAll();
  try {
    const { item: updated } = await API.vote(id);
    upsert(updated);
  } catch (error) {
    Object.assign(item, before);
    edits.delete(id);
    refreshAll();
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Pieces used in several places
// ---------------------------------------------------------------------------

/** If Google's picture address fails, try Drive's other public address once, at the same size. */
function driveFallback(event) {
  const src = event.target.getAttribute('src');
  const match = /lh3\.googleusercontent\.com\/d\/([\w-]+)(?:=w(\d+))?/.exec(src);
  if (match) event.target.src = `https://drive.google.com/thumbnail?id=${match[1]}&sz=w${match[2] || 1000}`;
}

// Cards are about 170px wide (×3 on a phone screen), so they ask Google for a ~480px copy
// instead of the 1000px one the details show. Shop pictures come as they are.
const CARD_WIDTH = 480;

function sizedImage(url, width) {
  const match = /^(https:\/\/lh3\.googleusercontent\.com\/d\/[\w-]+)(=w\d+)?$/.exec(url || '');
  if (match) return `${match[1]}=w${width}`;
  // Photos kept by our server: it has a small copy for the cards.
  const ours = /^(https:\/\/[^/]+\/photo\/[\w-]+)(\?w=\d+)?$/.exec(url || '');
  return ours ? (width <= 600 ? `${ours[1]}?w=${width}` : ours[1]) : url;
}

/** Pictures already shown here: drawn again, they appear at once instead of waiting to be lazy-loaded. */
const loadedImages = new Set();

// Card pictures load once they come within ~300px of the screen. The browser's own
// loading="lazy" starts 1250–2500px ahead, which on a phone is nearly the whole list.
const nearScreen = (() => {
  if (!('IntersectionObserver' in window)) return null;
  const show = (entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.src = entry.target.dataset.src;
    }
  };
  const options = { rootMargin: '300px 0px' };
  try {
    return new IntersectionObserver(show, { ...options, root: document }); // the margin counts inside Telegram's iframe too
  } catch {
    return new IntersectionObserver(show, options);
  }
})();

function picture(src, { lazy = true } = {}) {
  const later = lazy && !loadedImages.has(src);
  const img = h('img', {
    loading: later && !nearScreen ? 'lazy' : null, // before src, so it counts
    decoding: 'async',
    src: later && nearScreen ? null : src,
    'data-src': later && nearScreen ? src : null,
    alt: '',
    onload: (event) => loadedImages.add(event.target.getAttribute('src')),
    onerror: driveFallback,
  });
  if (later && nearScreen) nearScreen.observe(img);
  return img;
}

function thumb(item, { hero = false } = {}) {
  const base = hero ? 'hero' : 'thumb';
  if (item.imageUrl) {
    const full = item.imageUrl;
    const small = sizedImage(full, CARD_WIDTH);
    let src = hero ? full : small;
    let sharpen = false;
    // Details open with the card's small copy (already here) and sharpen once the big one loads.
    if (hero && src !== small && !loadedImages.has(full) && loadedImages.has(small)) {
      src = small;
      sharpen = true;
    }
    const img = picture(src, { lazy: !hero });
    if (sharpen) {
      const big = new Image();
      big.onload = () => {
        loadedImages.add(full);
        img.src = full;
      };
      big.src = full;
    }
    return h('div', { class: `${base}${item.imageSource === 'upload' ? ' cover' : ''}` }, img);
  }
  return h(
    'div',
    { class: `${base} placeholder` },
    h('span', { class: 'eye placeholder-eye', 'aria-hidden': 'true' }),
    item.link ? h('span', { class: 'placeholder-host' }, hostOf(item.link)) : null,
  );
}

function metaLine(item) {
  const category = findOption(CATEGORIES, item.category);
  const priority = findOption(PRIORITIES, item.priority);
  return h(
    'div',
    { class: 'meta' },
    category.label,
    h('span', { class: 'sep' }, '·'),
    h('span', { class: priority.id === 'must' ? 'must' : '' }, priority.label),
  );
}

function planText(plan) {
  return plan.tone === 'nodate' ? ' · дата не выбрана' : ` · ${plan.detail}`;
}

const SVG = 'http://www.w3.org/2000/svg';

/** The vote heart: a rounded, slightly chunky outline that fills in once you've voted. */
function heartIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'heart');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    'M12 20.2c-.3 0-.6-.1-.8-.3C7.4 16.8 3.2 13.4 3.2 8.9 3.2 6.1 5.3 4 7.9 4c1.7 0 3.2.9 4.1 2.3C12.9 4.9 14.4 4 16.1 4c2.6 0 4.7 2.1 4.7 4.9 0 4.5-4.2 7.9-8 11-.2.2-.5.3-.8.3Z',
  );
  svg.append(path);
  return svg;
}

function voteButton(item, { withLabel = false } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: `vote${item.voted ? ' voted' : ''}`,
      'aria-pressed': String(item.voted),
      'aria-label': item.voted ? 'Убрать голос' : 'Проголосовать',
      onclick: stop(() => toggleVote(item.id)),
    },
    heartIcon(),
    withLabel ? h('span', {}, item.voted ? 'Вам нравится' : 'Нравится') : null,
    item.votes ? h('span', { class: 'vote-count' }, item.votes) : null,
  );
}

/**
 * Built cards ("kind id" → { key, node }), used again while their wish looks the same:
 * a vote or Google's answer then rebuilds only the cards that changed, and the other
 * pictures stay put instead of blinking.
 */
const cards = new Map();

function card(kind, item, build) {
  const key = `${today()} ${currency()} ${JSON.stringify(item)}`;
  const slot = `${kind} ${item.id}`;
  const built = cards.get(slot);
  if (built?.key === key) return built.node;
  const node = build(item);
  cards.set(slot, { key, node });
  return node;
}

function forgetGoneCards() {
  const ids = new Set(state.items.map((item) => item.id));
  for (const slot of cards.keys()) if (!ids.has(slot.slice(slot.indexOf(' ') + 1))) cards.delete(slot);
}

/** Wishlist grid tile: picture first, the plan date and votes sit on the picture. */
function tile(item) {
  const plan = describePlan(item, today());
  const total = itemTotal(item);
  return h(
    'article',
    {
      class: 'tile',
      tabindex: '0',
      onclick: () => openDetail(item.id),
      onkeydown: (event) => event.key === 'Enter' && openDetail(item.id),
    },
    h(
      'div',
      { class: 'tile-media' },
      thumb(item),
      plan ? h('span', { class: `tile-badge tone-${plan.tone}` }, plan.tone === 'nodate' ? 'В плане' : `${plan.label}`) : null,
      voteButton(item),
    ),
    h(
      'div',
      { class: 'tile-body' },
      metaLine(item),
      h('h3', { class: 'tile-title' }, item.title),
      h(
        'div',
        { class: 'tile-price' },
        total != null ? money(total) : h('span', { class: 'muted' }, 'Цена не указана'),
        total != null && item.quantity > 1 ? h('small', {}, ` · ${item.quantity} шт.`) : null,
      ),
    ),
  );
}

/** Compact row for the plan and purchases: picture, name, when, price. */
function row(item, { when, tone, price }) {
  return h(
    'article',
    {
      class: 'row',
      tabindex: '0',
      onclick: () => openDetail(item.id),
      onkeydown: (event) => event.key === 'Enter' && openDetail(item.id),
    },
    thumb(item),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, item.title),
      h('div', { class: `row-when${tone ? ` tone-text-${tone}` : ''}` }, when),
    ),
    h('div', { class: 'row-price' }, price != null ? money(price) : '—'),
  );
}

function planRow(item) {
  const plan = describePlan(item, today());
  let when = `${plan.label} · ${plan.short}`;
  if (plan.tone === 'nodate') when = 'Дата не выбрана';
  else if (item.plannedPrecision === 'month') when = plan.label;
  return row(item, { when, tone: plan.tone === 'overdue' ? 'overdue' : null, price: itemTotal(item) });
}

function statusText(item) {
  if (item.status === 'bought') return item.boughtAt ? `Куплено ${formatDay(item.boughtAt, today())}` : 'Куплено';
  if (item.status === 'dropped') return 'Отменено';
  return '';
}

// The first argument used to be an emoji; every empty state now shows the HOROVOD eye.
function emptyState(_icon, title, text, action) {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'eye empty-eye', 'aria-hidden': 'true' }),
    h('h3', {}, title),
    h('p', {}, text),
    action || null,
  );
}

function groupHead(title, { note, tone, total, missing, prefix = '' }) {
  return h(
    'div',
    { class: 'group-head' },
    h(
      'div',
      { class: 'group-title' },
      h('span', { class: tone ? `tone-text-${tone}` : '' }, title),
      note ? h('span', { class: 'group-note' }, note) : null,
    ),
    h(
      'div',
      { class: 'group-total' },
      total ? `${prefix}${money(total)}` : '',
      missing ? h('small', {}, `${total ? ' + ' : ''}${missing} без цены`) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function header() {
  const wanted = state.items.filter((item) => item.status === 'wanted');
  const planned = wanted.filter((item) => item.planned);
  const { total } = sumTotals(planned);
  return h(
    'header',
    { class: 'top' },
    h(
      'div',
      { class: 'top-brand' },
      h('span', { class: 'eye', 'aria-hidden': 'true' }),
      h('span', { class: 'kicker' }, 'HOROVOD · Хаб'),
      syncBadge,
    ),
    h('h1', {}, 'Вишлист'),
    API.demo ? h('p', { class: 'demo-note' }, 'Демо-режим: пример данных, изменения видны только на этом устройстве') : null,
    h(
      'p',
      { class: 'top-sub' },
      `${wanted.length} ${plural(wanted.length, 'желание', 'желания', 'желаний')} · ${planned.length} в плане`,
      total ? ` · ${money(total)}` : '',
    ),
    nextPurchase(planned),
  );
}

function nextPurchase(planned) {
  const next = planned.filter((item) => item.plannedDate).sort(compareItems('schedule'))[0];
  return next ? card('next', next, nextButton) : null;
}

function nextButton(next) {
  const plan = describePlan(next, today());
  const total = itemTotal(next);
  return h(
    'button',
    { type: 'button', class: 'next', onclick: () => openDetail(next.id) },
    thumb(next),
    h(
      'span',
      { class: 'next-main' },
      h('span', { class: 'next-kicker' }, plan.tone === 'overdue' ? 'Пора купить' : 'Ближайшая покупка'),
      h('span', { class: 'next-title' }, next.title),
      h('span', { class: `next-when tone-${plan.tone}` }, `${plan.label} · ${plan.short}`),
    ),
    total != null ? h('span', { class: 'next-price' }, money(total)) : null,
  );
}

function tabs() {
  const counts = {
    wishlist: state.items.filter((item) => item.status === 'wanted').length,
    plan: state.items.filter((item) => item.status === 'wanted' && item.planned).length,
    bought: state.items.filter((item) => item.status === 'bought').length,
  };
  const list = [
    { id: 'wishlist', label: 'Желания' },
    { id: 'plan', label: 'План' },
    { id: 'bought', label: 'Куплено' },
  ];
  return h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    list.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'tab',
          'aria-selected': String(state.tab === tab.id),
          onclick: () => {
            state.tab = tab.id;
            haptic.tap();
            render();
            window.scrollTo(0, 0);
          },
        },
        tab.label,
        h('span', { class: 'count' }, counts[tab.id]),
      ),
    ),
  );
}

function toolbar() {
  return h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'search-row' },
      h('input', {
        type: 'search',
        class: 'search',
        placeholder: 'Поиск',
        'aria-label': 'Поиск',
        value: state.query,
        oninput: (event) => {
          state.query = event.target.value;
          renderContent();
        },
      }),
      h(
        'select',
        {
          class: 'sort',
          'aria-label': 'Сортировка',
          onchange: (event) => {
            state.sort = event.target.value;
            render();
          },
        },
        SORTS.map((sort) => h('option', { value: sort.id, selected: sort.id === state.sort }, sort.label)),
      ),
    ),
    h(
      'div',
      { class: 'chips scroll' },
      [{ id: 'all', emoji: '', label: 'Все' }, ...CATEGORIES].map((category) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${state.category === category.id ? ' selected' : ''}`,
            'aria-pressed': String(state.category === category.id),
            onclick: () => {
              state.category = category.id;
              haptic.tap();
              render();
            },
          },
          category.label,
        ),
      ),
    ),
  );
}

function wishlistContent() {
  const wanted = state.items.filter((item) => item.status === 'wanted');
  if (!wanted.length) {
    return emptyState(
      '🎸',
      'Пока пусто',
      'Добавьте первое, что нужно HOROVOD. Достаточно фото или ссылки на магазин.',
      h('button', { type: 'button', class: 'button primary', onclick: () => openForm() }, '+ Добавить'),
    );
  }
  const query = state.query.trim().toLowerCase();
  const list = wanted
    .filter((item) => state.category === 'all' || item.category === state.category)
    .filter((item) => !query || `${item.title} ${item.note} ${hostOf(item.link)}`.toLowerCase().includes(query))
    .sort(compareItems(state.sort));
  if (!list.length) return emptyState('🔍', 'Ничего не найдено', 'Попробуйте другой запрос или категорию.');
  return h('div', { class: 'tiles' }, list.map((item) => card('tile', item, tile)));
}

function planContent() {
  const groups = groupPlan(state.items, today());
  if (!groups.length) {
    return emptyState(
      '🗓',
      'Пока ничего не запланировано',
      isAdmin()
        ? 'Нажмите «Запланировать» на желании и выберите, когда покупаем. Здесь появится план по месяцам.'
        : 'Когда мы решим что-то купить, это появится здесь с датой.',
    );
  }
  const planned = groups.flatMap((group) => group.items);
  const { total, missing } = sumTotals(planned);
  const month = today().slice(0, 7);
  const soon = sumTotals(groups.filter((group) => group.key === month || group.key === 'overdue').flatMap((group) => group.items));
  return [
    h(
      'div',
      { class: 'summary' },
      h('div', {}, h('div', { class: 'summary-label' }, 'Запланировано'), h('div', { class: 'summary-value' }, money(total))),
      h(
        'div',
        { class: 'summary-side' },
        h('div', {}, `${planned.length} ${plural(planned.length, 'позиция', 'позиции', 'позиций')}`),
        soon.total ? h('div', {}, `${money(soon.total)} в этом месяце`) : null,
        missing ? h('div', {}, `${missing} без цены`) : null,
      ),
    ),
    groups.map((group) =>
      h(
        'section',
        { class: 'group' },
        groupHead(group.title, {
          note: group.note,
          tone: group.key === 'overdue' ? 'overdue' : group.note === 'В этом месяце' ? 'soon' : null,
          total: group.total,
          missing: group.missing,
        }),
        h('div', { class: 'rows' }, group.items.map((item) => card('plan', item, planRow))),
      ),
    ),
  ];
}

function boughtContent() {
  const groups = groupBought(state.items);
  const dropped = state.items.filter((item) => item.status === 'dropped');
  const year = today().slice(0, 4);
  const spentThisYear = sumTotals(
    groups.filter((group) => group.key.startsWith(year)).flatMap((group) => group.items),
    (item) => item.boughtPrice ?? itemTotal(item),
  );
  const content = [];
  if (!groups.length) {
    content.push(emptyState('🛍', 'Пока ничего не куплено', 'Здесь будут покупки и сколько мы потратили.'));
  } else {
    content.push(
      h(
        'div',
        { class: 'summary' },
        h(
          'div',
          {},
          h('div', { class: 'summary-label' }, `Потрачено в ${year}`),
          h('div', { class: 'summary-value' }, money(spentThisYear.total)),
        ),
      ),
      groups.map((group) =>
        h(
          'section',
          { class: 'group' },
          groupHead(group.title, { total: group.total, missing: group.missing, prefix: '' }),
          h(
            'div',
            { class: 'rows' },
            group.items.map((item) =>
              card('bought', item, () =>
                row(item, {
                  when: item.boughtAt ? `Куплено ${formatDay(item.boughtAt, today())}` : 'Куплено',
                  price: item.boughtPrice ?? itemTotal(item),
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (dropped.length) {
    content.push(
      h(
        'button',
        {
          type: 'button',
          class: 'button ghost block dropped-toggle',
          onclick: () => {
            state.showDropped = !state.showDropped;
            render();
          },
        },
        `${state.showDropped ? 'Скрыть' : 'Показать'} отменённые (${dropped.length})`,
      ),
      state.showDropped
        ? h('div', { class: 'rows' }, dropped.map((item) => card('dropped', item, () => row(item, { when: 'Отменено', price: itemTotal(item) }))))
        : null,
    );
  }
  return content;
}

function content() {
  if (state.tab === 'plan') return planContent();
  if (state.tab === 'bought') return boughtContent();
  return wishlistContent();
}

function renderContent() {
  const node = document.getElementById('content');
  if (node) fill(node, content());
}

/** After a data change: redraws what shows the data, leaving the search box alone (typing, the keyboard). */
function renderData() {
  const app = document.getElementById('app');
  const top = app.querySelector('.top');
  const nav = app.querySelector('.tabs');
  if (state.error || !state.loaded || !top || !nav) return render();
  top.replaceWith(header());
  nav.replaceWith(tabs());
  renderContent();
}

function render() {
  const app = document.getElementById('app');
  if (state.error) {
    fill(app, 
      emptyState(
        state.error.emoji || '⚠️',
        state.error.title,
        state.error.text,
        state.error.action ||
          (state.error.retry
            ? h('button', { type: 'button', class: 'button primary', onclick: () => location.reload() }, 'Попробовать снова')
            : null),
      ),
    );
    return;
  }
  if (!state.loaded) {
    fill(app, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    return;
  }
  fill(app, 
    header(),
    tabs(),
    state.tab === 'wishlist' ? toolbar() : null,
    h('main', { id: 'content' }, content()),
    h('button', { type: 'button', class: 'fab', onclick: () => openForm() }, '+ Добавить'),
  );
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Month chips for the next 12 months, an exact-day picker and "not sure yet".
 * `onPick` gets { plannedDate, plannedPrecision }.
 */
function planPicker({ current, onPick, confirmDay = false, pending = null }) {
  const now = today();
  const months = Array.from({ length: 12 }, (_, index) => addMonths(now, index));
  // While a choice is being saved, it shows as chosen right away and the rest waits.
  const shown = pending ? { planned: true, ...pending } : current;
  const selectedMonth = shown?.planned && shown.plannedPrecision === 'month' ? shown.plannedDate : null;
  const selectedDay = shown?.planned && shown.plannedPrecision === 'day' ? shown.plannedDate : '';
  const busy = Boolean(pending);
  const saving = (selected) => (busy && selected ? [h('span', { class: 'spinner small' }), ' '] : null);

  const dayInput = h('input', {
    type: 'date',
    min: now,
    value: selectedDay,
    disabled: busy,
    'aria-label': 'Точная дата',
    onchange: (event) => {
      if (confirmDay) setDay.disabled = !isValidDate(event.target.value);
      else if (isValidDate(event.target.value)) onPick({ plannedDate: event.target.value, plannedPrecision: 'day' });
    },
  });
  const setDay = h(
    'button',
    {
      type: 'button',
      class: 'button primary',
      disabled: busy || !isValidDate(selectedDay),
      onclick: () => isValidDate(dayInput.value) && onPick({ plannedDate: dayInput.value, plannedPrecision: 'day' }),
    },
    saving(Boolean(selectedDay)),
    busy && selectedDay ? 'Сохраняю…' : 'Выбрать',
  );

  return h(
    'div',
    { class: 'plan-picker' },
    busy ? h('p', { class: 'plan-status' }, h('span', { class: 'spinner small' }), ' Сохраняю и отправляю в группу…') : null,
    h('div', { class: 'picker-label' }, 'В каком месяце?'),
    h(
      'div',
      { class: 'month-grid' },
      months.map((month, index) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${selectedMonth === month ? ' selected' : ''}`,
            disabled: busy,
            onclick: () => onPick({ plannedDate: month, plannedPrecision: 'month' }),
          },
          saving(selectedMonth === month),
          index === 0 ? 'Этот месяц' : index === 1 ? 'Следующий' : formatShortMonth(month, now),
        ),
      ),
    ),
    h('div', { class: 'picker-label' }, 'Или точная дата'),
    h('div', { class: 'day-row' }, dayInput, confirmDay ? setDay : null),
    h(
      'button',
      {
        type: 'button',
        class: `chip wide${shown?.planned && !shown.plannedDate ? ' selected' : ''}`,
        disabled: busy,
        onclick: () => onPick({ plannedDate: null, plannedPrecision: null }),
      },
      saving(shown?.planned && !shown.plannedDate),
      'Пока не знаем — просто в план',
    ),
  );
}

function planSection(item, sheet) {
  const plan = describePlan(item, today());
  const bigDate = plan
    ? h(
        'div',
        { class: `plan-big tone-text-${plan.tone}` },
        h('b', {}, plan.label),
        plan.tone === 'nodate' ? ' · дата не выбрана' : ` · ${plan.detail}`,
      )
    : null;

  if (!isAdmin()) {
    return h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-label' }, 'Планируем купить'),
      bigDate || h('div', { class: 'muted' }, 'Пока не в плане. Голосуйте, если нужно!'),
    );
  }

  const switchedOn = item.planned || sheet.ui.picking;
  const showPicker = sheet.ui.picking || (switchedOn && !item.planned);
  return h(
    'section',
    { class: 'panel' },
    h(
      'label',
      { class: 'switch-row' },
      h(
        'span',
        { class: 'switch-text' },
        h('b', {}, 'Планируем купить'),
        h('small', {}, item.planned ? 'Это в плане покупок' : 'Включите и выберите когда'),
      ),
      h('input', {
        type: 'checkbox',
        role: 'switch',
        class: 'switch',
        checked: switchedOn,
        onchange: async (event) => {
          haptic.tap();
          if (event.target.checked) {
            sheet.ui.picking = true;
            sheet.refresh();
            return;
          }
          sheet.ui.picking = false;
          sheet.ui.planned = null;
          if (item.planned) await save(item.id, { planned: false }, 'Убрано из плана').catch(() => {});
          sheet.refresh();
        },
      }),
    ),
    sheet.ui.planned && item.planned && !showPicker
      ? h('p', { class: `plan-done${sheet.ui.planned.posted === false ? ' warn' : ''}` },
          sheet.ui.planned.posted === false
            ? '✓ Запланировано. Сообщение в группу не отправилось'
            : sheet.ui.planned.posted
              ? '✓ Запланировано. Сообщение отправлено в группу'
              : '✓ Запланировано')
      : null,
    item.planned && !showPicker
      ? h(
          'div',
          { class: 'plan-current' },
          bigDate,
          h(
            'button',
            {
              type: 'button',
              class: 'button small',
              onclick: () => {
                sheet.ui.picking = true;
                sheet.ui.planned = null;
                sheet.refresh();
              },
            },
            'Изменить',
          ),
        )
      : null,
    showPicker
      ? planPicker({
          current: item,
          confirmDay: true,
          pending: sheet.ui.pending,
          onPick: async (value) => {
            if (sheet.ui.pending) return;
            haptic.tap();
            sheet.ui.pending = value;
            sheet.refresh();
            try {
              const { posted } = await save(item.id, { planned: true, ...value }); // the panel says the rest
              toast('Запланировано');
              sheet.ui.picking = false;
              sheet.ui.planned = { posted };
            } catch {
              // toast already shown; the picker stays open to try again
            }
            sheet.ui.pending = null;
            sheet.refresh();
          },
        })
      : null,
  );
}

// ---------------------------------------------------------------------------
// Item details
// ---------------------------------------------------------------------------

function openDetail(id) {
  haptic.tap();
  openSheet({ live: true, render: (sheet) => detailContent(id, sheet) });
}

function detailContent(id, sheet) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) {
    setTimeout(() => sheet.close());
    return [];
  }
  const admin = isAdmin();
  const canEdit = admin || (item.mine && item.status === 'wanted');
  const total = itemTotal(item);

  const actions = [];
  if (item.status === 'wanted') {
    if (admin) {
      actions.push(
        h('button', { type: 'button', class: 'button primary block', onclick: () => openBoughtSheet(item) }, 'Отметить купленным'),
      );
    }
    const row = [];
    if (canEdit) row.push(h('button', { type: 'button', class: 'button', onclick: () => openForm(item) }, 'Изменить'));
    if (admin) {
      row.push(
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            onclick: async () => {
              if (await confirmAction('Отменить это желание? Его можно вернуть на вкладке «Куплено».')) {
                save(item.id, { status: 'dropped' }, 'Отменено').catch(() => {});
              }
            },
          },
          'Отменить',
        ),
      );
    }
    if (canEdit) row.push(deleteButton(item, sheet));
    if (row.length) actions.push(h('div', { class: 'button-row' }, row));
  } else if (admin) {
    actions.push(
      h(
        'div',
        { class: 'button-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            onclick: () => save(item.id, { status: 'wanted' }, 'Снова в желаниях').catch(() => {}),
          },
          'Вернуть в желания',
        ),
        deleteButton(item, sheet),
      ),
    );
  }

  return [
    thumb(item, { hero: true }),
    h('h2', { class: 'detail-title' }, item.title),
    metaLine(item),
    h(
      'div',
      { class: 'detail-price' },
      total != null ? money(total) : h('span', { class: 'muted' }, 'Цена не указана'),
      total != null && item.quantity > 1 ? h('small', {}, ` · ${item.quantity} × ${money(item.price)}`) : null,
    ),
    item.link
      ? h(
          'button',
          { type: 'button', class: 'link-button', onclick: () => openExternal(item.link) },
          h('span', {}, hostOf(item.link)),
          h('span', { class: 'muted' }, 'Открыть ↗'),
        )
      : null,
    item.note ? h('p', { class: 'note' }, item.note) : null,
    item.status === 'wanted'
      ? planSection(item, sheet)
      : h(
          'section',
          { class: 'panel' },
          h('div', { class: 'plan-big' }, statusText(item)),
          item.status === 'bought' && item.boughtPrice != null
            ? h('div', { class: 'muted' }, `Оплачено ${money(item.boughtPrice)}`)
            : null,
        ),
    item.status === 'wanted'
      ? h(
          'div',
          { class: 'votes-row' },
          voteButton(item, { withLabel: true }),
          h('span', { class: 'muted small' }, item.voters.length ? item.voters.join(', ') : 'Пока никто не голосовал'),
        )
      : null,
    h(
      'p',
      { class: 'muted small added-by' },
      `Добавил(а) ${item.createdBy?.name || 'кто-то'} · ${formatDay(item.createdAt.slice(0, 10), today())}`,
    ),
    h('div', { class: 'actions' }, actions),
  ];
}

function deleteButton(item, sheet) {
  return h(
    'button',
    {
      type: 'button',
      class: 'button danger',
      onclick: async () => {
        if (!(await confirmAction('Удалить это желание навсегда?'))) return;
        try {
          await API.remove(item.id);
          noteEdit(item.id, null);
          state.items = state.items.filter((candidate) => candidate.id !== item.id);
          sheet.close();
          refreshAll();
          saveSnapshot();
          toast('Удалено');
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    },
    'Удалить',
  );
}

function currencySymbol() {
  return formatMoney(0, currency()).replace(/[\d.,\s]/g, '') || currency();
}

function openBoughtSheet(item) {
  const priceInput = h('input', {
    type: 'text',
    inputmode: 'decimal',
    value: itemTotal(item) ?? '',
    placeholder: '0',
    'aria-label': 'Сколько заплатили',
  });
  const dateInput = h('input', { type: 'date', value: today(), max: today(), 'aria-label': 'Дата покупки' });
  const sheet = openSheet({
    title: 'Отметить купленным',
    render: () => [
      h('p', { class: 'sheet-subtitle' }, item.title),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Сколько заплатили'), moneyInput(priceInput)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Дата покупки'), dateInput),
      h(
        'button',
        {
          type: 'button',
          class: 'button primary block',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.replaceChildren(h('span', { class: 'spinner small' }), ' Сохраняю…');
            try {
              await save(
                item.id,
                {
                  status: 'bought',
                  boughtPrice: priceInput.value.trim() === '' ? null : priceInput.value,
                  boughtAt: dateInput.value || today(),
                },
                'Куплено!',
              );
              sheet.close();
            } catch {
              button.disabled = false;
              button.textContent = 'Отметить купленным';
            }
          },
        },
        'Отметить купленным',
      ),
    ],
  });
}

function moneyInput(input) {
  return h('div', { class: 'money-input' }, h('span', { class: 'money-symbol' }, currencySymbol()), input);
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

/** Shrinks a phone photo to at most 1280px and returns it as a JPEG data URL for upload. */
async function shrinkImage(file, maxSide = 1280) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Не получилось открыть фото. Попробуйте JPG или PNG.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const width = source.width;
  const height = source.height;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

const looksLikeLink = (value) => /^(https?:\/\/)?[^\s/]+\.[^\s/]{2,}(\/\S*)?$/i.test(value);

function openForm(existing) {
  const admin = isAdmin();
  const form = existing
    ? { ...existing }
    : {
        image: null,
        imageUrl: null,
        imageSource: null,
        category: state.category !== 'all' ? state.category : 'hub',
        priority: 'nice',
        quantity: 1,
        planned: false,
        plannedDate: null,
        plannedPrecision: null,
      };
  let saving = false;
  let uploading = false;
  let fetchingLink = false;
  let lookupSeq = 0;
  let lastLookup = existing?.link || '';
  let linkTimer;

  const linkInput = h('input', {
    type: 'url',
    inputmode: 'url',
    autocomplete: 'off',
    placeholder: 'Вставьте ссылку на товар',
    'aria-label': 'Ссылка',
    value: existing?.link || '',
  });
  const linkHint = h('div', { class: 'field-hint' });
  const imageBox = h('div', { class: 'image-box' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const titleInput = h('input', {
    type: 'text',
    maxlength: '200',
    placeholder: 'Например, микрофон Shure SM58',
    'aria-label': 'Название',
    value: existing?.title || '',
  });
  const priceInput = h('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0',
    'aria-label': 'Цена за штуку',
    value: existing?.price ?? '',
  });
  const noteInput = h('textarea', {
    rows: '3',
    maxlength: '2000',
    placeholder: 'Зачем нужно? Модель, размер, цвет…',
    'aria-label': 'Заметка',
    value: existing?.note || '',
  });
  const quantityValue = h('span', { class: 'quantity-value' }, form.quantity);
  const requirement = h('div', { class: 'requirement' });
  const saveButton = h('button', { type: 'submit', class: 'button primary block' }, existing ? 'Сохранить' : 'Добавить в вишлист');
  const planWrap = h('div');

  function validate() {
    const hasSource = linkInput.value.trim() || form.image;
    const hasTitle = titleInput.value.trim();
    requirement.textContent = !hasSource
      ? 'Добавьте фото или ссылку — что-то одно обязательно.'
      : !hasTitle
        ? 'Укажите название.'
        : '';
    saveButton.disabled = !hasSource || !hasTitle || uploading || saving;
  }

  function drawImage() {
    const busy = uploading || fetchingLink;
    fill(imageBox, 
      form.imageUrl
        ? h('img', { src: form.imageUrl, alt: '', class: form.imageSource === 'upload' ? 'cover' : '' })
        : h(
            'button',
            { type: 'button', class: 'image-empty', onclick: () => fileInput.click() },
            h('span', { class: 'image-empty-icon' }, '+'),
            h('span', {}, 'Добавить фото'),
            h('small', {}, 'или вставьте ссылку выше — картинка подтянется сама'),
          ),
      busy ? h('div', { class: 'image-busy' }, h('span', { class: 'spinner' })) : null,
      form.imageUrl
        ? h(
            'div',
            { class: 'image-actions' },
            h('button', { type: 'button', class: 'button small', onclick: () => fileInput.click() }, 'Заменить'),
            h(
              'button',
              {
                type: 'button',
                class: 'button small',
                onclick: () => {
                  Object.assign(form, { image: null, imageUrl: null, imageSource: null });
                  drawImage();
                  validate();
                },
              },
              'Убрать',
            ),
          )
        : null,
    );
  }

  function setHint(text, kind = '') {
    linkHint.textContent = text;
    linkHint.className = `field-hint ${kind}`;
  }

  async function lookupLink() {
    const value = linkInput.value.trim();
    if (!looksLikeLink(value) || value === lastLookup) return;
    lastLookup = value;
    const seq = ++lookupSeq;
    fetchingLink = form.imageSource !== 'upload';
    setHint('Смотрим ссылку…', 'loading');
    drawImage();
    try {
      const preview = await API.preview(value);
      if (seq !== lookupSeq) return;
      const found = [];
      if (preview.image && form.imageSource !== 'upload') {
        Object.assign(form, { image: preview.image, imageUrl: preview.imageUrl, imageSource: 'link' });
        found.push('фото');
      }
      if (preview.title && !titleInput.value.trim()) {
        titleInput.value = preview.title;
        found.push('название');
      }
      let otherCurrency = '';
      if (preview.price != null && !priceInput.value.trim()) {
        if (!preview.currency || preview.currency === currency()) {
          priceInput.value = preview.price;
          found.push('цену');
        } else {
          otherCurrency = ` В магазине: ${preview.price} ${preview.currency}.`;
        }
      }
      const site = preview.siteName || hostOf(preview.link);
      if (found.length) {
        const list = found.length > 1 ? `${found.slice(0, -1).join(', ')} и ${found.at(-1)}` : found[0];
        setHint(`✓ Взяли ${list} с ${site}.${otherCurrency}`, 'ok');
      } else {
        setHint(`Ссылка на ${site} сохранена.${otherCurrency}`, 'ok');
      }
      if (!preview.image && !form.image) {
        setHint(`${linkHint.textContent} Картинку найти не удалось — хватит и ссылки, или добавьте фото.`, 'warn');
      }
      haptic.success();
    } catch (error) {
      if (seq !== lookupSeq) return;
      setHint(error.message, 'warn');
    } finally {
      if (seq === lookupSeq) {
        fetchingLink = false;
        drawImage();
        validate();
      }
    }
  }

  linkInput.addEventListener('input', () => {
    validate();
    clearTimeout(linkTimer);
    linkTimer = setTimeout(lookupLink, 600);
  });
  linkInput.addEventListener('blur', () => {
    clearTimeout(linkTimer);
    lookupLink();
  });
  titleInput.addEventListener('input', validate);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    uploading = true;
    drawImage();
    validate();
    try {
      // The server keeps a ~480px copy for the cards, next to the photo itself.
      const [photo, thumb] = await Promise.all([shrinkImage(file), shrinkImage(file, CARD_WIDTH)]);
      const result = await API.upload(photo, thumb);
      Object.assign(form, { image: result.image, imageUrl: result.imageUrl, imageSource: 'upload' });
      haptic.success();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      uploading = false;
      drawImage();
      validate();
    }
  });

  function choice(options, key) {
    const wrap = h('div', { class: 'chips wrap', role: 'radiogroup' });
    const draw = () =>
      fill(wrap, 
        ...options.map((option) =>
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(form[key] === option.id),
              class: `chip${form[key] === option.id ? ' selected' : ''}`,
              onclick: () => {
                form[key] = option.id;
                haptic.tap();
                draw();
              },
            },
            option.label,
          ),
        ),
      );
    draw();
    return wrap;
  }

  function stepQuantity(delta) {
    form.quantity = Math.min(999, Math.max(1, form.quantity + delta));
    quantityValue.textContent = form.quantity;
    haptic.tap();
  }

  function drawPlan() {
    const plan = describePlan(form, today());
    fill(planWrap, 
      h(
        'section',
        { class: 'panel' },
        h(
          'label',
          { class: 'switch-row' },
          h(
            'span',
            { class: 'switch-text' },
            h('b', {}, 'Планируем купить'),
            h('small', {}, plan ? `${plan.label}${planText(plan)}` : 'Пока не в плане'),
          ),
          h('input', {
            type: 'checkbox',
            role: 'switch',
            class: 'switch',
            checked: form.planned,
            onchange: (event) => {
              form.planned = event.target.checked;
              if (!form.planned) Object.assign(form, { plannedDate: null, plannedPrecision: null });
              haptic.tap();
              drawPlan();
            },
          }),
        ),
        form.planned
          ? planPicker({
              current: form,
              onPick: (value) => {
                Object.assign(form, value);
                haptic.tap();
                drawPlan();
              },
            })
          : null,
      ),
    );
  }

  async function submit(event) {
    event.preventDefault();
    validate();
    if (saveButton.disabled) return;
    saving = true;
    validate();
    saveButton.textContent = 'Сохраняем…';
    const body = {
      title: titleInput.value,
      note: noteInput.value,
      link: linkInput.value,
      image: form.image,
      imageSource: form.imageSource || 'link',
      category: form.category,
      priority: form.priority,
      price: priceInput.value.trim() === '' ? null : priceInput.value,
      quantity: form.quantity,
    };
    if (admin && (!existing || existing.status === 'wanted')) {
      Object.assign(body, { planned: form.planned, plannedDate: form.plannedDate, plannedPrecision: form.plannedPrecision });
    }
    try {
      const { item, posted } = existing ? await API.update(existing.id, body) : await API.create(body);
      if (!existing && state.tab === 'bought') state.tab = 'wishlist';
      upsert(item);
      haptic.success();
      toast((existing ? 'Сохранено' : 'Добавлено в вишлист') + postedNote(posted));
      sheet.close();
    } catch (error) {
      haptic.error();
      toast(error.message, 'error');
      saving = false;
      saveButton.textContent = existing ? 'Сохранить' : 'Добавить в вишлист';
      validate();
    }
  }

  drawImage();
  if (admin && (!existing || existing.status === 'wanted')) drawPlan();
  validate();

  const field = (label, ...controls) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), controls);

  const sheet = openSheet({
    title: existing ? 'Изменить желание' : 'Новое желание',
    tall: true,
    render: () =>
      h(
        'form',
        { class: 'form', onsubmit: submit, novalidate: true },
        field('Ссылка', linkInput, linkHint),
        field('Фото', imageBox, fileInput),
        field('Название', titleInput),
        field('Категория', choice(CATEGORIES, 'category')),
        field('Важность', choice(PRIORITIES, 'priority')),
        h(
          'div',
          { class: 'field-row' },
          field('Цена за штуку', moneyInput(priceInput)),
          field(
            'Количество',
            h(
              'div',
              { class: 'stepper' },
              h('button', { type: 'button', 'aria-label': 'Меньше', onclick: () => stepQuantity(-1) }, '−'),
              quantityValue,
              h('button', { type: 'button', 'aria-label': 'Больше', onclick: () => stepQuantity(1) }, '+'),
            ),
          ),
        ),
        field('Заметка', noteInput),
        planWrap,
        h('div', { class: 'form-footer' }, requirement, saveButton),
      ),
  });
  if (!existing) setTimeout(() => linkInput.focus(), 250);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function applyTheme() {
  if (!tg) return;
  const dark = tg.colorScheme === 'dark';
  document.documentElement.dataset.scheme = dark ? 'dark' : 'light';
  // Telegram's own bar blends into the charcoal HOROVOD header band.
  if (supports('6.9')) tg.setHeaderColor(dark ? '#1f1d1b' : '#2d2a28');
  if (supports('6.1')) tg.setBackgroundColor(dark ? '#2d2a28' : '#f6f2e9');
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    if (supports('7.7')) tg.disableVerticalSwipes();
    applyTheme();
    tg.onEvent('themeChanged', applyTheme);
  }
  if (!initData && !API.demo) {
    state.error = {
      emoji: '📱',
      title: 'Откройте в Telegram',
      text: 'Вишлист HOROVOD работает внутри Telegram. Откройте его через бота HOROVOD.',
    };
    render();
    return;
  }

  const start = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('startapp') || '';
  if (start === 'plan') state.tab = 'plan';
  let startItem = start.startsWith('item_') ? start.slice(5) : '';
  const openStartItem = () => {
    if (startItem && state.items.some((item) => item.id === startItem)) {
      openDetail(startItem);
      startItem = '';
    }
  };

  // Last time's list shows at once (a spinner the very first time); Google's answer follows.
  const saved = readSnapshot();
  if (saved) Object.assign(state, { me: saved.me, items: saved.items, loaded: true });
  render();
  openStartItem();

  await sync();
  if (state.error) return;
  openStartItem(); // a wish newer than the saved list

  // Pick up what others added while the app was in the background.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync({ quiet: true });
  });
}

boot();
