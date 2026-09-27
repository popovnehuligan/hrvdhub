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
  sumTotals,
} from './lib/shared.js';

const tg = window.Telegram?.WebApp;
const initData = tg?.initData || new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';
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

async function api(path, { method = 'GET', body, raw, contentType } = {}) {
  const headers = { Authorization: `tma ${initData}` };
  let payload;
  if (raw) {
    payload = raw;
    headers['Content-Type'] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let response;
  try {
    response = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Something went wrong (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

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
    { class: `sheet${tall ? ' tall' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Details' },
    h(
      'header',
      { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close', onclick: () => sheet.close() }, '✕'),
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
  render();
  for (const sheet of sheets) if (sheet.live) sheet.refresh();
}

function upsert(item) {
  const index = state.items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) state.items[index] = item;
  else state.items.unshift(item);
  refreshAll();
}

async function save(id, patch, message) {
  try {
    const { item } = await api(`/api/items/${id}`, { method: 'PATCH', body: patch });
    upsert(item);
    haptic.success();
    if (message) toast(message);
    return item;
  } catch (error) {
    haptic.error();
    toast(error.message, 'error');
    throw error;
  }
}

async function toggleVote(item) {
  haptic.tap();
  const before = { votes: item.votes, voted: item.voted, voters: item.voters };
  item.voted = !item.voted;
  item.votes += item.voted ? 1 : -1;
  refreshAll();
  try {
    const { item: updated } = await api(`/api/items/${item.id}/vote`, { method: 'POST' });
    upsert(updated);
  } catch (error) {
    Object.assign(item, before);
    refreshAll();
    toast(error.message, 'error');
  }
}

async function reload() {
  try {
    const { items } = await api('/api/items');
    state.items = items;
    refreshAll();
  } catch {
    // Keep showing what we have.
  }
}

// ---------------------------------------------------------------------------
// Pieces used in several places
// ---------------------------------------------------------------------------

function thumb(item, { hero = false } = {}) {
  const base = hero ? 'hero' : 'thumb';
  if (item.imageUrl) {
    return h(
      'div',
      { class: `${base}${item.imageSource === 'upload' ? ' cover' : ''}` },
      h('img', { src: item.imageUrl, alt: '', loading: 'lazy', decoding: 'async' }),
    );
  }
  const category = findOption(CATEGORIES, item.category);
  return h(
    'div',
    { class: `${base} placeholder` },
    h('span', { class: 'placeholder-emoji' }, category.emoji),
    item.link ? h('span', { class: 'placeholder-host' }, hostOf(item.link)) : null,
  );
}

function metaLine(item) {
  const category = findOption(CATEGORIES, item.category);
  const priority = findOption(PRIORITIES, item.priority);
  return h(
    'div',
    { class: 'meta' },
    `${category.emoji} ${category.label}`,
    h('span', { class: 'sep' }, '·'),
    `${priority.emoji} ${priority.label}`,
  );
}

function priceLine(item) {
  if (item.status === 'bought') {
    const paid = item.boughtPrice ?? itemTotal(item);
    return h('div', { class: 'price' }, paid != null ? `Paid ${money(paid)}` : 'Bought');
  }
  const total = itemTotal(item);
  if (total == null) return h('div', { class: 'price missing' }, 'No price yet');
  return h(
    'div',
    { class: 'price' },
    money(total),
    item.quantity > 1 ? h('small', {}, ` · ${item.quantity} × ${money(item.price)}`) : null,
  );
}

function planText(plan) {
  return plan.tone === 'nodate' ? ' · date not set' : ` · ${plan.detail}`;
}

/** The "Planned" toggle on a card. Admins tap it to plan / change the date. */
function planChip(item) {
  const plan = describePlan(item, today());
  if (!plan) {
    if (!isAdmin()) return null;
    return h(
      'button',
      { type: 'button', class: 'plan-chip off', onclick: stop(() => openWhenSheet(item)), 'aria-label': 'Plan to buy' },
      h('span', { class: 'mini-switch' }),
      'Planned',
    );
  }
  const content = [
    isAdmin() ? h('span', { class: 'mini-switch on' }) : h('span', { 'aria-hidden': 'true' }, '🗓'),
    h('b', {}, plan.label),
    h('span', { class: 'plan-detail' }, planText(plan)),
  ];
  if (!isAdmin()) return h('span', { class: `plan-chip tone-${plan.tone}` }, content);
  return h(
    'button',
    {
      type: 'button',
      class: `plan-chip tone-${plan.tone}`,
      onclick: stop(() => openWhenSheet(item)),
      'aria-label': `Planned: ${plan.label}${planText(plan)}. Change`,
    },
    content,
  );
}

function voteButton(item, { withLabel = false } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: `vote${item.voted ? ' voted' : ''}`,
      'aria-pressed': String(item.voted),
      'aria-label': item.voted ? 'Remove your vote' : 'Vote for this',
      onclick: stop(() => toggleVote(item)),
    },
    '👍',
    withLabel ? h('span', {}, item.voted ? 'Voted' : 'Vote') : null,
    item.votes ? h('span', { class: 'vote-count' }, item.votes) : null,
  );
}

function card(item) {
  const plan = describePlan(item, today());
  return h(
    'article',
    {
      class: `card${plan && item.status === 'wanted' ? ` tone-${plan.tone}` : ''}`,
      tabindex: '0',
      onclick: () => openDetail(item.id),
      onkeydown: (event) => event.key === 'Enter' && openDetail(item.id),
    },
    thumb(item),
    h(
      'div',
      { class: 'card-main' },
      h('h3', { class: 'card-title' }, item.title),
      metaLine(item),
      h('div', { class: 'price-row' }, priceLine(item), item.status === 'wanted' ? voteButton(item) : null),
      item.status === 'wanted'
        ? h('div', { class: 'card-foot' }, planChip(item))
        : h('div', { class: 'card-foot' }, h('span', { class: 'muted small' }, statusText(item))),
    ),
  );
}

function statusText(item) {
  if (item.status === 'bought') return item.boughtAt ? `✅ Bought ${formatDay(item.boughtAt, today())}` : '✅ Bought';
  if (item.status === 'dropped') return '🗄 Dropped';
  return '';
}

function emptyState(emoji, title, text, action) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-emoji' }, emoji),
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
      missing ? h('small', {}, `${total ? ' + ' : ''}${missing} without price`) : null,
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
    h('div', { class: 'logo', 'aria-hidden': 'true' }, 'H'),
    h(
      'div',
      {},
      h('h1', {}, 'Horovod Wishlist'),
      h(
        'p',
        { class: 'muted' },
        `${wanted.length} ${wanted.length === 1 ? 'wish' : 'wishes'} · ${planned.length} planned`,
        total ? ` · ${money(total)}` : '',
      ),
    ),
  );
}

function tabs() {
  const counts = {
    wishlist: state.items.filter((item) => item.status === 'wanted').length,
    plan: state.items.filter((item) => item.status === 'wanted' && item.planned).length,
    bought: state.items.filter((item) => item.status === 'bought').length,
  };
  const list = [
    { id: 'wishlist', label: 'Wishlist' },
    { id: 'plan', label: 'Plan' },
    { id: 'bought', label: 'Bought' },
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
        placeholder: 'Search wishes',
        'aria-label': 'Search wishes',
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
          'aria-label': 'Sort by',
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
      [{ id: 'all', emoji: '', label: 'All' }, ...CATEGORIES].map((category) =>
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
          category.emoji ? `${category.emoji} ${category.label}` : category.label,
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
      'No wishes yet',
      'Add the first thing Horovod needs. A photo or a shop link is enough.',
      h('button', { type: 'button', class: 'button primary', onclick: () => openForm() }, '＋ Add a wish'),
    );
  }
  const query = state.query.trim().toLowerCase();
  const list = wanted
    .filter((item) => state.category === 'all' || item.category === state.category)
    .filter((item) => !query || `${item.title} ${item.note} ${hostOf(item.link)}`.toLowerCase().includes(query))
    .sort(compareItems(state.sort));
  if (!list.length) return emptyState('🔍', 'Nothing matches', 'Try another search or category.');
  return h('div', { class: 'cards' }, list.map(card));
}

function planContent() {
  const groups = groupPlan(state.items, today());
  if (!groups.length) {
    return emptyState(
      '🗓',
      'Nothing planned yet',
      isAdmin()
        ? 'Tap “Planned” on a wish and pick when we’re buying it. It will show up here, month by month.'
        : 'When we decide to buy something, it shows up here with its date.',
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
      h('div', {}, h('div', { class: 'summary-label' }, 'Planned spending'), h('div', { class: 'summary-value' }, money(total))),
      h(
        'div',
        { class: 'summary-side' },
        h('div', {}, `${planned.length} ${planned.length === 1 ? 'item' : 'items'}`),
        soon.total ? h('div', {}, `${money(soon.total)} this month`) : null,
        missing ? h('div', {}, `${missing} without price`) : null,
      ),
    ),
    groups.map((group) =>
      h(
        'section',
        { class: 'group' },
        groupHead(group.title, {
          note: group.note,
          tone: group.key === 'overdue' ? 'overdue' : group.note === 'This month' ? 'soon' : null,
          total: group.total,
          missing: group.missing,
        }),
        h('div', { class: 'cards' }, group.items.map(card)),
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
    content.push(emptyState('🛍', 'Nothing bought yet', 'Things we buy end up here, so we can see what we spent.'));
  } else {
    content.push(
      h(
        'div',
        { class: 'summary' },
        h(
          'div',
          {},
          h('div', { class: 'summary-label' }, `Spent in ${year}`),
          h('div', { class: 'summary-value' }, money(spentThisYear.total)),
        ),
      ),
      groups.map((group) =>
        h(
          'section',
          { class: 'group' },
          groupHead(group.title, { total: group.total, missing: group.missing, prefix: 'Spent ' }),
          h('div', { class: 'cards' }, group.items.map(card)),
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
        `${state.showDropped ? 'Hide' : 'Show'} dropped wishes (${dropped.length})`,
      ),
      state.showDropped ? h('div', { class: 'cards' }, dropped.map(card)) : null,
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

function render() {
  const app = document.getElementById('app');
  if (state.error) {
    fill(app, 
      emptyState(
        state.error.emoji || '⚠️',
        state.error.title,
        state.error.text,
        state.error.retry
          ? h('button', { type: 'button', class: 'button primary', onclick: () => location.reload() }, 'Try again')
          : null,
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
    h('button', { type: 'button', class: 'fab', onclick: () => openForm() }, '＋ Add a wish'),
  );
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Month chips for the next 12 months, an exact-day picker and "not sure yet".
 * `onPick` gets { plannedDate, plannedPrecision }.
 */
function planPicker({ current, onPick, confirmDay = false }) {
  const now = today();
  const months = Array.from({ length: 12 }, (_, index) => addMonths(now, index));
  const selectedMonth = current?.planned && current.plannedPrecision === 'month' ? current.plannedDate : null;
  const selectedDay = current?.planned && current.plannedPrecision === 'day' ? current.plannedDate : '';

  const dayInput = h('input', {
    type: 'date',
    min: now,
    value: selectedDay,
    'aria-label': 'Exact day',
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
      disabled: !isValidDate(selectedDay),
      onclick: () => isValidDate(dayInput.value) && onPick({ plannedDate: dayInput.value, plannedPrecision: 'day' }),
    },
    'Set',
  );

  return h(
    'div',
    { class: 'plan-picker' },
    h('div', { class: 'picker-label' }, 'Which month?'),
    h(
      'div',
      { class: 'month-grid' },
      months.map((month, index) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${selectedMonth === month ? ' selected' : ''}`,
            onclick: () => onPick({ plannedDate: month, plannedPrecision: 'month' }),
          },
          index === 0 ? 'This month' : index === 1 ? 'Next month' : formatShortMonth(month, now),
        ),
      ),
    ),
    h('div', { class: 'picker-label' }, 'Or an exact day'),
    h('div', { class: 'day-row' }, dayInput, confirmDay ? setDay : null),
    h(
      'button',
      {
        type: 'button',
        class: `chip wide${current?.planned && !current.plannedDate ? ' selected' : ''}`,
        onclick: () => onPick({ plannedDate: null, plannedPrecision: null }),
      },
      'Not sure yet, just mark it as planned',
    ),
  );
}

