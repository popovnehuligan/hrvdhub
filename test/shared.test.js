import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMonths,
  compareItems,
  describePlan,
  formatDay,
  formatMoney,
  groupBought,
  groupPlan,
  itemTotal,
  sumTotals,
} from '../public/lib/shared.js';

const TODAY = '2026-09-27';
const planned = (plannedDate, plannedPrecision = 'day', extra = {}) => ({
  status: 'wanted',
  planned: true,
  plannedDate,
  plannedPrecision: plannedDate ? plannedPrecision : null,
  ...extra,
});

test('describePlan reads clearly for exact days', () => {
  assert.equal(describePlan({ planned: false }, TODAY), null);
  assert.deepEqual(describePlan(planned('2026-09-27'), TODAY), { tone: 'soon', label: 'Today', detail: 'Sun 27 Sep' });
  assert.equal(describePlan(planned('2026-09-28'), TODAY).label, 'Tomorrow');
  assert.equal(describePlan(planned('2026-10-01'), TODAY).label, 'In 4 days');
  assert.equal(describePlan(planned('2026-10-08'), TODAY).tone, 'upcoming');
  assert.equal(describePlan(planned('2026-10-25'), TODAY).label, 'In 4 weeks');
  assert.equal(describePlan(planned('2027-01-20'), TODAY).label, 'In 4 months');
  assert.equal(describePlan(planned('2027-01-20'), TODAY).detail, 'Wed 20 Jan 2027');
  assert.deepEqual(describePlan(planned('2026-09-24'), TODAY), {
    tone: 'overdue',
    label: '3 days overdue',
    detail: 'Thu 24 Sep',
  });
});

test('describePlan reads clearly for months and undated plans', () => {
  assert.deepEqual(describePlan(planned('2026-09-01', 'month'), TODAY), {
    tone: 'soon',
    label: 'This month',
    detail: 'September 2026',
  });
  assert.equal(describePlan(planned('2026-10-01', 'month'), TODAY).label, 'Next month');
  assert.equal(describePlan(planned('2027-02-01', 'month'), TODAY).label, 'In 5 months');
  assert.equal(describePlan(planned('2026-08-01', 'month'), TODAY).tone, 'overdue');
  assert.deepEqual(describePlan(planned(null), TODAY), { tone: 'nodate', label: 'Planned', detail: 'date not set' });
});

test('groupPlan orders overdue, months, then undated, with totals', () => {
  const items = [
    planned(null, null, { id: 'nodate', price: 10 }),
    planned('2026-11-01', 'month', { id: 'nov', price: 100, quantity: 2 }),
    planned('2026-09-20', 'day', { id: 'late', price: 5 }),
    planned('2026-10-03', 'day', { id: 'oct-day' }),
    planned('2026-10-01', 'month', { id: 'oct-month', price: 50 }),
    { id: 'wish', status: 'wanted', planned: false, price: 999 },
    planned('2026-10-02', 'day', { id: 'bought', status: 'bought' }),
  ];
  const groups = groupPlan(items, TODAY);
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.map((item) => item.id)]),
    [
      ['overdue', ['late']],
      ['2026-10', ['oct-day', 'oct-month']],
      ['2026-11', ['nov']],
      ['nodate', ['nodate']],
    ],
  );
  const october = groups[1];
  assert.equal(october.title, 'October 2026');
  assert.equal(october.note, 'Next month');
  assert.equal(october.total, 50);
  assert.equal(october.missing, 1);
  assert.equal(groups[2].total, 200);
});

test('groupBought groups by month with what was paid', () => {
  const groups = groupBought([
    { status: 'bought', boughtAt: '2026-09-02', boughtPrice: 80, price: 100 },
    { status: 'bought', boughtAt: '2026-09-20', boughtPrice: null, price: 20, quantity: 2 },
    { status: 'bought', boughtAt: '2026-08-10', boughtPrice: 5 },
    { status: 'dropped', boughtAt: null },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.title, group.total]),
    [
      ['September 2026', 120],
      ['August 2026', 5],
    ],
  );
});

test('compareItems sorts the wishlist by buy date, then priority and votes', () => {
  const items = [
    { id: 'dream', planned: false, priority: 'dream', votes: 9, createdAt: '1' },
    { id: 'must', planned: false, priority: 'must', votes: 0, createdAt: '2' },
    { id: 'must-voted', planned: false, priority: 'must', votes: 3, createdAt: '3' },
    planned('2026-10-01', 'month', { id: 'oct', priority: 'nice' }),
    planned('2026-10-05', 'day', { id: 'oct-5', priority: 'nice' }),
    planned(null, null, { id: 'tbd', priority: 'nice' }),
  ];
  assert.deepEqual(
    items.sort(compareItems('schedule')).map((item) => item.id),
    ['oct-5', 'oct', 'tbd', 'must-voted', 'must', 'dream'],
  );
  assert.deepEqual(
    items.sort(compareItems('votes')).map((item) => item.id).slice(0, 2),
    ['dream', 'must-voted'],
  );
});

test('money and dates format consistently', () => {
  assert.equal(formatMoney(1299, 'EUR'), '€1,299');
  assert.equal(formatMoney(12.5, 'EUR'), '€12.50');
  assert.equal(formatMoney(null, 'EUR'), '');
  assert.equal(itemTotal({ price: 19.99, quantity: 3 }), 59.97);
  assert.equal(itemTotal({ price: null }), null);
  assert.deepEqual(sumTotals([{ price: 1 }, { price: null }, { price: 2, quantity: 2 }]), { total: 5, missing: 1 });
  assert.equal(addMonths('2026-12-31', 1), '2027-01-01');
  assert.equal(formatDay('2026-10-12', TODAY), 'Mon 12 Oct');
});
