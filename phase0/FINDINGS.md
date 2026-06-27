# ceo-chat Phase 0 — FINDINGS

De-risking spikes for the phone-call-style voice interface to firstmate. Goal: prove
the three things most likely to sink the project, in isolation, before any real build.
Plan: `/home/acbecquet/firstmate/data/ceochat-plan-q7/report.md` (§2, §6, §7, §10).

**Run date:** 2026-06-27 · hub · Node v24.18.0 · claude CLI v2.1.195 · MiniMax international platform.

## Verdict: **GO** to Phase 1

The architecture holds. All three risky unknowns were exercised against the real
components on hub. Every integration path works; the only thing not yet *demonstrated
end-to-end* is MiniMax producing audio bytes, and that is blocked by an **account
balance** issue (operational), not by anything architectural. Two real surprises were
found and worked around (fm-send false-negative, claude trust dialog) — both cheap.

| Spike | What it proves | Status |
|---|---|---|
| 1 — MiniMax streaming TTS | low-latency cloud voice out | ⚠️ **Auth + protocol confirmed; audio blocked on account balance** |
| 2 — Transcript tap | clean source for speakability | ✅ **Confirmed** |
| 3 — fm-send injection | reuse firstmate's solved voice-in | ✅ **Confirmed** (with a verification caveat) |
| E2E | typed → firstmate → speakability → TTS | ✅ **Legs 1–4 real**; TTS leg pending balance |

---

## Spike 1 — MiniMax streaming TTS (LIVE, against api.minimax.io)

Ran live with the captain's `MINIMAX_API_KEY`. `MINIMAX_GROUP_ID` was **blank** at run
time, which let us answer the "is GroupId required?" question empirically.

**Exact server frames** (`wss://api.minimax.io/ws/v1/t2a_v2?GroupId=` — empty):
```
WS OPEN ok (TLS handshake + Authorization: Bearer accepted)
FRAME {"event":"connected_success","base_resp":{"status_code":0,"status_msg":"success"}}
FRAME {"event":"task_started",     "base_resp":{"status_code":0,"status_msg":"success"}}
FRAME {"event":"task_failed",      "base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}
trace_id: 068f72e3c248a421efccf9db1481bc32
```

**What this tells us:**
- ✅ **The API key authenticates.** The WebSocket opened and `task_start` was accepted
  (`connected_success` + `task_started`, both `status_code:0`).
- ✅ **A blank GroupId did NOT block auth or `task_start`.** We reached `task_started`
  with `?GroupId=` empty. So on this international WS endpoint the **Bearer key alone is
  sufficient to connect and start a task** — contrary to the plan §6.1 expectation that
  GroupId is strictly required for the call. (Keep passing GroupId as the query param per
  plan once we have it — it is presumably used for billing attribution / HTTP endpoints —
  but it is **not** the cause of connection 401s here.)
- ⛔ **Hard blocker: `1008 insufficient balance`.** The MiniMax account has no credit, so
  no audio was produced and **time-to-first-audio could not be measured yet.** This is the
  billing signal Phase 0 was meant to surface. → **The captain needs to add balance to the
  MiniMax account.** Once funded, `node phase0/spike1-minimax-tts.mjs` will print the real
  TTFB and write `phase0/out/spike1.wav` with zero code changes.

**Confirmed integration details (baked into `lib/minimax.mjs` so the broker inherits them):**
- International host `api.minimax.io` (not `minimaxi.com`); auth `Authorization: Bearer <key>`.
- Protocol `task_start → task_continue → task_finish`; audio arrives **hex-encoded**
  (`Buffer.from(hex,'hex')`, not base64) — implemented + ready.
- `model:"speech-2.8-turbo"` was **accepted** by `task_start` (no model-enum rejection),
  confirming it as a valid enum value. (`speech-2.5` remains unverified/marketing — avoid.)
- `audio_setting.format:"pcm"` requested; we wrap raw PCM into a WAV header ourselves.

**Pending the captain:** add MiniMax balance (and ideally `MINIMAX_GROUP_ID`). Then we get
the real TTFB and can answer the §13.7 per-character-vs-audio-points billing question from
the `extra_info`/usage fields the final frame returns.

---

## Spike 2 — Transcript tap ✅ (the speakability linchpin)

**Confirmed: Claude Code writes a clean, tail-able session transcript** — the structured
source the speakability layer needs (plan §2/§7), far better than scraping the ANSI TUI.

- **Location:** `~/.claude/projects/<cwd-with-/-and-.-replaced-by->/<session-uuid>.jsonl`.
  One JSONL file per session, appended line-by-line as the turn streams (tail-able in
  near-real-time). The file is written lazily — it appears around the first turn, not at
  the instant the harness boots.