function openWhenSheet(item) {
  haptic.tap();
  const sheet = openSheet({
    title: item.planned ? 'Change the date' : 'When are we buying it?',
    render: () => [
      h('p', { class: 'sheet-subtitle' }, item.title),
      planPicker({
        current: item,
        confirmDay: true,
        onPick: async (value) => {
          try {
            await save(item.id, { planned: true, ...value }, 'Planned 🗓');
            sheet.close();
          } catch {
            // toast already shown
          }
        },
      }),
      item.planned
        ? h(
            'button',
            {
              type: 'button',
              class: 'button ghost danger block',
              onclick: async () => {
                try {
                  await save(item.id, { planned: false }, 'Removed from the plan');
                  sheet.close();
                } catch {
                  // toast already shown
                }
              },
            },
            'Not planning to buy it anymore',
          )
        : null,
    ],
  });
}

function planSection(item, sheet) {
  const plan = describePlan(item, today());
  const bigDate = plan
    ? h(
        'div',
        { class: `plan-big tone-text-${plan.tone}` },
        '🗓 ',
        h('b', {}, plan.label),
        plan.tone === 'nodate' ? ' · date not set yet' : ` · ${plan.detail}`,
      )
    : null;

  if (!isAdmin()) {
    return h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-label' }, 'Planning to buy'),
      bigDate || h('div', { class: 'muted' }, 'Not planned yet. Vote 👍 if we need it!'),
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
        h('b', {}, 'Planning to buy'),
        h('small', {}, item.planned ? 'We’re planning to buy this' : 'Switch on and pick when'),
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
          if (item.planned) await save(item.id, { planned: false }, 'Removed from the plan').catch(() => {});
          sheet.refresh();
        },
      }),
    ),
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
                sheet.refresh();
              },
            },
            'Change',
          ),
        )
      : null,
    showPicker
      ? planPicker({
          current: item,
          confirmDay: true,
          onPick: async (value) => {
            try {
              await save(item.id, { planned: true, ...value }, 'Planned 🗓');
              sheet.ui.picking = false;
              sheet.refresh();
            } catch {
              // toast already shown
            }
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
        h('button', { type: 'button', class: 'button primary block', onclick: () => openBoughtSheet(item) }, '✅ Mark as bought'),
      );
    }
    const row = [];
    if (canEdit) row.push(h('button', { type: 'button', class: 'button', onclick: () => openForm(item) }, '✏️ Edit'));
    if (admin) {
      row.push(
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            onclick: async () => {
              if (await confirmAction('Drop this wish? You can bring it back later from the Bought tab.')) {
                save(item.id, { status: 'dropped' }, 'Dropped').catch(() => {});
              }
            },
          },
          '🗄 Drop',
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
            onclick: () => save(item.id, { status: 'wanted' }, 'Back on the wishlist').catch(() => {}),
          },
          '↩️ Back to wishlist',
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
      total != null ? money(total) : h('span', { class: 'muted' }, 'No price yet'),
      total != null && item.quantity > 1 ? h('small', {}, ` · ${item.quantity} × ${money(item.price)}`) : null,
    ),
    item.link
      ? h(
          'button',
          { type: 'button', class: 'link-button', onclick: () => openExternal(item.link) },
          h('span', {}, '🔗 ', hostOf(item.link)),
          h('span', { class: 'muted' }, 'Open ↗'),
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
            ? h('div', { class: 'muted' }, `Paid ${money(item.boughtPrice)}`)
            : null,
        ),
    item.status === 'wanted'
      ? h(
          'div',
          { class: 'votes-row' },
          voteButton(item, { withLabel: true }),
          h('span', { class: 'muted small' }, item.voters.length ? item.voters.join(', ') : 'No votes yet'),
        )
      : null,
    h(
      'p',
      { class: 'muted small added-by' },
      `Added by ${item.createdBy?.name || 'someone'} · ${formatDay(item.createdAt.slice(0, 10), today())}`,
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
        if (!(await confirmAction('Delete this wish for good?'))) return;
        try {
          await api(`/api/items/${item.id}`, { method: 'DELETE' });
          state.items = state.items.filter((candidate) => candidate.id !== item.id);
          sheet.close();
          refreshAll();
          toast('Deleted');
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    },
    '🗑 Delete',
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
    'aria-label': 'Price paid',
  });
  const dateInput = h('input', { type: 'date', value: today(), max: today(), 'aria-label': 'Bought on' });
  const sheet = openSheet({
    title: 'Mark as bought',
    render: () => [
      h('p', { class: 'sheet-subtitle' }, item.title),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Price paid'), moneyInput(priceInput)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Bought on'), dateInput),
      h(
        'button',
        {
          type: 'button',
          class: 'button primary block',
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await save(
                item.id,
                {
                  status: 'bought',
                  boughtPrice: priceInput.value.trim() === '' ? null : priceInput.value,
                  boughtAt: dateInput.value || today(),
                },
                'Bought! 🎉',
              );
              sheet.close();
            } catch {
              button.disabled = false;
            }
          },
        },
        'Mark as bought',
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

