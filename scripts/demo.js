// Fills a separate data folder (data-demo/) with a realistic sample wishlist,
// so you can see how the app looks before adding real wishes:
//
//   npm run demo                       # creates data-demo/
//   DATA_DIR=data-demo npm start       # run the app on it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, addMonths, todayIn } from '../public/lib/shared.js';
import { saveImage } from '../src/images.js';
import { newItem } from '../src/items.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data-demo');
const uploadsDir = path.join(dataDir, 'uploads');
fs.rmSync(dataDir, { recursive: true, force: true });

const today = todayIn('Europe/Bratislava');
const people = {
  misha: { id: 1, first_name: 'Миша' },
  nastya: { id: 2, first_name: 'Настя' },
  bogdan: { id: 3, first_name: 'Богдан' },
  olya: { id: 4, first_name: 'Оля' },
};
const voters = (...names) => names.map((name) => ({ id: people[name].id, name: people[name].first_name }));
const day = (n) => ({ planned: true, plannedDate: addDays(today, n), plannedPrecision: 'day' });
const month = (n) => ({ planned: true, plannedDate: addMonths(today, n), plannedPrecision: 'month' });

const wishes = [
  ['bogdan', 'mic', { title: 'Микрофоны Shure SM58', link: 'https://www.thomann.de/intl/shure_sm58_lce.htm', category: 'tech', priority: 'must', price: 99, quantity: 2, note: 'Сейчас рабочий только один. Нужны ещё два — для бэк-вокала на квартирниках.', ...day(1), votes: voters('nastya', 'olya', 'misha', 'bogdan') }],
  ['nastya', 'foam', { title: 'Акустический поролон на заднюю стену', link: 'https://www.muziker.sk/akusticke-panely', category: 'hub', priority: 'must', price: 18.5, quantity: 12, note: 'Задняя стена сильно звенит. 12 панелей 50×50 см закроют её полностью.', ...month(0), votes: voters('nastya', 'bogdan', 'olya') }],
  ['bogdan', 'throne', { title: 'Стул барабанщика Millenium MDT2', link: 'https://www.thomann.de/intl/millenium_mdt2_drum_throne.htm', category: 'hub', priority: 'must', price: 39.9, note: 'Старый шатается, опасно.', ...day(-3) }],
  ['olya', 'bassamp', { title: 'Басовый комбик Ampeg BA-110', link: 'https://www.thomann.de/intl/ampeg_ba_110_v2.htm', category: 'instruments', priority: 'nice', price: 229, note: 'Для репетиций хватит 40 Вт. Сейчас бас идёт в пульт.', ...month(1), votes: voters('olya', 'bogdan') }],
  ['nastya', 'lights', { title: 'LED-прожекторы для сцены', link: 'https://www.muziker.sk/led-par', category: 'hub', priority: 'nice', price: 35, quantity: 4, note: 'Тёплый свет для квартирников и фото.', ...day(18), votes: voters('nastya') }],
  ['olya', 'snare', { title: 'Малый барабан Pearl Sensitone 14"', link: 'https://www.thomann.de/intl/pearl_sensitone_14x5_steel.htm', category: 'instruments', priority: 'nice', price: 289, ...month(2) }],
  ['misha', 'xlr', { title: 'Кабели XLR 5 м, набор из 6', link: 'https://www.thomann.de/intl/the_sssnake_xlr_cable_set.htm', category: 'tech', priority: 'nice', price: 54, planned: true }],
  ['misha', 'mixer', { title: 'Цифровой пульт Behringer X32 Compact', link: 'https://www.thomann.de/intl/behringer_x32_compact.htm', category: 'tech', priority: 'dream', price: 1999, note: 'Мечта на будущее — запись репетиций и концертов в многодорожку.', votes: voters('misha', 'bogdan', 'olya', 'nastya') }],
  ['olya', 'kettle', { title: 'Электрочайник для Хаба', link: 'https://www.alza.sk/rychlovarna-kanvica', category: 'hub', priority: 'nice', price: 29, votes: voters('olya', 'nastya', 'misha') }],
  ['bogdan', 'kbstand', { title: 'Стойка для клавиш, двойная', link: 'https://www.muziker.sk/stojan-na-klavesy', category: 'instruments', priority: 'nice', price: 45 }],
  ['bogdan', 'tuner', { title: 'Тюнер-прищепка', link: 'https://www.thomann.de/intl/clip_tuner.htm', category: 'instruments', priority: 'nice', price: 15, status: 'bought', boughtAt: addDays(today, -10), boughtPrice: 12.9 }],
  ['nastya', 'micstand', { title: 'Микрофонная стойка «журавль»', link: 'https://www.thomann.de/intl/mic_stand.htm', category: 'tech', priority: 'must', price: 25, status: 'bought', boughtAt: addDays(today, -12), boughtPrice: 22 }],
  ['misha', 'strip', { title: 'Удлинитель на 5 розеток', link: 'https://www.alza.sk/predlzovaci-kabel', category: 'hub', priority: 'must', price: 14, status: 'bought', boughtAt: addDays(today, -41), boughtPrice: 13.5 }],
  ['olya', 'coffee', { title: 'Кофемашина', link: 'https://www.alza.sk/kavovar', category: 'hub', priority: 'dream', price: 320, status: 'dropped' }],
];

const items = wishes.map(([who, picture, fields]) => {
  const image = saveImage(fs.readFileSync(path.join(root, 'scripts', 'demo', `${picture}.png`)), uploadsDir);
  return newItem({ image, imageSource: 'link', ...fields }, { user: people[who], currency: 'EUR' });
});
fs.writeFileSync(path.join(dataDir, 'wishlist.json'), JSON.stringify({ items, meta: {} }, null, 2));
console.log(`Demo wishlist with ${items.length} items written to data-demo/. Start it with: DATA_DIR=data-demo npm start`);
