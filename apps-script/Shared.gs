// GENERATED from public/lib/shared.js by tools/build-gs.mjs — edit that file, not this one.

// Pure helpers shared by the Mini App (screens, demo mode) and the Google Apps Script
// backend (tools/build-gs.mjs copies this file to apps-script/Shared.gs without the
// `export` keywords). So: no DOM, no Node, no Intl or URL — plain JavaScript only.

const CATEGORIES = [
  { id: 'hub', emoji: '🏠', label: 'Хаб' },
  { id: 'instruments', emoji: '🎸', label: 'Инструменты' },
  { id: 'tech', emoji: '🎛️', label: 'Техника и звук' },
  { id: 'other', emoji: '📦', label: 'Другое' },
];

const PRIORITIES = [
  { id: 'must', emoji: '🔴', label: 'Обязательно', rank: 0 },
  { id: 'nice', emoji: '🟡', label: 'Желательно', rank: 1 },
  { id: 'dream', emoji: '✨', label: 'Мечта', rank: 2 },
];

const STATUSES = ['wanted', 'bought', 'dropped'];

const SORTS = [
  { id: 'schedule', label: 'По дате' },
  { id: 'votes', label: 'По голосам' },
  { id: 'priority', label: 'По важности' },
  { id: 'price', label: 'По цене' },
  { id: 'newest', label: 'Новые' },
];

/** Russian plural: plural(5, 'день', 'дня', 'дней') → 'дней'. */
function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function findOption(list, id) {
  return list.find((option) => option.id === id) || list[list.length - 1];
}

const NBSP = '\u00a0';
const SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CZK: 'Kč' };

/** Russian style: "1 299 €", "12,50 €". */
function formatMoney(amount, currency = 'EUR') {
  if (amount == null || !Number.isFinite(amount)) return '';
  const digits = Number.isInteger(amount) ? 0 : 2;
  const [whole, fraction] = Math.abs(amount).toFixed(digits).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const number = `${amount < 0 ? '−' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
  return `${number}${NBSP}${SYMBOLS[currency] || currency}`;
}

/** Price × quantity, or null when the item has no price. */
function itemTotal(item) {
  if (item.price == null) return null;
  return Math.round(item.price * (item.quantity || 1) * 100) / 100;
}

function sumTotals(items, pick = itemTotal) {
  let total = 0;
  let missing = 0;
  for (const item of items) {
    const value = pick(item);
    if (value == null) missing += 1;
    else total += value;
  }
  return { total: Math.round(total * 100) / 100, missing };
}

// ---------------------------------------------------------------------------
// Dates. Every date is a plain 'YYYY-MM-DD' string (no times, no time zones),
// so "today" is always passed in by the caller.
// ---------------------------------------------------------------------------

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const toUTC = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Today's date in the given IANA time zone, e.g. todayIn('Europe/Bratislava'). */
function todayIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today's date on this device. */
function localToday() {
  const now = new Date();
  return fromUTC(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / 86_400_000);
}

function monthsBetween(from, to) {
  return (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7));
}

/** First day of the month `n` months after `date`'s month. */
function addMonths(date, n) {
  return fromUTC(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1 + n, 1));
}

function addDays(date, n) {
  return fromUTC(toUTC(date) + n * 86_400_000);
}

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_CHIP = ['Янв', 'Фев', 'Март', 'Апр', 'Май', 'Июнь', 'Июль', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const monthIndex = (date) => +date.slice(5, 7) - 1;
const yearSuffix = (date, today) => (!today || date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${date.slice(0, 4)}`);

/** "Октябрь 2026" */
function formatMonth(date) {
  return `${MONTHS[monthIndex(date)]} ${date.slice(0, 4)}`;
}

/** "Окт", or "Янв 2027" when the year differs from `today`'s. */
function formatShortMonth(date, today) {
  return MONTHS_CHIP[monthIndex(date)] + yearSuffix(date, today);
}

/** "12 окт" (with the year when it differs from `today`'s). Used where space is tight. */
function formatShortDay(date, today) {
  return `${+date.slice(8, 10)} ${MONTHS_SHORT[monthIndex(date)]}${yearSuffix(date, today)}`;
}

