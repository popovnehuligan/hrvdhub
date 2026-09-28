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

## How it runs (same as the bar bot)

No server to rent, like [horovodart/hrvdbarbot](https://github.com/horovodart/hrvdbarbot):

| Part | Where |
|---|---|
| The screens (`public/`) | **GitHub Pages**, free: `https://popovnehuligan.github.io/hrvdhub/` |
| The data | a **Google Sheet** «HOROVOD · Вишлист» on horovod.info@gmail.com (sheet `wishes`) |
| The logic behind it (`apps-script/`) | **Google Apps Script** attached to that sheet: checks Telegram logins, saves wishes, fetches pictures from shop links, posts to the group, sends the morning reminder |
| Photos | a Google Drive folder «HOROVOD Вишлист — фото» |
| The address of the script | `public/config.js` |

Until `public/config.js` has the script's address, the app runs in **demo mode**: it shows a sample
wishlist and keeps changes only on that device. Useful for looking around; the team needs the live mode.

## Setting it up

You need: a **new bot** from @BotFather for the wishlist (not the bar bot's or Podmoga's), and the
horovod.info@gmail.com Google account.

1. **GitHub Pages.** Repository Settings → Pages → Source: **GitHub Actions**. Merge this work into
   `main`; the app is published at `https://popovnehuligan.github.io/hrvdhub/` a minute later.
2. **Google side, automatically** (on a computer with Node.js, like the bar bot's `deploy.sh`):
   ```sh
   npx @google/clasp login      # once, sign in as horovod.info@gmail.com
   tools/deploy.sh
   ```
   The first run creates the Google Sheet with its script, publishes the script as a web app, writes
   its address into `public/config.js` and pushes to `main`.
3. **Properties.** In the sheet: Extensions → Apps Script → Project Settings → Script Properties:
   - `BOT_TOKEN`: the wishlist bot's token;
   - `APP_URL`: `https://popovnehuligan.github.io/hrvdhub/`.
4. **Group.** Add the bot to the HOROVOD group and write any message there.
5. **setup().** In the Apps Script editor pick the function `setup` → Run → allow the access Google
   asks for. It finds the group, puts the «Вишлист» button on the bot and turns on the morning
   reminder. The log shows what it did.
6. Optional, for the «Открыть в вишлисте» buttons in group posts: BotFather → the bot → Bot Settings →
   Configure Mini App → Enable, with the same address.

Without step 2's script you can do the same by hand, as in the bar bot's README: create the sheet,
paste `apps-script/Code.gs`, `apps-script/Shared.gs` and `appsscript.json` into its Apps Script,
Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone), and put the `…/exec`
address into `public/config.js`.

### The script updates itself

After a one-time step (`public/update.html`: switch on the Apps Script API, paste the script and
`appsscript.json`, run `setup`), the Google script keeps itself in step with GitHub Pages:
every hour, and right away when asked with a POST `{"action":"refreshCode"}` to the web app,
it downloads `setup/wishlist-script.txt` and `setup/appsscript.json`, replaces its own code, makes
a new version and moves the web app to it. `GET …/exec` shows the version it runs
(`CODE_HASH`: the first 12 hex digits of the SHA-256 of the script plus the manifest).

### When the bot is quiet in the group

In the Apps Script editor pick the function `check` → Run. It checks the group, the topic and the
bot's rights, fixes a group that changed its address, shows the last error Telegram gave, and posts
a test message about the newest wish. The log says what's wrong in plain words.

### The bot's look

`setup()` also gives the bot its profile picture (`public/brand/bot-avatar.jpg`, drawn in the style of
the bar bot's icon: a gift box with a mic and a guitar, the HRVD and eye stickers, «WISHLIST»), its
description and the «Вишлист» menu button. The picture's source is `public/brand/bot-avatar.svg`.
To change the picture: replace the files and bump `AVATAR_VERSION` in `apps-script/Code.gs`.

### Script properties

| Property | What it's for |
| --- | --- |
| `BOT_TOKEN` | **Required.** Lives only in the script's properties, never in the app or in git. |
| `GROUP_CHAT_ID` | The HOROVOD group: its members can use the app, its admins are app admins. `setup()` fills it in. |
| `ADMIN_IDS` | Extra admins by Telegram id, comma separated. |
| `APP_URL` | The GitHub Pages address, for the bot's menu button. |
| `NOTIFY_CHAT_ID` | Post news and reminders to another chat than the group. |
| `CURRENCY`, `REMINDER_HOUR` | Default `EUR` and 10 (Bratislava time). |

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
