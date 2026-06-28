#!/usr/bin/env bash
# launch-firstmate.sh — start a first mate in a tmux session for the ceo-chat web
# app to ATTACH to (npm run firstmate).
#
# It launches `claude --dangerously-skip-permissions` in the firstmate HOME
# (/home/acbecquet/firstmate by default), so the agent loads firstmate's AGENTS.md
# and IS your first mate — same workspace/context you'd talk to in the terminal.
# It names the session/window predictably and prints the CEOCHAT_TARGET to export.
#
#   npm run firstmate                       # session "ceo-firstmate", window "main"
#   CEOCHAT_FM_SESSION=mate npm run firstmate
#   FM_HOME=/path/to/home   npm run firstmate
#
# SESSION LOCK: only ONE first mate may operate a home at a time. This tmux first
# mate is meant to be your MAIN first mate for that home — don't also run another
# agent against the same home. If your first mate is ALREADY running in tmux, you
# don't need this script: just `export CEOCHAT_TARGET=<session>:<window>` and run
# `npm run serve`.
set -euo pipefail

FM_HOME="${FM_HOME:-/home/acbecquet/firstmate}"
SESSION="${CEOCHAT_FM_SESSION:-ceo-firstmate}"
WINDOW="${CEOCHAT_FM_WINDOW:-main}"
TARGET="$SESSION:$WINDOW"
LAUNCH_CMD="${CEOCHAT_FM_CMD:-claude --dangerously-skip-permissions}"

if [ ! -d "$FM_HOME" ]; then
  echo "error: firstmate home '$FM_HOME' does not exist (set FM_HOME)." >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "error: a tmux session named '$SESSION' already exists — refusing to clobber it." >&2
  echo >&2
  echo "If that IS your running first mate, you don't need this script:" >&2
  echo "    export CEOCHAT_TARGET=$SESSION:<window>   # tmux list-windows -t $SESSION" >&2
  echo "    npm run serve" >&2
  echo >&2
  echo "Otherwise kill it (tmux kill-session -t $SESSION) or pick another name:" >&2
  echo "    CEOCHAT_FM_SESSION=other npm run firstmate" >&2
  exit 1
fi

echo "Launching first mate in tmux:"
echo "    session : $SESSION"
echo "    window  : $WINDOW"
echo "    home    : $FM_HOME   (loads firstmate's AGENTS.md — this IS your first mate)"
echo "    command : $LAUNCH_CMD"
echo

# Prompt suggestions off + skip permission prompts so it reaches an interactive
# composer unattended (mirrors how firstmate spawns a harness).
tmux new-session -d -s "$SESSION" -n "$WINDOW" -c "$FM_HOME" \
  "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false $LAUNCH_CMD"

echo "First mate is starting."
echo "If a one-time \"trust this folder\" dialog appears, accept it once:"
echo "    tmux attach -t $SESSION    # press Enter on \"Yes, I trust\", then Ctrl-b d to detach"
echo
echo "Point ceo-chat at it and open the web app:"
echo "    export CEOCHAT_TARGET=$TARGET"
echo "    npm run serve"
echo
echo "Then open http://127.0.0.1:8420  (or https://ceo-chat.acb-apps.com via the tunnel)."
echo
echo "CEOCHAT_TARGET=$TARGET"
