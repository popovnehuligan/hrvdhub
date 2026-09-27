import crypto from 'node:crypto';

/** A correctly signed Telegram initData string, as a Mini App would send it. */
export function signInitDataForTests(user, botToken, { authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE-test', user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
