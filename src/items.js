import crypto from 'node:crypto';
import { CATEGORIES, PRIORITIES, STATUSES, isValidDate } from '../public/lib/shared.js';
import { HttpError } from './http.js';
import { IMAGE_NAME } from './images.js';

const has = (object, key) => Object.hasOwn(object, key);

function text(value, label, max, { required = false } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}: нужен текст`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${label}: обязательное поле`);
  if (trimmed.length > max) throw new HttpError(400, `${label}: слишком длинно (максимум ${max} символов)`);
  return trimmed;
}

function money(value, label) {
  if (value === '' || value == null) return null;
  const number = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(number) || number < 0 || number > 10_000_000) throw new HttpError(400, `${label}: неверное значение`);
  return Math.round(number * 100) / 100;
}

function oneOf(value, options, label) {
  if (!options.includes(value)) throw new HttpError(400, `Неизвестное значение: ${label}`);
  return value;
}

/** Accepts "thomann.de/…" as well as full URLs; returns '' for empty input. */
export function normalizeLink(value) {
  const raw = text(value, 'Ссылка', 2000);
  if (!raw) return '';
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, 'Ссылка выглядит неправильно');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Поддерживаются только веб-ссылки');
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new HttpError(400, 'Ссылка выглядит неправильно');
  return url.href;
}

/**
 * Turns request input into a clean patch. Only fields present in the input are
 * touched. Planning and buying are admin-only.
 */
export function cleanItemInput(input, { isAdmin, isNew, today }) {
  const patch = {};
  if (isNew || has(input, 'title')) patch.title = text(input.title, 'Название', 200, { required: true });
  if (has(input, 'note')) patch.note = text(input.note, 'Заметка', 2000);
  if (has(input, 'link')) patch.link = normalizeLink(input.link);
  if (has(input, 'image')) {
    const image = input.image || null;
    if (image !== null && (typeof image !== 'string' || !IMAGE_NAME.test(image))) throw new HttpError(400, 'Неизвестная картинка');
    patch.image = image;
  }
  if (has(input, 'imageSource')) patch.imageSource = input.imageSource === 'upload' ? 'upload' : 'link';
  if (has(input, 'category')) patch.category = oneOf(input.category, CATEGORIES.map((c) => c.id), 'категория');
  if (has(input, 'priority')) patch.priority = oneOf(input.priority, PRIORITIES.map((p) => p.id), 'важность');
  if (has(input, 'price')) patch.price = money(input.price, 'Цена');
  if (has(input, 'quantity')) {
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, 'Количество: от 1 до 999');
    patch.quantity = quantity;
  }

  if (has(input, 'planned')) {
    if (!isAdmin) throw new HttpError(403, 'Планировать покупки могут только админы');
    patch.planned = Boolean(input.planned);
    patch.plannedDate = null;
    patch.plannedPrecision = null;
    if (patch.planned && input.plannedDate) {
      if (!isValidDate(input.plannedDate)) throw new HttpError(400, 'Дата выглядит неправильно');
      patch.plannedPrecision = input.plannedPrecision === 'month' ? 'month' : 'day';
      patch.plannedDate = patch.plannedPrecision === 'month' ? `${input.plannedDate.slice(0, 7)}-01` : input.plannedDate;
    }
  }

  if (has(input, 'status')) {
    if (!isAdmin) throw new HttpError(403, 'Отмечать покупки могут только админы');
    patch.status = oneOf(input.status, STATUSES, 'статус');
    patch.boughtAt = null;
    patch.boughtPrice = null;
    if (patch.status === 'bought') {
      const boughtAt = input.boughtAt || today;
      if (!isValidDate(boughtAt)) throw new HttpError(400, 'Дата выглядит неправильно');
      patch.boughtAt = boughtAt;
      patch.boughtPrice = money(input.boughtPrice, 'Оплачено');
    }
  }
  return patch;
}

export function userRef(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return { id: user.id, name: name || (user.username ? `@${user.username}` : 'Кто-то'), username: user.username || null };
}

export function newItem(patch, { user, currency }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomBytes(6).toString('base64url'),
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

/** What the Mini App gets to see of an item. */
export function publicItem(item, userId) {
  const { votes, remindedFor, ...rest } = item;
  return {
    ...rest,
    imageUrl: item.image ? `/uploads/${item.image}` : null,
    votes: votes.length,
    voters: votes.map((vote) => vote.name),
    voted: votes.some((vote) => vote.id === userId),
    mine: item.createdBy?.id === userId,
  };
}
