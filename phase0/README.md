# ceo-chat — Phase 0 de-risking spikes

Throwaway-but-clean spikes that retire the three biggest unknowns for ceo-chat (a
phone-call-style voice interface to firstmate) **before** any real build. See the approved
plan at `/home/acbecquet/firstmate/data/ceochat-plan-q7/report.md` (§10 phasing) and the
results writeup in [FINDINGS.md](./FINDINGS.md).

**TL;DR result:** architecture holds → **GO** to Phase 1. Transcript tap and fm-send
injection are confirmed on hub; the full typed→firstmate→speakability→TTS chain runs
end-to-end; MiniMax auth + protocol are confirmed but audio is blocked on **account
balance** (operational, not architectural). Full detail + the exact MiniMax frames are in
FINDINGS.

## Requirements

- **Node ≥ 22** (uses the built-in global `WebSocket` + `fetch` → **zero npm dependencies**;
  nothing to `npm install`). Tested on Node v24.18.0.
- `tmux` and firstmate's `bin/fm-send.sh` (for spike 3 / e2e).
- A locally-authenticated `claude` CLI (for spike 3 / e2e and the speakability fallback).
- **Secrets** in a gitignored file OUTSIDE the repo: `~/.config/ceo-chat/secrets.env`
  ```
  MINIMAX_API_KEY=...      # MiniMax international platform key
  MINIMAX_GROUP_ID=...     # passed as a ?GroupId= query param
  ANTHROPIC_API_KEY=...    # optional; speakability falls back to `claude -p` if blank
  ```
  Secrets are never hardcoded or committed. Blank keys don't block the spikes — each one
  proves what it can and clearly reports what's pending.

## How to run

```bash
node phase0/spike1-minimax-tts.mjs ["text to speak"]    # MiniMax streaming TTS round-trip
node phase0/spike2-transcript-tap.mjs [file.jsonl]      # parse a transcript into clean events
node phase0/spike2-transcript-tap.mjs --follow [file]   #   …or tail one in near-real-time
node phase0/spike3-fm-send.mjs ["line to inject"]       # broker-style fm-send injection
node phase0/e2e.mjs ["typed text to firstmate"]         # the full pipeline (the payoff)
```
(or `npm run spike1|spike2|spike3|e2e` from `phase0/`). Audio + narration land in
`phase0/out/` (gitignored).

## What each script proves

### `spike1-minimax-tts.mjs` — MiniMax streaming TTS round-trip
Opens the **international** WebSocket `wss://api.minimax.io/ws/v1/t2a_v2?GroupId=…` with
`Authorization: Bearer $MINIMAX_API_KEY`, runs `task_start` (model `speech-2.8-turbo`, a
default `voice_id`, `format:"pcm"`) → `task_continue` (streams text sentence-by-sentence) →
`task_finish`, **hex-decodes** each audio chunk, writes `out/spike1.wav` (+ `.pcm`), and
prints the **real time-to-first-audio** + any billing/usage signal.

**Measured (2026-06-27):** key **authenticates**; **blank GroupId did not block** connect or
`task_start`; blocked at `task_failed status_code 1008 "insufficient balance"` → add MiniMax
balance to get real audio + TTFB. Exact frames in FINDINGS §Spike 1.

If `MINIMAX_API_KEY` is blank it prints run instructions and exits 0 (pending creds).

### `spike2-transcript-tap.mjs` — the speakability source
Locates Claude Code's session transcript
(`~/.claude/projects/<mangled-cwd>/<uuid>.jsonl`), parses it into a clean event stream
(assistant text + `tool_use` + `tool_result` + human prompts), and can `--follow` it in
near-real-time. **Confirmed** — this is the clean tap the speakability layer reads instead
of scraping the ANSI TUI (plan §2/§7). No creds needed.

### `spike3-fm-send.mjs` — broker-style injection
Spawns a **dedicated throwaway `ceo-chat`** tmux session running a real `claude` harness,
drives `bin/fm-send.sh` to inject a line, confirms the **submit lands**, then tears the
session down. **Confirmed** the text reliably reaches the agent.
**Caveat found:** `fm-send.sh` exits non-zero (false "Enter swallowed") on claude v2.1.x
even when the submit lands — so we verify via **composer-cleared**, not the exit code
(FINDINGS §Spike 3). Also auto-accepts the one-time "trust this folder" dialog.

### `e2e.mjs` — the Phase 0 payoff
Typed text → `fm-send.sh` (verified) → agent reply via the transcript tap → **speakability**
rewrite (≤2–3 spoken sentences; never reads code/paths/URLs — plan §7.3) → **MiniMax**
streaming TTS → spoken audio. Legs 1–4 run for real; the TTS leg surfaces the live MiniMax
result (currently the balance blocker) without failing the run. Narration is saved to
`out/e2e-narration.txt`.

## Layout

```
phase0/
  spike1-minimax-tts.mjs   spike2-transcript-tap.mjs   spike3-fm-send.mjs   e2e.mjs
  lib/
    secrets.mjs        # load ~/.config/ceo-chat/secrets.env (never committed)
    transcript.mjs     # locate/parse/tail Claude Code transcript JSONL → clean events
    minimax.mjs        # MiniMax intl streaming TTS client (hex decode, WAV, all gotchas)
    speakability.mjs   # agent turn → spoken rewrite (Anthropic API, `claude -p` fallback)
    session.mjs        # spawn/teardown throwaway ceo-chat session + verified fm-send
  out/                 # generated audio + narration (gitignored)
  README.md   FINDINGS.md   package.json
```

The `lib/` modules already encode every integration gotcha found here and are the intended
starting point for the Phase 1 broker (plan §4 Option B).
