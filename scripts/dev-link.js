// Prints a link that opens the Mini App in a normal browser as a given Telegram user,
// signed with your BOT_TOKEN — handy for trying things out locally.
//
//   npm run dev-link -- <telegram user id> [first name]
import { signInitData } from '../src/auth.js';

try {
  process.loadEnvFile();
} catch {
  // settings may come from the environment instead
}

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN is not set (see .env.example).');
  process.exit(1);
}

const [id = '1', firstName = 'Tester'] = process.argv.slice(2);
const initData = signInitData(
  { auth_date: Math.floor(Date.now() / 1000), user: { id: Number(id), first_name: firstName } },
  token,
);
const base = process.env.DEV_URL || `http://localhost:${process.env.PORT || 3000}`;
console.log(`${base}/#tgWebAppData=${encodeURIComponent(initData)}`);
