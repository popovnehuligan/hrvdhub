# HOROVOD Wishlist

A Telegram Mini App where HOROVOD keeps track of everything it wants to buy: gear for the
**Horovod Hub** rehearsal room, instruments, tech, and anything else. It opens from the HOROVOD
bot, inside Telegram. The app and the bot's messages are in Russian.

## What it does

**Adding wishes**
- Every wish needs a **photo or a link**. Paste a shop link and the app fetches the product's
  picture, name and price automatically. You can also upload a photo from your phone.
- Each wish has a category (🏠 Horovod Hub, 🎸 Instruments, 🎛️ Tech & audio, 📦 Other), a
  priority (🔴 Must-have, 🟡 Nice to have, ✨ Dream), a price, a quantity and a note.

**Planning when to buy**
- Each wish has a **Planned** toggle. Switch it on and pick *this month*, *next month*, any of the
  next 12 months, an exact day, or *not sure yet*.
- Every card shows the plan in colour: 🔴 *3 days overdue*, 🟠 *Tomorrow · Mon 28 Sep* or
  *This month*, 🔵 *Next month · October 2026*, 🟣 *In 4 months*, grey *Planned · date not set*.
- The **Plan** tab groups planned purchases month by month, with the total for each month and
  overall.

**Team**
- ♥ **Hearts** (votes) show what people want most; the details show who liked it.
- **Bought** records the price actually paid and the date. The Bought tab shows spending per month
  and for the year. Wishes you decide against can be **dropped** and brought back later.
- Search, category filters, and sorting by buy date, votes, priority, price or newest.
- **Members only**: people in the HOROVOD Telegram group can use it. The group's admins are the
  app's admins.
  - Members can add wishes, vote, and edit or delete their own wishes.
  - Admins can also plan purchases, mark wishes as bought or dropped, and edit anything.
- **The bot posts to the group** when a wish is added, planned or bought, with the photo and a
  button that opens that wish. It also sends a daily **"coming up to buy"** reminder when a planned
  date is close.
- Bot commands: `/wishlist` opens the app, `/plan` lists the purchase plan, and `/chatid` shows a
  chat's ID (for setup).

## How it runs

| Part | Where |
|---|---|
| The screens (`public/`) | **GitHub Pages**, free: `https://popovnehuligan.github.io/hrvdhub/` |
| The server (`worker/`) | **Cloudflare Workers**, free: `https://hrvd-wishlist.horovod.workers.dev` — answers in ~0.2 s and never sleeps |
| The data | Cloudflare **D1** database `hrvd-wishlist` (tables `wishes`, `votes`, `props`, `rids`, see `worker/schema.sql`) |
| Photos | Cloudflare **KV** `hrvd-wishlist-photos` (each with a ~480px copy for the cards); photos from before the move stay on Google Drive |
| Hourly job | Cloudflare cron: posts that didn't go through, groups the bot was added to, the morning reminder |
| The server's address | `public/config.js` |

The server was a Google Apps Script (`apps-script/`) until 30.09.2026; it took up to 20 s to wake
up. It still answers app copies Telegram has cached (the list only, no changes: `MOVED_TO`), and can
be switched off in its Apps Script editor once nobody uses the old copies.

### Deploying the server

```sh
cd worker && npm install
export CLOUDFLARE_API_TOKEN=…   # a token with "Edit Cloudflare Workers" + D1 Edit
npx wrangler deploy --var VERSION:$(git rev-parse --short HEAD)
```
The bot key is a Worker secret (`npx wrangler secret put BOT_TOKEN`). Settings (`GROUP_CHAT_ID`,
`TOPIC_ID`, `ADMIN_IDS`, `NOTIFY_CHAT_ID`, `CURRENCY`, `REMINDER_HOUR`, `ACCESS_GROUPS`, …) live in the
`props` table: `npx wrangler d1 execute hrvd-wishlist --remote --command "…"`.
`GET /` shows the version and a status without names or ids.

## Development

```sh
npm test                    # tests: shared rules, and the Apps Script run against a pretend Google
node tools/build-gs.mjs     # after changing public/lib/shared.js: regenerates apps-script/Shared.gs
cd public && python3 -m http.server 8000   # look at the app locally (demo mode)
```

- `public/`: the Mini App. `app.js` the screens, `api.js` the data layer (Apps Script or demo),
  `styles.css` the HOROVOD look (Manrope, cream, charcoal and ochre from the 2026 sponsorship booklet),
  `demo/` the sample wishlist, `brand/` the eye logo and the Manrope font (SIL Open Font License).
- `public/lib/shared.js`: the wish rules, dates and money, used by both the app and Apps Script.
- `apps-script/`: the Google side. `Shared.gs` is generated, edit `shared.js` instead.
- `src/`, `test/api|auth|bot|preview.test.js`, `scripts/`: the earlier own-server version (Node.js),
  no longer used by the app. Kept until you decide to remove it.

## Ideas for later

- Members chip in toward a purchase, and a monthly budget limit.
- Alerts when a saved link's price drops.
- Several shop links per wish, to compare prices.
- Receipts, and tracking who paid and who's been paid back.
- Bought items go into a Horovod Hub equipment list with warranty dates.
- Syncing with Notion.
- Consumables (strings, sticks, batteries) that come back onto the list automatically.
