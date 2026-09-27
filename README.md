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
- 👍 **Votes** show what people want most; the details show who voted.
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

## Setting it up

### 1. Host it somewhere with HTTPS

Telegram only opens Mini Apps from an `https://` address, so the app needs a server. The simplest
option is any small Linux server (VPS) with Docker, and a subdomain like `wishlist.horovod.sk`
pointing at it:

```sh
git clone https://github.com/popovnehuligan/hrvdhub.git && cd hrvdhub
cp .env.example .env        # then fill in BOT_TOKEN, PUBLIC_URL and DOMAIN
docker compose up -d --build
```

`docker-compose.yml` runs the app plus [Caddy](https://caddyserver.com), which gets and renews
the HTTPS certificate automatically.

You can run it without Docker too. Any host with **Node.js 20.12+** works: run `npm start` behind
an HTTPS proxy. There are no dependencies to install.

All the data lives in one folder (`data/`, or the `wishlist_data` Docker volume): `wishlist.json`
plus the photos in `uploads/`. The app keeps a daily copy of `wishlist.json` in `data/backups/`
(the last 30 days). Back up that folder and you have everything.

### 2. Connect the bot

1. In **@BotFather**: `/mybots` → your bot → **Bot Settings** → **Configure Mini App** →
   **Enable Mini App**, and send your `PUBLIC_URL`. This adds the *Open* button to the bot's
   profile and makes the buttons in group messages open the app.
2. Add the bot to the HOROVOD group and send `/chatid` there. Put that number (it looks like
   `-1001234567890`) in `GROUP_CHAT_ID` in `.env`.
3. Restart the app with `docker compose up -d`. The bot sets up its menu button and commands by
   itself.

Now anyone in the group can open the wishlist from the bot's **Wishlist** menu button, or from
the buttons on the bot's group messages.

### Settings (`.env`)

| Setting | What it's for |
| --- | --- |
| `BOT_TOKEN` | **Required.** The token from @BotFather. Keep it secret: it lives only in `.env`, which is never committed. |
| `PUBLIC_URL` | The app's https address, e.g. `https://wishlist.horovod.sk`. |
| `DOMAIN` | The same domain without `https://`. Only used by Caddy in docker-compose. |
| `GROUP_CHAT_ID` | The HOROVOD group. Its members can use the app and its admins are app admins. |
| `ADMIN_IDS`, `ALLOWED_USER_IDS` | Optional extra admins / members by Telegram user ID (comma separated). Send `/chatid` to the bot privately to see your ID. |
| `NOTIFY_CHAT_ID` | Optional: post news and reminders to another chat instead of the group. |
| `APP_LINK` | Optional: the link used on group-message buttons if you registered the app with `/newapp`, e.g. `https://t.me/horovod_bot/wishlist`. |
| `CURRENCY` | Default `EUR`. |
| `TIMEZONE`, `REMINDER_HOUR` | When the daily reminder goes out. Default: 10:00 `Europe/Bratislava`. |

If neither `GROUP_CHAT_ID` nor `ALLOWED_USER_IDS` is set, anyone who opens the bot can use the
app, and everyone is an admin unless `ADMIN_IDS` is set. That's handy for trying it out; set
`GROUP_CHAT_ID` before sharing it.

## Development

```sh
npm test                             # run the tests
cp .env.example .env                 # add BOT_TOKEN
npm run dev                          # start with auto-reload on http://localhost:3000
npm run dev-link -- <your user id>   # prints a link that opens the app in a normal browser as you
```

The project has no dependencies and no build step:

- `src/`: the server. `server.js` has the web API, `bot.js` the Telegram bot, `preview.js` reads
  pictures and prices from shop links, `auth.js` checks Telegram logins and group membership,
  and `store.js` saves the data.
- `public/`: the Mini App. `app.js` has the screens and `styles.css` the calm HOROVOD look (Manrope,
  cream, charcoal and ochre from the 2026 sponsorship booklet) in light and dark.
  `public/brand/` holds the eye logo and the Manrope font (SIL Open Font License).
- `public/lib/shared.js`: date, price and plan logic used by both the app and the bot.

Security notes:
- Every request is checked against Telegram's signed login data, and group membership is checked
  with Telegram.
- Link previews only fetch public internet addresses, never the server's own network.
- Uploads must be real JPG/PNG/WebP/GIF/AVIF images.

## Ideas for later

- Members chip in toward a purchase, and a monthly budget limit.
- Alerts when a saved link's price drops.
- Several shop links per wish, to compare prices.
- Receipts, and tracking who paid and who's been paid back.
- Bought items go into a Horovod Hub equipment list with warranty dates.
- Syncing with Notion.
- Consumables (strings, sticks, batteries) that come back onto the list automatically.
