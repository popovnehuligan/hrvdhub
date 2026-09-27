#!/usr/bin/env bash
# Puts the wishlist live, the same way as the bar bot (horovodart/hrvdbarbot):
# tests → Google Apps Script (clasp) → GitHub Pages → the bot's menu button.
#
#   npx @google/clasp login      — once, with the horovod.info@gmail.com Google account
#   tools/deploy.sh              — every time
#
# The first run creates the Google Sheet «HOROVOD · Вишлист» with its script on that account.
# After the first run, in the Apps Script editor (Project Settings → Script Properties) add
# BOT_TOKEN and APP_URL, then run setup() once and allow the access Google asks for.
set -euo pipefail
cd "$(dirname "$0")/.."
CLASP="npx --yes @google/clasp@3"
PAGES_URL="${PAGES_URL:-https://popovnehuligan.github.io/hrvdhub/}"

die () { echo; echo "✗ $1"; exit 1; }

npm test >/dev/null || die "Tests failed, nothing was deployed."
node tools/build-gs.mjs >/dev/null
echo "✓ tests"

# 1. Google Apps Script. The first time: create the sheet and its script.
if [ ! -f .clasp.json ]; then
  $CLASP create --type sheets --title "HOROVOD · Вишлист" --rootDir apps-script || die "clasp create failed (run: npx @google/clasp login)"
fi
$CLASP push --force >/dev/null || die "clasp push failed."
DEPLOY_ID="$(cat apps-script/DEPLOYMENT_ID 2>/dev/null || true)"
if [ -z "$DEPLOY_ID" ]; then
  OUT="$($CLASP deploy --description "wishlist")" || die "clasp deploy failed."
  DEPLOY_ID="$(echo "$OUT" | grep -oE 'AKfy[A-Za-z0-9_-]+' | head -1)"
  [ -n "$DEPLOY_ID" ] || die "Could not read the deployment id from: $OUT"
  echo "$DEPLOY_ID" > apps-script/DEPLOYMENT_ID
else
  $CLASP deploy --deploymentId "$DEPLOY_ID" --description "$(git log -1 --pretty=%s)" >/dev/null || die "clasp deploy failed."
fi
API="https://script.google.com/macros/s/$DEPLOY_ID/exec"
echo "✓ Apps Script: $API"

# 2. The app learns the script's address and goes to GitHub Pages (via main).
sed -i.bak "s#API: '[^']*'#API: '$API'#" public/config.js && rm -f public/config.js.bak
git add -A public/config.js .clasp.json apps-script/DEPLOYMENT_ID apps-script/Shared.gs
git diff --cached --quiet || git commit -qm "Connect the app to Apps Script"
git push -q origin HEAD:main || die "git push to main failed."
echo "✓ GitHub Pages: $PAGES_URL (published in a minute or two)"

# 3. The bot's menu button with a fresh address, so Telegram doesn't keep an old copy.
if [ -f .env.local ]; then
  . ./.env.local
  URL="${PAGES_URL}?v=$(git rev-parse --short HEAD)"
  curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setChatMenuButton" -H 'Content-Type: application/json' \
    -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Вишлист\",\"web_app\":{\"url\":\"$URL\"}}}" | grep -q '"ok":true' \
    && echo "✓ Bot menu button: $URL" || echo "! Could not update the bot's menu button"
fi

# 4. The live script must answer.
for i in 1 2 3 4; do
  curl -s -L --max-time 30 "$API" | grep -q '"alive":true' && { echo "✓ Apps Script answers"; echo; echo "Done."; exit 0; }
  sleep $((i * 3))
done
die "Apps Script doesn't answer yet at $API"
