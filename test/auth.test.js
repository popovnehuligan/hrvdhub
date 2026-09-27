import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccessControl, signInitData, validateInitData } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { BOT_TOKEN, fakeTelegram } from './helpers.js';

const user = { id: 1001, first_name: 'Anna', username: 'anna' };
const now = Date.now();
const fresh = () => signInitData({ auth_date: Math.floor(now / 1000), user, start_param: 'item_abc' }, BOT_TOKEN);

test('accepts correctly signed initData', () => {
  const session = validateInitData(fresh(), BOT_TOKEN, { now });
  assert.equal(session.user.id, 1001);
  assert.equal(session.startParam, 'item_abc');
});

test('keeps fields like signature in the checked data', () => {
  const data = signInitData({ auth_date: Math.floor(now / 1000), user, signature: 'abc' }, BOT_TOKEN);
  assert.ok(validateInitData(data, BOT_TOKEN, { now }));
});

test('rejects tampered, foreign, expired or empty initData', () => {
  const tampered = fresh().replace('Anna', 'Mallory');
  assert.equal(validateInitData(tampered, BOT_TOKEN, { now }), null);
  assert.equal(validateInitData(fresh(), '999:other-bot-token', { now }), null);
  const old = signInitData({ auth_date: Math.floor(now / 1000) - 2 * 86400, user }, BOT_TOKEN);
  assert.equal(validateInitData(old, BOT_TOKEN, { now }), null);
  assert.equal(validateInitData('', BOT_TOKEN), null);
  assert.equal(validateInitData('hash=zzz', BOT_TOKEN), null);
});

const config = (env) => loadConfig({ BOT_TOKEN, ...env });

test('group members may use the app and group admins are app admins', async () => {
  const telegram = fakeTelegram({ members: { 1: 'creator', 2: 'administrator', 3: 'member', 4: 'left', 5: 'kicked' } });
  const access = createAccessControl(config({ GROUP_CHAT_ID: '-100123' }), telegram);
  assert.deepEqual(await access.check(1), { allowed: true, admin: true });
  assert.deepEqual(await access.check(2), { allowed: true, admin: true });
  assert.deepEqual(await access.check(3), { allowed: true, admin: false });
  assert.deepEqual(await access.check(4), { allowed: false, admin: false });
  assert.deepEqual(await access.check(5), { allowed: false, admin: false });
  assert.deepEqual(await access.check(6), { allowed: false, admin: false });
  await access.check(3);
  assert.equal(telegram.sent('getChatMember').filter((call) => call.params.user_id === 3).length, 1, 'cached');
});

test('ADMIN_IDS and ALLOWED_USER_IDS work without a group', async () => {
  const access = createAccessControl(config({ ADMIN_IDS: '1', ALLOWED_USER_IDS: '2, 3' }), fakeTelegram());
  assert.deepEqual(await access.check(1), { allowed: true, admin: true });
  assert.deepEqual(await access.check(2), { allowed: true, admin: false });
  assert.deepEqual(await access.check(9), { allowed: false, admin: false });
});

test('with nothing configured everyone is let in as admin', async () => {
  const access = createAccessControl(config({}), fakeTelegram());
  assert.deepEqual(await access.check(77), { allowed: true, admin: true });
});

test('ADMIN_IDS alone makes only those people admins', async () => {
  const access = createAccessControl(config({ ADMIN_IDS: '1' }), fakeTelegram());
  assert.deepEqual(await access.check(1), { allowed: true, admin: true });
  assert.deepEqual(await access.check(2), { allowed: true, admin: false });
});
