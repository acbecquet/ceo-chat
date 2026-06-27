# Project agent memory — ceo-chat

ceo-chat is a phone-call-style **voice interface to firstmate**: voice-in via firstmate's
own text injection, voice-out via a transcript tap → "speakability" LLM rewrite → MiniMax
streaming TTS. Decision-ready plan:
`/home/acbecquet/firstmate/data/ceochat-plan-q7/report.md` (READ §2, §6, §7, §10 first).

## Architecture decision (committed)
- **Custom broker on hub** (Node/TypeScript), NOT a bare ttyd. One server brokers terminal
  (xterm.js) + voice (WebSocket) + the speakability/TTS pipeline (plan §4 Option B).
- **Voice-in = reuse firstmate.** STT text → one `bin/fm-send.sh` call → the agent composer.
  No new injection code.
- **Voice-out = transcript tap, not the scraped TUI.** Read Claude Code's session JSONL
  (clean assistant text + tool events), run a Haiku-class speakability rewrite, stream into
  MiniMax. The scraped pane is only for the *visual* terminal.
- **Dedicated `ceo-chat` firstmate session** the broker owns (isolated from the captain's
  desktop session). Cloud-STT / half-duplex / Cloudflare exposure are Phase 1+.

## Secrets
- Live in a gitignored file OUTSIDE the repo: `~/.config/ceo-chat/secrets.env`
  (`MINIMAX_API_KEY`, `MINIMAX_GROUP_ID`, optional `ANTHROPIC_API_KEY`). Never hardcode or
  commit. `.gitignore` covers `*.env`, `phase0/out/`, `*.wav`/`*.pcm`, `node_modules/`.

## MiniMax integration gotchas (CONFIRMED live, 2026-06-27)
- International platform only: `wss://api.minimax.io/ws/v1/t2a_v2` (NOT `minimaxi.com`).
- Auth `Authorization: Bearer <key>`. **GroupId goes in the URL query** (`?GroupId=…`).
- Empirically, the **Bearer key alone authenticates** the WS + `task_start`; a *blank*
  GroupId did NOT cause a 401 (reached `task_started`). Still pass GroupId once available.
- Protocol: `task_start → task_continue (stream text) → task_finish`. Audio chunks are
  **hex-encoded** (`Buffer.from(hex,'hex')`, NOT base64).
- `model:"speech-2.8-turbo"` is a valid enum (accepted by `task_start`). `speech-2.5` is
  marketing-only — avoid. `format:"pcm"`; wrap raw PCM in a WAV header yourself.
- Billing surfaces as `base_resp.status_code` / final-frame `extra_info`. **Account needs
  balance** — `status_code 1008 "insufficient balance"` blocks audio until funded.

## firstmate injection gotchas (CONFIRMED, claude CLI v2.1.x)
- `fm-send.sh` gives **false-negative exit codes** ("Enter swallowed; text left in
  composer") even when the submit lands and the agent replies. **Verify via
  composer-cleared / a new transcript turn, NOT fm-send's exit code.** Never blind-retry: a
  swallowed Enter leaves text in the composer, so clear it before any re-send to avoid
  double-submission. (Worth an upstream firstmate `FM_COMPOSER_IDLE_RE` tune for claude 2.1.x.)
- `claude --dangerously-skip-permissions` does **not** skip the one-time "trust this folder"
  dialog for a fresh cwd — accept it in-band (Enter on "Yes, I trust") or the harness never
  reaches the composer / writes no transcript.
- Address an explicit session via `session:window` (fm-send's escape hatch — left unmarked).
  Never touch the captain's real sessions or `fm-<id>` windows.

## Transcript tap (CONFIRMED)
- Path: `~/.claude/projects/<cwd-with-/-and-.→->/<session-uuid>.jsonl`, appended live
  (tail-able). Written lazily — appears around the first turn, not at boot.
- Lines: `type:"assistant"` → `message.content[]` of `text|thinking|tool_use`;
  `type:"user"` → `message.content` is a string OR a list with `tool_result` blocks
  (`tool_use_id`, `content` str-or-list, `is_error`). Other `type`s are bookkeeping.

## Speakability
- Production path: Anthropic Messages API, Haiku-class, system prompt per plan §7.3 (never
  read code/paths/URLs aloud; ≤2–3 spoken sentences; preserve questions/decisions).
- hub has no raw `ANTHROPIC_API_KEY` (claude is OAuth/subscription-authed). The `claude -p`
  fallback works ONLY as a *pure rewriter*: `--system-prompt` (REPLACE, not `--append`) +
  `--exclude-dynamic-system-prompt-sections` + `--strict-mcp-config` + `--disallowed-tools '*'`
  + an empty isolated cwd. Otherwise it loads the repo, goes agentic, and leaks code/paths.

## Phase 0 spikes
- `phase0/` — runnable, zero-dependency (Node ≥22 global `WebSocket`/`fetch`). Run
  `node phase0/spike{1,2,3}-*.mjs` or `node phase0/e2e.mjs`; see `phase0/README.md` and
  `phase0/FINDINGS.md`. The `phase0/lib/` modules encode every gotcha above and are the
  intended starting point for the Phase 1 broker.

## Validation / shipping
- Validate and ship via **no-mistakes** (`/no-mistakes`); never push to `main` or self-merge.
