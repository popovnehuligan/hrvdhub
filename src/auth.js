import crypto from 'node:crypto';

const MAX_AGE_SECONDS = 24 * 60 * 60;

const secretKey = (botToken) => crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

function dataCheckString(params) {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Checks the `initData` string Telegram hands to a Mini App.
 * See https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns { user, startParam } when the signature is valid and fresh, otherwise null.
 */
export function validateInitData(initData, botToken, { maxAgeSeconds = MAX_AGE_SECONDS, now = Date.now() } = {}) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;

  const expected = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSeconds) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id)) return null;
  return { user, startParam: params.get('start_param') || null };
}

/** Builds a correctly signed initData string. Used by tests and scripts/dev-link.js. */
export function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const hash = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);
const ADMIN_STATUSES = new Set(['creator', 'administrator']);

/**
 * Who may use the app, and who is an admin:
 *  - With GROUP_CHAT_ID: members of that Telegram group may use it; the group's admins are app admins.
 *  - ALLOWED_USER_IDS / ADMIN_IDS add people explicitly.
 *  - With neither a group nor an allow-list, anyone who opens the bot can use it (fine for trying it out).
 *  - When no admin is configured at all, everyone who is allowed in is an admin.
 */
export function createAccessControl(config, telegram) {
  const cache = new Map();
  const openToAll = !config.groupChatId && config.allowedUserIds.size === 0;
  const everyoneIsAdmin = !config.groupChatId && config.adminIds.size === 0;

  async function lookup(userId) {
    let allowed = openToAll || config.adminIds.has(userId) || config.allowedUserIds.has(userId);
    let admin = config.adminIds.has(userId);

    if (config.groupChatId) {
      try {
        const member = await telegram.call('getChatMember', { chat_id: config.groupChatId, user_id: userId });
        if (MEMBER_STATUSES.has(member.status) || (member.status === 'restricted' && member.is_member)) allowed = true;
        if (ADMIN_STATUSES.has(member.status)) admin = true;
      } catch (error) {
        // 400 means "not in this chat"; anything else is Telegram being unreachable.
        if (error.code !== 400 && !allowed) throw error;
      }
    }
    if (everyoneIsAdmin) admin = allowed;
    return { allowed, admin };
  }

  return {
    async check(userId) {
      const cached = cache.get(userId);
      if (cached && cached.expires > Date.now()) return cached.result;
      const result = await lookup(userId);
      // Remember members for 10 minutes; re-check refusals soon so newly added people get in quickly.
      cache.set(userId, { result, expires: Date.now() + (result.allowed ? 10 : 1) * 60_000 });
      return result;
    },
  };
}
