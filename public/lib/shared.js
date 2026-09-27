// Pure helpers shared by the server (validation, bot messages) and the Mini App (UI).
// No DOM or Node APIs in here, so both sides can import it.

export const CATEGORIES = [
  { id: 'hub', emoji: '🏠', label: 'Horovod Hub' },
  { id: 'instruments', emoji: '🎸', label: 'Instruments' },
  { id: 'tech', emoji: '🎛️', label: 'Tech & audio' },
  { id: 'other', emoji: '📦', label: 'Other' },
];

export const PRIORITIES = [
  { id: 'must', emoji: '🔴', label: 'Must-have', rank: 0 },
  { id: 'nice', emoji: '🟡', label: 'Nice to have', rank: 1 },
  { id: 'dream', emoji: '✨', label: 'Dream', rank: 2 },
];

export const STATUSES = ['wanted', 'bought', 'dropped'];

export const SORTS = [
  { id: 'schedule', label: 'Buy date' },
  { id: 'votes', label: 'Most votes' },
  { id: 'priority', label: 'Priority' },
  { id: 'price', label: 'Price' },
  { id: 'newest', label: 'Newest' },
];

export function findOption(list, id) {
  return list.find((option) => option.id === id) || list[list.length - 1];
}

const LOCALE = 'en-GB';

export function formatMoney(amount, currency = 'EUR') {
  if (amount == null || !Number.isFinite(amount)) return '';
  const digits = Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** Price × quantity, or null when the item has no price. */
export function itemTotal(item) {
  if (item.price == null) return null;
  return Math.round(item.price * (item.quantity || 1) * 100) / 100;
}

export function sumTotals(items, pick = itemTotal) {
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

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const toUTC = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Today's date in the given IANA time zone, e.g. todayIn('Europe/Bratislava'). */
export function todayIn(timeZone) {
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
export function localToday() {
  const now = new Date();
  return fromUTC(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function daysBetween(from, to) {
  return Math.round((toUTC(to) - toUTC(from)) / 86_400_000);
}

export function monthsBetween(from, to) {
  return (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7));
}

/** First day of the month `n` months after `date`'s month. */
export function addMonths(date, n) {
  return fromUTC(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1 + n, 1));
}

export function addDays(date, n) {
  return fromUTC(toUTC(date) + n * 86_400_000);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthIndex = (date) => +date.slice(5, 7) - 1;
const yearSuffix = (date, today) => (!today || date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${date.slice(0, 4)}`);

/** "October 2026" */
export function formatMonth(date) {
  return `${MONTHS[monthIndex(date)]} ${date.slice(0, 4)}`;
}

/** "Oct", or "Jan 2027" when the year differs from `today`'s. */
export function formatShortMonth(date, today) {
  return MONTHS[monthIndex(date)].slice(0, 3) + yearSuffix(date, today);
}

/** "Sat 12 Oct", with the year added when it differs from `today`'s. */
export function formatDay(date, today) {
  const weekday = WEEKDAYS[new Date(toUTC(date)).getUTCDay()];
  return `${weekday} ${+date.slice(8, 10)} ${MONTHS[monthIndex(date)].slice(0, 3)}${yearSuffix(date, today)}`;
}

/**
 * How to show a planned purchase date.
 * Returns null when the item isn't planned, otherwise { tone, label, detail }:
 *   tone   — overdue | soon | upcoming | later | nodate (drives the colour)
 *   label  — the relative part, e.g. "Tomorrow", "Next month", "3 days overdue"
 *   detail — the absolute part, e.g. "Sat 12 Oct", "November 2026"
 */
export function describePlan(item, today) {
  if (!item.planned) return null;
  if (!item.plannedDate) return { tone: 'nodate', label: 'Planned', detail: 'date not set' };

  if (item.plannedPrecision === 'month') {
    const months = monthsBetween(today, item.plannedDate);
    const detail = formatMonth(item.plannedDate);
    if (months < 0) return { tone: 'overdue', label: 'Overdue', detail };
    if (months === 0) return { tone: 'soon', label: 'This month', detail };
    if (months === 1) return { tone: 'upcoming', label: 'Next month', detail };
    return { tone: 'later', label: `In ${months} months`, detail };
  }

  const days = daysBetween(today, item.plannedDate);
  const detail = formatDay(item.plannedDate, today);
  if (days < 0) return { tone: 'overdue', label: days === -1 ? '1 day overdue' : `${-days} days overdue`, detail };
  if (days === 0) return { tone: 'soon', label: 'Today', detail };
  if (days === 1) return { tone: 'soon', label: 'Tomorrow', detail };
  if (days < 7) return { tone: 'soon', label: `In ${days} days`, detail };
  if (days < 14) return { tone: 'upcoming', label: `In ${days} days`, detail };
  if (days < 60) return { tone: 'upcoming', label: `In ${Math.round(days / 7)} weeks`, detail };
  return { tone: 'later', label: `In ${Math.round(days / 30.44)} months`, detail };
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

export function compareItems(sort) {
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
export function groupPlan(items, today) {
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
      if (key === 'overdue') title = 'Overdue';
      else if (key === 'nodate') title = 'Planned, date not set';
      else {
        title = formatMonth(`${key}-01`);
        const months = monthsBetween(today, `${key}-01`);
        note = months === 0 ? 'This month' : months === 1 ? 'Next month' : '';
      }
      return { key, title, note, items: groupItems, ...sumTotals(groupItems) };
    });
}

/** Bought items grouped by the month they were bought in, newest first. */
export function groupBought(items) {
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
    title: key === '0000-00' ? 'Unknown date' : formatMonth(`${key}-01`),
    items: groupItems,
    ...sumTotals(groupItems, (item) => item.boughtPrice ?? itemTotal(item)),
  }));
}

export function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