/** Shrinks big phone photos before uploading. Falls back to the original file. */
async function shrinkImage(file, maxSide = 1600) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (blob) return blob;
  } catch {
    // Unsupported format in this browser: let the server decide.
  }
  return file;
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
    placeholder: 'Paste a shop or product link',
    'aria-label': 'Link',
    value: existing?.link || '',
  });
  const linkHint = h('div', { class: 'field-hint' });
  const imageBox = h('div', { class: 'image-box' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const titleInput = h('input', {
    type: 'text',
    maxlength: '200',
    placeholder: 'e.g. Shure SM58 microphone',
    'aria-label': 'Name',
    value: existing?.title || '',
  });
  const priceInput = h('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0',
    'aria-label': 'Price per piece',
    value: existing?.price ?? '',
  });
  const noteInput = h('textarea', {
    rows: '3',
    maxlength: '2000',
    placeholder: 'Why do we need it? Model, size, colour…',
    'aria-label': 'Note',
    value: existing?.note || '',
  });
  const quantityValue = h('span', { class: 'quantity-value' }, form.quantity);
  const requirement = h('div', { class: 'requirement' });
  const saveButton = h('button', { type: 'submit', class: 'button primary block' }, existing ? 'Save changes' : 'Add to wishlist');
  const planWrap = h('div');

  function validate() {
    const hasSource = linkInput.value.trim() || form.image;
    const hasTitle = titleInput.value.trim();
    requirement.textContent = !hasSource
      ? 'Add a photo or a link. One of them is required.'
      : !hasTitle
        ? 'Give it a name.'
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
            h('span', { class: 'image-empty-icon' }, '📷'),
            h('span', {}, 'Add a photo'),
            h('small', {}, 'or paste a link above and we’ll grab the picture'),
          ),
      busy ? h('div', { class: 'image-busy' }, h('span', { class: 'spinner' })) : null,
      form.imageUrl
        ? h(
            'div',
            { class: 'image-actions' },
            h('button', { type: 'button', class: 'button small', onclick: () => fileInput.click() }, 'Replace'),
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
              'Remove',
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
    setHint('Looking at the link…', 'loading');
    drawImage();
    try {
      const preview = await api(`/api/preview?url=${encodeURIComponent(value)}`);
      if (seq !== lookupSeq) return;
      const found = [];
      if (preview.image && form.imageSource !== 'upload') {
        Object.assign(form, { image: preview.image, imageUrl: preview.imageUrl, imageSource: 'link' });
        found.push('picture');
      }
      if (preview.title && !titleInput.value.trim()) {
        titleInput.value = preview.title;
        found.push('name');
      }
      let otherCurrency = '';
      if (preview.price != null && !priceInput.value.trim()) {
        if (!preview.currency || preview.currency === currency()) {
          priceInput.value = preview.price;
          found.push('price');
        } else {
          otherCurrency = ` The shop shows ${preview.price} ${preview.currency}.`;
        }
      }
      const site = preview.siteName || hostOf(preview.link);
      if (found.length) {
        const list = found.length > 1 ? `${found.slice(0, -1).join(', ')} and ${found.at(-1)}` : found[0];
        setHint(`✓ Got the ${list} from ${site}.${otherCurrency}`, 'ok');
      } else {
        setHint(`Saved the link to ${site}.${otherCurrency}`, 'ok');
      }
      if (!preview.image && !form.image) {
        setHint(`${linkHint.textContent} No picture found there. The link is enough, or add a photo.`, 'warn');
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
      const blob = await shrinkImage(file);
      const result = await api('/api/uploads', {
        method: 'POST',
        raw: blob,
        contentType: blob.type || 'application/octet-stream',
      });
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
            `${option.emoji} ${option.label}`,
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
            h('b', {}, 'Planning to buy'),
            h('small', {}, plan ? `${plan.label}${planText(plan)}` : 'Not planned yet'),
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
    saveButton.textContent = 'Saving…';
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
      const { item } = await api(existing ? `/api/items/${existing.id}` : '/api/items', {
        method: existing ? 'PATCH' : 'POST',
        body,
      });
      if (!existing && state.tab === 'bought') state.tab = 'wishlist';
      upsert(item);
      haptic.success();
      toast(existing ? 'Saved' : 'Added to the wishlist 🎉');
      sheet.close();
    } catch (error) {
      haptic.error();
      toast(error.message, 'error');
      saving = false;
      saveButton.textContent = existing ? 'Save changes' : 'Add to wishlist';
      validate();
    }
  }

  drawImage();
  if (admin && (!existing || existing.status === 'wanted')) drawPlan();
  validate();

  const field = (label, ...controls) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), controls);

  const sheet = openSheet({
    title: existing ? 'Edit wish' : 'Add a wish',
    tall: true,
    render: () =>
      h(
        'form',
        { class: 'form', onsubmit: submit, novalidate: true },
        field('Link', linkInput, linkHint),
        field('Photo', imageBox, fileInput),
        field('Name', titleInput),
        field('Category', choice(CATEGORIES, 'category')),
        field('Priority', choice(PRIORITIES, 'priority')),
        h(
          'div',
          { class: 'field-row' },
          field('Price per piece', moneyInput(priceInput)),
          field(
            'Quantity',
            h(
              'div',
              { class: 'stepper' },
              h('button', { type: 'button', 'aria-label': 'Fewer', onclick: () => stepQuantity(-1) }, '−'),
              quantityValue,
              h('button', { type: 'button', 'aria-label': 'More', onclick: () => stepQuantity(1) }, '+'),
            ),
          ),
        ),
        field('Note', noteInput),
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
  document.documentElement.dataset.scheme = tg.colorScheme === 'dark' ? 'dark' : 'light';
  if (supports('6.1')) {
    tg.setHeaderColor('secondary_bg_color');
    tg.setBackgroundColor('secondary_bg_color');
  }
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    if (supports('7.7')) tg.disableVerticalSwipes();
    applyTheme();
    tg.onEvent('themeChanged', applyTheme);
  }
  render();

  if (!initData) {
    state.error = {
      emoji: '📱',
      title: 'Open this in Telegram',
      text: 'The HOROVOD wishlist runs inside Telegram. Open it from the HOROVOD bot.',
    };
    render();
    return;
  }

  try {
    const [me, { items }] = await Promise.all([api('/api/me'), api('/api/items')]);
    state.me = me;
    state.items = items;
    state.loaded = true;
  } catch (error) {
    state.error =
      error.status === 403
        ? { emoji: '🔒', title: 'Members only', text: `${error.message} Ask an admin to add you to the HOROVOD group.` }
        : { title: 'Couldn’t load the wishlist', text: error.message, retry: true };
    render();
    return;
  }

  const start = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('startapp') || '';
  if (start === 'plan') state.tab = 'plan';
  render();
  if (start.startsWith('item_') && state.items.some((item) => item.id === start.slice(5))) openDetail(start.slice(5));

  // Pick up what others added while the app was in the background.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reload();
  });
}

boot();