/** "сб, 12 окт", with the year added when it differs from `today`'s. */
function formatDay(date, today) {
  const weekday = WEEKDAYS[new Date(toUTC(date)).getUTCDay()];
  return `${weekday}, ${+date.slice(8, 10)} ${MONTHS_SHORT[monthIndex(date)]}${yearSuffix(date, today)}`;
}

/**
 * How to show a planned purchase date.
 * Returns null when the item isn't planned, otherwise { tone, label, detail }:
 *   tone   — overdue | soon | upcoming | later | nodate (drives the colour)
 *   label  — the relative part, e.g. "Завтра", "В следующем месяце", "Просрочено на 3 дня"
 *   detail — the absolute part, e.g. "сб, 12 окт", "Ноябрь 2026"
 *   short  — a compact absolute part for cards, e.g. "12 окт", "Ноябрь"
 */
function describePlan(item, today) {
  if (!item.planned) return null;
  if (!item.plannedDate) return { tone: 'nodate', label: 'В плане', detail: 'дата не выбрана', short: 'без даты' };
  const plan = describeDate(item, today);
  const short =
    item.plannedPrecision === 'month'
      ? MONTHS[monthIndex(item.plannedDate)] + yearSuffix(item.plannedDate, today)
      : formatShortDay(item.plannedDate, today);
  return { ...plan, short };
}

