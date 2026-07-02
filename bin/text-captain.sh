#!/usr/bin/env bash
# text-captain.sh - proactive Text Mode notification: send the captain an SMS
# through the running ceo-chat server (npm run text-captain -- "PR is green").
#
# This is the simple trigger a first mate session invokes when something the
# captain cares about happens ("PR is green", "deploy finished", "CI is red").
# It POSTs /text/notify on the local ceo-chat server, which sends the SMS via
# Twilio REST from the configured number to CEOCHAT_ALLOWED_CALLER - the captain's
# own phone and nobody else's.
#
# Auth: the endpoint requires x-ceochat-notify = sha256(TWILIO_AUTH_TOKEN), which
# this script derives from the gitignored ~/.config/ceo-chat/secrets.env. The raw
# Twilio token itself never rides an HTTP header.
#
#   bin/text-captain.sh "PR is green"
#   CEOCHAT_PORT=9000 bin/text-captain.sh "deploy finished"
#   CEOCHAT_NOTIFY_URL=https://ceo-chat.acb-apps.com bin/text-captain.sh "CI is red"
#
# Requires: the server up (npm run serve), Twilio secrets paired, and the
# CEOCHAT_TEXT_NOTIFY gate not set to 0 (it is ON by default).
set -euo pipefail

MSG="${1:?usage: text-captain.sh \"message\"}"
SECRETS="${CEOCHAT_SECRETS:-$HOME/.config/ceo-chat/secrets.env}"
BASE_URL="${CEOCHAT_NOTIFY_URL:-http://${CEOCHAT_HOST:-127.0.0.1}:${CEOCHAT_PORT:-8420}}"

if [ ! -f "$SECRETS" ]; then
  echo "error: secrets file '$SECRETS' not found (set CEOCHAT_SECRETS)." >&2
  exit 1
fi

# Pull TWILIO_AUTH_TOKEN out of the dotenv file without exporting anything else,
# with loadSecrets parity: last matching line wins, the value is whitespace-trimmed,
# then ONE layer of surrounding quotes (double or single) is stripped.
AUTH_TOKEN="$(sed -n 's/^[[:space:]]*TWILIO_AUTH_TOKEN[[:space:]]*=[[:space:]]*//p' "$SECRETS" \
  | tail -n1 | sed 's/[[:space:]]*$//' \
  | sed -e 's/^"\(.*\)"$/\1/' -e 't' -e "s/^'\(.*\)'$/\1/")"
if [ -z "$AUTH_TOKEN" ]; then
  echo "error: TWILIO_AUTH_TOKEN is not set in $SECRETS - Text Mode is not configured." >&2
  exit 1
fi

TOKEN="$(printf '%s' "$AUTH_TOKEN" | sha256sum | cut -d' ' -f1)"

RESPONSE="$(curl -sS -X POST \
  -H "x-ceochat-notify: $TOKEN" \
  --data-urlencode "text=$MSG" \
  "$BASE_URL/text/notify")" || {
  echo "error: could not reach the ceo-chat server at $BASE_URL - is 'npm run serve' running?" >&2
  exit 1
}

case "$RESPONSE" in
  *'"ok":true'*)
    echo "sent: $MSG"
    ;;
  *)
    echo "error: notify failed - $RESPONSE" >&2
    exit 1
    ;;
esac