- **Format** (one JSON object per line, top-level `type`):
  - `assistant` → `message.content[]` of `{type: "text"|"thinking"|"tool_use", …}`
  - `user` → `message.content` is **either** a plain string (the captain's prompt) **or**
    a list with `{type:"tool_result", tool_use_id, content, is_error}` blocks
  - plus bookkeeping lines (`mode`, `permission-mode`, `file-history-snapshot`, …) we ignore
  - `tool_result.content` is sometimes a string, sometimes a list of content blocks — handled.
- **Demonstrated:** parsed a real transcript into a clean event stream
  (`🗣️ say / 🔧 tool_use / 📤 tool_result / 👤 human`) and implemented a `--follow` near-real-time
  tail (fs.watch + 250 ms poll fallback for robustness). See `lib/transcript.mjs`.

No surprises vs the plan. This is solid.

---

## Spike 3 — fm-send injection ✅ (with an important caveat)

**Confirmed: a broker-style Node process can drive firstmate's own `bin/fm-send.sh` to
inject a line into a dedicated throwaway `ceo-chat` tmux session, and the text reliably
lands** — the agent receives it and replies. The voice-in path is "STT text → one
`fm-send.sh` call", exactly as plan §2 predicted. The session is created in a temp cwd and
torn down after; the captain's sessions and `fm-<id>` windows are never touched.

### Surprise 1 — `fm-send.sh` reports a FALSE NEGATIVE on claude v2.1.195
`fm-send.sh` frequently **exits non-zero** with `error: text not submitted … (Enter
swallowed; text left in composer)` *even when the text DID submit and the agent replies*.
Observed repeatedly, including with short text. The submit lands; only fm-send's
composer-clear **read** misfires on this claude build (its composer detection was tuned for
earlier UI; claude now draws a `❯` prompt + bordered box + "bypass permissions" footer, and
starts the turn fast enough that fm-send's post-Enter read catches a transient state).

**Implication for the broker:** do **not** trust `fm-send.sh`'s exit code as the sole proof
of submit. Verify independently that the **composer cleared** (or that a new transcript turn
appeared). Our `lib/session.mjs#fmSend` does exactly this: it treats composer-cleared as the
source of truth, logs the discrepancy, and only ever re-sends when the composer *genuinely*
still holds the text — so a misreported-but-landed submit is never double-submitted.
This is worth reporting upstream to firstmate (a `FM_COMPOSER_IDLE_RE` tune for claude 2.1.x).

### Surprise 2 — the "trust this folder" dialog
Launching `claude --dangerously-skip-permissions` in a **fresh** cwd still shows a blocking
**"Do you trust this folder?"** dialog; `--dangerously-skip-permissions` does **not** bypass
it, so the harness never reaches the composer and never writes a transcript until it's
answered. We accept it in-band (send Enter on the pre-selected "Yes, I trust"). The real
broker's dedicated `ceo-chat` session will hit this once per new working dir — handle it on
spawn (or pre-trust the dir).

---

## End-to-end milestone ✅ (the Phase 0 payoff)

`node phase0/e2e.mjs` ran the full chain on hub, legs 1–4 for real:

```
typed text  →  fm-send.sh (verified via composer-cleared)  →  agent replies
            →  transcript tap reads the reply
            →  speakability rewrite (Haiku-class)
            →  MiniMax streaming TTS  →  [audio]
```

Real example from the run:
- **Agent turn (raw):** "The unit tests passed, I edited `src/server.ts`, and the pull
  request is open at https://example.com/pr/42. Want me to merge it?"
- **Speakability narration:** *"Unit tests passed. I've updated the server code and the pull
  request is open on your screen. Ready to merge?"*
  → code path dropped, URL replaced with "on your screen", the decision/question preserved,
  2–3 sentences. The §7 design works as intended.
- **TTS leg:** attempted live; blocked on `1008 insufficient balance` (same as spike 1).

### Note on the speakability backend (no Anthropic API key on hub)
`ANTHROPIC_API_KEY` is blank and hub authenticates claude via OAuth/subscription, not a raw
API key. So the spike's speakability pass uses a **`claude -p` fallback** to prove the rewrite
without a key. **Critical:** it must run as a *pure rewriter*, not the coding agent — our first
attempt invoked the full Claude Code harness, which read the repo, went agentic, and leaked
branch names/backticks (the opposite of speakable). Fixed by `--system-prompt` (REPLACE, not
append) + `--exclude-dynamic-system-prompt-sections` + `--strict-mcp-config` +
`--disallowed-tools '*'` + an empty isolated cwd. The **production path is the Anthropic
Messages API** (`lib/speakability.mjs#viaApi`, already implemented) — drop an
`ANTHROPIC_API_KEY` into secrets and it switches automatically.

---

## Surprises vs the plan (summary)

1. **GroupId is not required for WS auth/`task_start`** on the international endpoint — the
   Bearer key alone connected and started a task (plan §6.1 implied GroupId is required).
2. **`fm-send.sh` gives false-negative exit codes on claude 2.1.x** — text lands but it
   reports a swallowed Enter. Broker must verify via composer-cleared / transcript.
3. **`--dangerously-skip-permissions` does not skip the folder-trust dialog** — must be
   accepted in-band on spawn.
4. **No raw Anthropic API key on hub** — speakability proven via an isolated `claude -p`;
   production uses the Messages API once a key exists.

## Confirmed vs pending-creds

- **Confirmed now:** transcript tap (2); fm-send injection + verified-landing (3); the full
  typed→firstmate→transcript→speakability chain (e2e legs 1–4); MiniMax auth + protocol +
  model-enum + hex/PCM wiring (1).
- **Pending the captain:** MiniMax **account balance** (and ideally `MINIMAX_GROUP_ID`) to get
  real time-to-first-audio + the per-char-vs-points billing reading; optionally an
  `ANTHROPIC_API_KEY` to run speakability via the API instead of the `claude -p` fallback.

## Recommended next steps before Phase 1 build

1. Captain: top up MiniMax balance; re-run `node phase0/spike1-minimax-tts.mjs` → record real
   TTFB and the billing fields. Add `MINIMAX_GROUP_ID`.
2. File a firstmate note: `fm-send.sh` composer-clear read needs a claude-2.1.x tune
   (`FM_COMPOSER_IDLE_RE`), or document that callers must verify composer-cleared.
3. Phase 1 broker: reuse `lib/` here (secrets, transcript, minimax, speakability, session)
   as the starting modules — they already encode every gotcha found above.