function describeDate(item, today) {

  if (item.plannedPrecision === 'month') {
    const months = monthsBetween(today, item.plannedDate);
    const detail = formatMonth(item.plannedDate);
    if (months < 0) return { tone: 'overdue', label: 'Просрочено', detail };
    if (months === 0) return { tone: 'soon', label: 'В этом месяце', detail };
    if (months === 1) return { tone: 'upcoming', label: 'В следующем месяце', detail };
    return { tone: 'later', label: `Через ${months} ${plural(months, 'месяц', 'месяца', 'месяцев')}`, detail };
  }

  const days = daysBetween(today, item.plannedDate);
  const detail = formatDay(item.plannedDate, today);
  const inDays = (n) => `Через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
  if (days < 0) return { tone: 'overdue', label: `Просрочено на ${-days} ${plural(-days, 'день', 'дня', 'дней')}`, detail };
  if (days === 0) return { tone: 'soon', label: 'Сегодня', detail };
  if (days === 1) return { tone: 'soon', label: 'Завтра', detail };
  if (days === 2) return { tone: 'soon', label: 'Послезавтра', detail };
  if (days < 14) return { tone: days < 7 ? 'soon' : 'upcoming', label: inDays(days), detail };
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return { tone: 'upcoming', label: `Через ${weeks} ${plural(weeks, 'неделю', 'недели', 'недель')}`, detail };
  }
  const months = Math.round(days / 30.44);
  return { tone: 'later', label: `Через ${months} ${plural(months, 'месяц', 'месяца', 'месяцев')}`, detail };
}

/** Sort key for planned items: exact days first, then "sometime this month", then undated. */
function scheduleKey(item) {
  if (!item.planned) return '~';
  if (!item.plannedDate) return '9999';
  return item.plannedPrecision === 'month' ? `${item.plannedDate.slice(0, 8)}99` : item.plannedDate;
}

const priorityRank = (item) => findOption(PRIORITIES, item.priority).rank;

// Plain code-point comparison (localeCompare would put '~' before digits).
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compareItems(sort) {
  const newest = (a, b) => compareText(b.createdAt || '', a.createdAt || '');
  const byVotes = (a, b) => (b.votes || 0) - (a.votes || 0);
  const byPriority = (a, b) => priorityRank(a) - priorityRank(b);
  const bySchedule = (a, b) => compareText(scheduleKey(a), scheduleKey(b));
  const chains = {
    schedule: [bySchedule, byPriority, byVotes, newest],
    votes: [byVotes, byPriority, newest],
    priority: [byPriority, bySchedule, byVotes, newest],
    price: [(a, b) => (itemTotal(b) ?? -1) - (itemTotal(a) ?? -1), newest],
    newest: [newest],
  };
  const chain = chains[sort] || chains.schedule;
  return (a, b) => {
    for (const compare of chain) {
      const result = compare(a, b);
      if (result) return result;
    }
    return 0;
  };
}

/**
 * Planned (still wanted) items grouped for the plan view:
 * overdue first, then one group per month, then planned-without-a-date.
 */
function groupPlan(items, today) {
  const planned = items
    .filter((item) => item.status === 'wanted' && item.planned)
    .sort(compareItems('schedule'));
  const groups = new Map();
  for (const item of planned) {
    let key;
    if (!item.plannedDate) key = 'nodate';
    else if (describePlan(item, today).tone === 'overdue') key = 'overdue';
    else key = item.plannedDate.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const order = (key) => (key === 'overdue' ? '0' : key === 'nodate' ? '9' : `1${key}`);
  return [...groups.entries()]
    .sort(([a], [b]) => compareText(order(a), order(b)))
    .map(([key, groupItems]) => {
      let title;
      let note = '';
      if (key === 'overdue') title = 'Просрочено';
      else if (key === 'nodate') title = 'В плане, без даты';
      else {
        title = formatMonth(`${key}-01`);
        const months = monthsBetween(today, `${key}-01`);
        note = months === 0 ? 'В этом месяце' : months === 1 ? 'В следующем' : '';
      }
      return { key, title, note, items: groupItems, ...sumTotals(groupItems) };
    });
}

/** Bought items grouped by the month they were bought in, newest first. */
function groupBought(items) {
  const bought = items
    .filter((item) => item.status === 'bought')
    .sort((a, b) => compareText(b.boughtAt || '', a.boughtAt || ''));
  const groups = new Map();
  for (const item of bought) {
    const key = (item.boughtAt || '0000-00').slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, groupItems]) => ({
    key,
    title: key === '0000-00' ? 'Без даты' : formatMonth(`${key}-01`),
    items: groupItems,
    ...sumTotals(groupItems, (item) => item.boughtPrice ?? itemTotal(item)),
  }));
}

function hostOf(link) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(link || '');
  return match ? match[1].toLowerCase().replace(/^www\./, '') : '';
}

// ---------------------------------------------------------------------------
// Wishes: the rules for what may be saved and who may change what. Used by the
// Apps Script backend (the real rules) and by demo mode in the browser.
// ---------------------------------------------------------------------------

class WishError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function text(value, label, max, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new WishError(`${label}: нужен текст`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new WishError(`${label}: обязательное поле`);
  if (trimmed.length > max) throw new WishError(`${label}: слишком длинно (максимум ${max} символов)`);
  return trimmed;
}

function money(value, label) {
  if (value === '' || value == null) return null;
  const number = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(number) || number < 0 || number > 10_000_000) throw new WishError(`${label}: неверное значение`);
  return Math.round(number * 100) / 100;
}

function oneOf(value, options, label) {
  if (!options.includes(value)) throw new WishError(`Неизвестное значение: ${label}`);
  return value;
}

/** Accepts "thomann.de/…" as well as full links; returns '' for empty input. */
function normalizeLink(value) {
  let link = text(value, 'Ссылка', 2000);
  if (!link) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link}`;
  if (!/^https?:\/\//i.test(link)) throw new WishError('Поддерживаются только веб-ссылки');
  const host = hostOf(link);
  if (!host || !host.includes('.') || /\s/.test(link)) throw new WishError('Ссылка выглядит неправильно');
  return link;
}

/** Image references: a Google Drive file id, or a web/relative address (demo pictures). */
const IMAGE_REF = /^(drive:[\w-]{10,200}|https:\/\/\S{1,2000}|demo\/img\/[\w-]+\.(png|jpe?g|webp)|data:image\/(jpeg|png|webp);base64,[\w+/=]+)$/;

/**
 * Turns input into a clean patch. Only fields present in the input are touched.
 * Planning and buying are for admins only.
 */
function cleanWishInput(input, { isAdmin, isNew, today }) {
  const patch = {};
  if (isNew || has(input, 'title')) patch.title = text(input.title, 'Название', 200, true);
  if (has(input, 'note')) patch.note = text(input.note, 'Заметка', 2000);
  if (has(input, 'link')) patch.link = normalizeLink(input.link);
  if (has(input, 'image')) {
    const image = input.image || null;
    if (image !== null && (typeof image !== 'string' || !IMAGE_REF.test(image))) throw new WishError('Неизвестная картинка');
    patch.image = image;
  }
  if (has(input, 'imageSource')) patch.imageSource = input.imageSource === 'upload' ? 'upload' : 'link';
  if (has(input, 'category')) patch.category = oneOf(input.category, CATEGORIES.map((c) => c.id), 'категория');
  if (has(input, 'priority')) patch.priority = oneOf(input.priority, PRIORITIES.map((p) => p.id), 'важность');
  if (has(input, 'price')) patch.price = money(input.price, 'Цена');
  if (has(input, 'quantity')) {
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new WishError('Количество: от 1 до 999');
    patch.quantity = quantity;
  }
  if (has(input, 'planned')) {
    if (!isAdmin) throw new WishError('Планировать покупки могут только админы', 403);
    patch.planned = Boolean(input.planned);
    patch.plannedDate = null;
    patch.plannedPrecision = null;
    if (patch.planned && input.plannedDate) {
      if (!isValidDate(input.plannedDate)) throw new WishError('Дата выглядит неправильно');
      patch.plannedPrecision = input.plannedPrecision === 'month' ? 'month' : 'day';
      patch.plannedDate = patch.plannedPrecision === 'month' ? `${input.plannedDate.slice(0, 7)}-01` : input.plannedDate;
    }
  }
  if (has(input, 'status')) {
    if (!isAdmin) throw new WishError('Отмечать покупки могут только админы', 403);
    patch.status = oneOf(input.status, STATUSES, 'статус');
    patch.boughtAt = null;
    patch.boughtPrice = null;
    if (patch.status === 'bought') {
      const boughtAt = input.boughtAt || today;
      if (!isValidDate(boughtAt)) throw new WishError('Дата выглядит неправильно');
      patch.boughtAt = boughtAt;
      patch.boughtPrice = money(input.boughtPrice, 'Оплачено');
    }
  }
  return patch;
}

function userRef(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return { id: user.id, name: name || (user.username ? `@${user.username}` : 'Кто-то'), username: user.username || null };
}

function newWishId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function newWish(patch, { user, currency, now = new Date().toISOString() }) {
  return {
    id: newWishId(),
    title: '',
    note: '',
    link: '',
    image: null,
    imageSource: null,
    category: 'other',
    priority: 'nice',
    price: null,
    currency,
    quantity: 1,
    planned: false,
    plannedDate: null,
    plannedPrecision: null,
    status: 'wanted',
    boughtAt: null,
    boughtPrice: null,
    votes: [],
    createdBy: userRef(user),
    createdAt: now,
    updatedAt: now,
    remindedFor: null,
    ...patch,
  };
}

/** Members may edit and delete their own wishes until they're bought; admins anything. */
function canEditWish(wish, { userId, isAdmin }) {
  return isAdmin || (wish.createdBy && wish.createdBy.id === userId && wish.status === 'wanted');
}

/** Applies an edit, enforcing "a photo or a link". Returns { wish, becamePlanned, becameBought }. */
function applyWishPatch(wish, patch, now = new Date().toISOString()) {
  const next = { ...wish, ...patch, updatedAt: now };
  if (!next.link && !next.image) throw new WishError('Добавьте фото или ссылку');
  return {
    wish: next,
    becamePlanned: !wish.planned && next.planned && next.status === 'wanted',
    becameBought: wish.status !== 'bought' && next.status === 'bought',
  };
}

function toggleVote(wish, user) {
  const votes = wish.votes.filter((vote) => vote.id !== user.id);
  if (votes.length === wish.votes.length) votes.push({ id: user.id, name: userRef(user).name });
  return { ...wish, votes };
}

/** What the Mini App gets to see of a wish. `imageUrl` turns an image reference into an address. */
function publicWish(wish, userId, imageUrl) {
  const { votes, remindedFor, ...rest } = wish;
  return {
    ...rest,
    imageUrl: wish.image ? imageUrl(wish.image) : null,
    votes: votes.length,
    voters: votes.map((vote) => vote.name),
    voted: votes.some((vote) => vote.id === userId),
    mine: wish.createdBy?.id === userId,
  };
}

/** Planned wishes whose date has come: exact days within 2 days (or past), month plans once the month starts. */
function isDue(wish, today) {
  if (wish.status !== 'wanted' || !wish.planned || !wish.plannedDate) return false;
  if (wish.plannedPrecision === 'month') return monthsBetween(today, wish.plannedDate) <= 0;
  return daysBetween(today, wish.plannedDate) <= 2;
}
