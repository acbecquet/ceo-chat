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
- **Pane the broker drives:** ATTACH to the captain's REAL first mate in tmux when
  `CEOCHAT_TARGET` is set (Phase 3 — same workspace/context), else own a dedicated throwaway
  `ceo-chat` session (the self-contained default). Cloud-STT / half-duplex / Cloudflare
  exposure are Phase 1+.

## Secrets
- Live in a gitignored file OUTSIDE the repo: `~/.config/ceo-chat/secrets.env`
  (`MINIMAX_API_KEY`, `MINIMAX_GROUP_ID`, optional `MINIMAX_VOICE_ID` (the captain's
  cloned voice — see Phase 8), `GEMINI_API_KEY` and `ANTHROPIC_API_KEY`).
  Never hardcode or
  commit. `.gitignore` covers `*.env`, `phase0/out/`, `out/` (broker WAV/narration),
  `inbox/` (inbound MMS media), `*.wav`/`*.pcm`, `node_modules/`, and TS artifacts
  (`dist/`, `*.tsbuildinfo`).

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
  `phase0/FINDINGS.md`. The `phase0/lib/` modules encode every gotcha above and are
  PRESERVED as the historical record; the live code is now the `src/` port below.

## Phase 1 — integrated product + validation harness (TypeScript, `src/`)
- **Runtime:** Node ≥22 runs `.ts` directly (type-stripping) — `npm run dev`/`validate`
  invoke `node *.ts`, no build step. Constraints: NO `enum`, NO parameter properties,
  NO namespaces (strip-only mode rejects them); relative imports MUST use the `.ts`
  extension. `npm run build`/`lint`/`typecheck` are all `tsc --noEmit`.
- **One injected pipeline.** `src/broker/pipeline.ts#runPipeline` is the single
  orchestration (inject → readReply → speakify → synth). Both the product
  (`src/broker/broker.ts`) and the harness drive the SAME function with different
  injected deps — the harness tests real integration, not a parallel copy.
- **Mock MiniMax server is a product component** (`src/tts/mock-server.ts`, uses `ws`):
  speaks the real WS protocol (Bearer header, GroupId query, hex PCM, task_start/
  continue/finish) and returns synthetic sine PCM. The broker stands it up as the
  creds-free TTS backend, AND `npm run validate` asserts the protocol against it.
- **Speakability has a `mock` backend** (`src/speakability/speakability.ts#mockSpeakify`):
  a deterministic rule-based rewriter encoding the §7.3 contract (drop code/paths/URLs
  → "on your screen", keep questions/decisions, ≤3 sentences). It is the offline
  reference the harness asserts; `--live`/product use anthropic-api or claude-cli.
- **Reply latch / fm-send / tail are injectable** so regressions test them deterministically:
  `transcript/reply.ts#waitForReply` (readSays/isIdle/now/sleep injected),
  `session/session.ts#verifiedSubmit` (sendOnce/holdsText/clear/sleep injected).
- **Broker safety:** owns a dedicated `ceo-chat` tmux session in a temp cwd, refuses to
  start if one exists, tears down on SIGINT/SIGTERM. `--mock`/`CEOCHAT_MOCK=1` forces
  the fully-offline path (mock TTS + mock speak) even when creds exist.

## Validation harness — `npm run validate` (the gate)
- `test/validate.ts`: per-leg PASS/FAIL/PENDING/SKIP report. MUST be green in mock mode
  (no creds, no network) before shipping. Legs: config, transcript, speakability,
  MiniMax protocol, full e2e. Regressions: the 3 fixed bugs + fm-send false-negative.
  Edge cases: drop-code/keep-question, confirmation flow, long-op/thinking.
- `--live` (`npm run validate:live`): runs the same legs against real services where
  `~/.config/ceo-chat/secrets.env` has creds; the live MiniMax leg reports **PENDING**
  (not FAIL) on 1004/1008/transport errors until the captain pairs creds at home.

## Phase 2 — browser web app (`src/server/`, `npm run serve`)
- **Same broker, web front-end.** `src/server/serve.ts` wraps the existing `Broker` in a
  `BrokerDriver` and serves a single-page UI + a same-origin WebSocket. It reuses the SAME
  `runPipeline`/`Broker.send` — no parallel pipeline. `npm start` aliases `npm run serve`.
- **Driver seam = testability.** `src/server/app.ts#createWebApp` talks to a `Driver`
  interface (`src/server/driver.ts`), NOT tmux directly. The product passes `BrokerDriver`
  (real session); `npm run validate`'s web leg passes an in-memory driver over the same
  `runPipeline` with mock deps — so the HTTP serving + WS contract are asserted with NO
  creds and NO agent session. Keep this seam: never make `app.ts` import tmux/claude.
- **WS contract** lives in `src/server/protocol.ts` (`WS_PATH=/ws`). Client→server:
  `send`/`listening`/`ping` plus the Phase-4 server-STT frames `stt-audio`
  (base64 s16le mono chunk)/`stt-end`/`stt-cancel`. Server→client: `hello`
  (`ttsMode`+`ttsVoice`+`speakBackend`+`sampleRate`+`audioFormat`+`serverStt`+`sttLabel`),
  `status`, `terminal` (full ANSI pane snapshot), `reply`, `narration`, `audio`
  (**base64 PCM s16le mono**, decoded by Web Audio in the page), `transcript`
  (server-STT result handed BACK to the client, never auto-run), `turn-done`, `error`,
  `pong`.
- **Status indicators** are derived from the pipeline `onStage` hook added to
  `pipeline.ts`/`Broker.send` (inject/reply/speak → thinking; synth → speaking; after the
  turn → awaiting-confirmation iff the narration contains `?`, else idle). Don't scrape
  log strings for status — use `onStage`.
- **Terminal view** uses `Broker.terminalSnapshot()` → `capturePaneAnsi` (`tmux capture-pane
  -e -p`, colour-preserving; plain `capturePane` stays for the idle latch). `app.ts` polls
  it (`terminalPollMs`, default 600; pass 0 in tests) and broadcasts FULL snapshots; the
  client clears+homes xterm.js each frame. Detached tmux pane is 80x24 → xterm is 80x24.
- **xterm.js is VENDORED**, not CDN: `@xterm/xterm` is a dependency and `app.ts` serves
  `node_modules/@xterm/xterm/lib/xterm.js` + `css/xterm.css` at `/vendor/…`. Self-contained
  so it works through the tunnel with no external egress.
- **Voice-in (browser STT)** is best-effort `webkitSpeechRecognition` in `public/app.js`;
  unsupported → the text input is the reliable fallback. Real cloud/local STT is a later
  phase — do NOT build it here.
- **Turns are serialized** (one `busy` lock); a concurrent `send` gets an `error` frame.
  All turn output is broadcast to every connected client so multiple tabs stay in sync.
- **Tunnel-ready, host-agnostic.** Serve plain HTTP on `127.0.0.1` (env `CEOCHAT_HOST`/
  `CEOCHAT_PORT`, default `127.0.0.1:8420`); the page upgrades to a RELATIVE same-origin
  `ws(s)://…/ws`. Cloudflare named tunnel terminates TLS at `https://ceo-chat.acb-apps.com`
  and forwards to the bound port. firstmate wires `cloudflared` separately; don't set it up
  here. CONFIRMED end-to-end in a real browser (chrome-devtools): typed line → live claude
  reply → narration → playable audio + live xterm terminal mirror, clean SIGINT teardown.

## Phase 3 — attach to a REAL first mate (`CEOCHAT_TARGET`)
- **Two pane-ownership modes in `src/session/session.ts`.** ATTACH (any of
  `CEOCHAT_TARGET="session:window"` / bare `CEOCHAT_TARGET=session` /
  `CEOCHAT_TARGET_SESSION`+`CEOCHAT_TARGET_WINDOW`) → the broker attaches to a
  first mate the captain already runs in tmux. SPAWN (no target env) → the original
  throwaway `ceo-chat` session. `resolveTargetFromEnv()` picks the mode; the Broker
  exposes `isAttached()`/`targetLabel()`.
- **Ownership flag drives teardown.** `SessionCtx.owned`: `spawnCeoChat` → `true`
  (teardown kills it), `attachTarget` → `false` (Broker.stop only DETACHES — Ctrl-C
  never kills the captain's first mate). Never teardown a non-owned ctx.
- **Attach derives cwd from the pane, not a guess.** `paneCurrentPath(target)`
  (`tmux display-message -p -F '#{pane_current_path}'`) → mangled → the transcript
  project dir. So the narration taps THAT session's JSONL. (Assumes claude's cwd is
  the launch dir; true unless the agent `cd`s elsewhere.)
- **Per-turn say baseline, not a running counter.** `Broker` snapshots the current
  `say`-count BEFORE each inject (`captureBaseline`) and `readReply` returns only
  says past it. Essential for attach: the live transcript already holds a long
  backlog (and whatever the captain types directly in the pane) — baselining per
  turn means the first turn speaks only its NEW reply, never the history.
- **Follow transcript rotation, never cache the path for the broker's life.** Both
  `captureBaseline` and `readReply` re-resolve the NEWEST transcript (by mtime) each
  turn AND on every poll — an attached first mate rotates its JSONL on `/clear`,
  auto-compaction, or a new session UUID. On a mid-turn rotation `readReply` adopts
  the new (fresh) file with an effective baseline of 0, so the latch's "a new say
  arrived" check still holds; resolution only ever moves FORWARD, never back to an
  older file. Without this a stale cached path would silently time out (~150s) every
  later turn.
- **Attach skips `waitForComposer`/trust** — the first mate is already up. Inject is
  the same `fm-send.sh <session:window>` escape-hatch path (unmarked), and the
  terminal mirror is the same `capturePaneAnsi(target)`.
- **Launch helper:** `bin/launch-firstmate.sh` (`npm run firstmate`) starts
  `claude --dangerously-skip-permissions` in the firstmate home (default
  `/home/acbecquet/firstmate`, so it loads firstmate's AGENTS.md and IS a first
  mate), names it `ceo-firstmate:main` (overridable via `CEOCHAT_FM_SESSION`/
  `_WINDOW`/`FM_HOME`/`CEOCHAT_FM_CMD`), refuses to clobber an existing session, and
  prints `CEOCHAT_TARGET`. **Session lock:** one first mate per home — this tmux one
  is meant to be the captain's MAIN first mate.
- **Validation:** `npm run validate` leg 7 ("attach — …") asserts env resolution and
  transcript-rotation following (both pure, always run); and, when tmux is present,
  stands up its OWN uniquely-named throwaway target (a trivial shell, torn down in
  `finally`) and checks attach existence/cwd-derivation, the pane mirror,
  non-ownership, and bare-session window pinning. tmux-absent CI → PENDING, never red.
  NEVER targets the captain's `firstmate`/`bridge` or any `fm-<id>` window.
- **CONFIRMED end-to-end** against a real claude in tmux: attach → fm-send inject →
  transcript-narrate → mock TTS audio + pane mirror, two sequential turns each
  speaking only their new reply (baseline proven), clean detach leaving the session
  alive.

## Phase 4 — REAL offline voice + mobile hands-free UX
- **Local neural voice is the DEFAULT offline TTS.** TTS backend precedence in the
  broker (`src/broker/broker.ts`): **MiniMax** (premium, creds present) → **local
  piper** (`src/tts/local-tts.ts`, real intelligible speech, NO key — the default) →
  **mock** (synthetic tone, unit tests / no voice installed). `TtsMode` is now
  `'minimax'|'local'|'mock'` (was `'live'|'mock'`) and lives in `protocol.ts`. The
  mock tone is ONLY for `--mock`/`CEOCHAT_MOCK=1` or when no voice is installed.
- **The offline voice stack lives OUTSIDE the repo** in `$CEOCHAT_VOICE_DIR`
  (default `~/.local/share/ceo-chat`), installed by `bin/setup-local-voice.sh`
  (`npm run voice`): **piper** (prebuilt x86_64 binary + `en_US-lessac-medium` voice)
  and **whisper.cpp** (built static via a downloaded cmake + `ggml-tiny.en`). Sudo-free,
  persists across worktrees. Probed by `findPiper()` / `findWhisper()` (overridable via
  `CEOCHAT_PIPER_BIN/_MODEL/_VOICE`, `CEOCHAT_WHISPER_BIN/_MODEL/_THREADS`). piper emits
  raw s16le PCM at its native rate (22.05k for *-medium) via `piper --output_raw`.
- **CONFIRMED real round-trip on hub:** piper speaks a phrase → whisper transcribes it
  back verbatim. `npm run validate` leg **"mobile — REAL audio e2e"** asserts it for
  real (reply → speakability → piper TTS → a valid decodable speech WAV written to
  `out/validate-e2e.wav` → whisper STT → the decision word "merge" survives). PENDING
  (never red) if the stack isn't installed.
- **Server-side STT** (`src/server/stt.ts`, `Transcriber` = whisper.cpp) powers BOTH
  the browser's STT fallback AND that e2e gate. whisper requires 16 kHz mono — we
  resample with the SAME pure helper the browser uses (`src/web/pcm.js#downsampleFloat32`),
  one resampler asserted by the harness. It is INJECTED into `createWebApp`
  (`transcribe?`/`sttLabel?` in `WebAppOptions`) — `app.ts` never imports whisper/tmux.
- **Shared browser logic is pure ESM in `src/web/`**, served at `/lib/…` by `app.ts`
  (like vendored xterm) AND imported directly by `npm run validate` — so the SAME files
  the phone runs are unit-asserted headlessly. Each `*.js` has a sibling `*.d.ts` so
  `tsc --noEmit` types the harness import (the `.js` are NOT in `tsconfig.include`; only
  the `.d.ts` are). Modules: `pcm.js` (portable base64/s16le/downsample — NO atob/Buffer
  so browser==node bytes), `audio-player.js`, `speech.js`, `confirm.js`,
  `protocol-consts.js` (browser copy of the few WS constants, drift-guarded by a leg),
  `capture-worklet.js` (AudioWorklet — the iOS-safe mic capture, NOT MediaRecorder).
- **Mobile audio = the core fix.** iOS Safari starts the AudioContext SUSPENDED; it
  only resumes inside a user gesture. `AudioPlayer.unlock()` (resume + a 1-frame silent
  prime) runs in the **Start-call tap**; thereafter every reply's PCM is `enqueue`d and
  AUTO-SPOKEN, gapless, on the AudioContext clock (no per-message tap). Audio arriving
  before unlock is BUFFERED then flushed (never dropped). The opportunistic resume in
  `enqueue` is async and flushes ONLY when it truly resolves to running — never
  synchronously, or audio would play before the tap. A **Wake Lock** is held through
  the call; the player's speaking-state drives **half-duplex** (mic muted while first
  mate talks) and the status ring.
- **STT robustness.** `SpeechController` encodes the iOS Web Speech pattern:
  `continuous=false` + `interimResults=true`, **re-armed on every `end`** (the iOS
  keep-alive — a session that ended and was never restarted is the "mic on but no words"
  bug), permanent (`not-allowed`) vs transient error split, `pause()/resume()` for
  half-duplex, min-restart debounce. If Web Speech is unavailable, the page falls back
  to **server-side STT** (tap-to-talk: getUserMedia → AudioWorklet → 16 kHz PCM →
  `stt-audio`/`stt-end` → broker whisper → a `transcript` frame handed BACK to the
  client). The transcript is NOT auto-run server-side — the client applies the
  confirmation guard first.
- **Voice safety (§3.5)** is `src/web/confirm.js#guardUtterance`: when first mate asks
  to confirm a **consequential** action (merge/push/deploy/delete/…), a SPOKEN reply is
  forwarded only if it's a CLEAR confirm/cancel — a bare "yeah" is held and re-prompted,
  never auto-approved. Typed input is always explicit. Asserted by a leg.
- **Call mode** (`app.js`): a manual toggle (and, after `DeviceMotionEvent.requestPermission`
  on iOS, a raise-to-ear heuristic on `deviceorientation` beta) shows a full-screen
  black overlay that **swallows touches** (cheek-proof) while audio keeps running and
  the Wake Lock is held. **HARD WEB LIMIT (document, don't fight):** iOS Safari cannot
  read the proximity sensor or power the backlight off — only a native/CallKit wrapper
  can. `enterCallMode()`/`exitCallMode()` are the seam a future native app hooks.
- **Needs the captain's real-device retest (iPhone 14 / Safari):** actual Web Speech
  reliability, the raise-to-ear gesture thresholds, and that read-aloud is audible
  through the tunnel. The headless gate proves the logic + real audio; the device proves
  the sensors/permissions. The dev box has no mic, so STT legs use injected fakes.

## Phase 4.1 — iOS hands-free audio/mic hardening + diagnostics (CONFIRMED on hub Chrome)
- **The "reply text shows, zero audio" bug = AudioContext idle-suspend.** iOS Safari
  resumes the context only inside a gesture AND auto-re-suspends it when idle. Replies
  arrive seconds after the unlock tap, by which time it's suspended again, so a buffered
  reply never plays. `audio-player.js` now defends on TWO fronts:
  1. **Keep-alive:** `_ensureKeepAlive()` runs a continuous near-silent looping
     `AudioBufferSource` (zero buffer → ~0 gain → destination) so the context never goes
     idle and stays `'running'` for the delayed reply. Started on unlock (and re-armed in
     `_play` if it dies); torn down by `stop()`.
  2. **HTMLAudioElement fallback:** one persistent `<audio>`, created + **muted-played
     inside the unlock gesture** (iOS user-activation), then fed each reply as a WAV Blob
     objectURL (`pcm.js#wavBytesFromPcm`). Used whenever the context is NOT genuinely
     `'running'`. PREFER Web Audio when running; fall back otherwise. This is the path
     that survives the silent switch later.
- **`unlocked` now means "the gesture ran", NOT "ctx is running".** Don't gate playback on
  ctx state alone — the fallback exists exactly for the suspended case. `unlock()` still
  RETURNS `ctx.state==='running'` (so callers know if Web Audio is live), but always arms
  the element + flushes pending via `_play` (which picks webaudio→element→buffer).
- **Player is DOM-free + DI'd:** `createAudioElement` / `makeObjectUrl` / `revokeObjectUrl`
  / `onDiag` are injected so the SAME logic is asserted headlessly (validate leg
  "audio keep-alive + HTMLAudioElement fallback"). Real `<audio>`/`URL.createObjectURL`
  live only in `app.js`.
- **Mic (Bug 2):** resume the CAPTURE AudioContext inside the mic tap; if `audioWorklet`/
  `AudioWorkletNode` is unavailable or silent, fall back to a **ScriptProcessorNode**
  (`createScriptProcessor`) so older iOS still streams PCM. The server (`app.ts`) now
  **always returns a `transcript` frame** — even empty — with `empty:true`+`reason`+`bytes`
  (protocol extended), and logs bytes-in / whisper result. So "mic on, no words" is VISIBLE
  instead of a silent drop. The client shows it ("Heard nothing — …").
- **On-screen Diagnostics panel** (`index.html` `#diag-details`, off by default,
  **auto-opens on the first audio/mic error**): live ctx state + keep-alive + mic chips,
  per-reply play path (Web Audio vs HTMLAudio fallback vs buffered) + play errors, mic
  gUM/worklet-vs-scriptprocessor/bytes-streamed/server transcript, and a **Copy
  diagnostics** button (clipboard, with a textarea fallback). Data model is the DOM-free,
  unit-tested `src/web/diagnostics.js` (ring buffer, ts-stamped `text()` dump); app.js owns
  the render. THIS is how the captain's next device test is sighted — paste the log back.
- **CONFIRMED in a real browser (hub Chrome, smoke seam = `createWebApp` + in-memory
  driver + mock TTS, NO claude/tmux):** Start call → `ctx running, keep-alive on, element
  armed`; typed send → `reply audio: 4096 bytes → Web Audio`; WebSpeech permission error
  auto-opened the panel. Headless can't emit sound or grant a mic, so the suspended→fallback
  path and STT-empty path are proven by the deterministic validate legs.

## Phase 5 — FAST + ROBUST hands-free (incremental speak, anchored tap, modal dismiss)
- **Latency fix = INCREMENTAL speak, never latch the whole turn.** The old path waited
  for the COMPLETE reply (idle latch, up to 150s) then ran one speakify+TTS — ~36s of
  silence on a 36s turn (proven in the captain's serve.log: repeated "say seen but
  harness still streaming — holding (latch)"). Now `src/transcript/reply.ts#streamReply`
  emits complete **speakable units** (sentence/newline boundaries via `splitCompleteUnits`)
  AS the reply streams; `src/broker/pipeline.ts#runStreamingPipeline` rewrites+synthesizes
  +emits each unit (a `PipelineChunk`) progressively, serialized so audio stays ordered.
  First audio lands within ~1-2s of the first say. CONFIRMED live against a real claude:
  4 chunks, first audio BEFORE turn-end. `runPipeline` is kept (legacy/in-memory drivers).
- **Streaming speakability MUST be fast — NEVER `claude -p` per unit.** `claude -p` cold
  start alone is >2s; spawning it per sentence defeats the fix. `Broker#streamSpeakBackend`
  picks **anthropic-api** if a key is paired, else the **deterministic `mock` rewriter**
  (instant, still honors §7.3 — drops code/paths/URLs, keeps questions). On hub the offline
  env's `ANTHROPIC_API_KEY` is EMPTY (`has()` → false), so streaming uses the rule-based
  rewriter — by design. `speakBackendHint()` reports this backend.
- **Transcript tap is PROMPT-ANCHORED, not newest-by-mtime.** An attached first mate shares
  `~/firstmate`'s project dir with OTHER concurrent claude sessions (supervisor, crewmates),
  so `latestTranscriptIn` (newest mtime) FLIP-FLOPS between unrelated files — the real
  serve.log oscillated `1f87…↔3b77…`, and our injected prompt was in the OLDER file. Fix:
  `transcript.ts#latestTranscriptWithPrompt` + `findPromptAnchor` + `saysAfterAnchor` pick
  the file that recorded OUR injected line as a `human` event, and read only the says AFTER
  that anchor. The anchor is GATED by an inject timestamp (`AnchorOpts.afterTs`, captured in
  `Broker.send` just before `fmSend`): only a `human` event AT/AFTER that instant is
  eligible and the FIRST such match is the anchor — so a short/repeated confirmation prompt
  ("yes", "go ahead and merge") can NEVER anchor to an IDENTICAL earlier turn's user line
  (which would re-speak the old reply). The loose substring fallback is tightened
  (`looseMatches`: target ≥16 chars AND ≥half the candidate line) so a prior line that
  merely contains the word can't match. Without `afterTs` (the pure unit tests) it keeps the
  legacy last-match behavior. Re-resolved every poll, so a mid-turn `/clear`/compaction that
  re-records the prompt in a fresh UUID is FOLLOWED forward; `streamReply` dedups units
  (normalized) so any re-read never double-speaks. To keep that per-poll re-resolution cheap,
  `parseTranscript` is mtime+size cached (LRU) and `streamReplyFor` only runs the multi-file
  newest-first scan when the active transcript has NOT advanced (a growing file means we're
  still on the right one). claude does NOT hold the .jsonl fd open (open→append→close), so
  /proc-fd pinning is out — content+timestamp anchoring is the robust path.
- **Auto-dismiss benign modals BEFORE every inject** (`session.ts#detectBenignModal` /
  `dismissBenignModals`, wired in `Broker.send`'s inject). Conservative — ONLY the
  "How is Claude doing this session?" rating prompt (→ **Escape**, no rating) and the
  first-run trust dialog (→ **Enter**). A genuine question to the captain is NEVER
  auto-answered. A wedged rating prompt swallowing the next message was the captain's
  "nothing after refresh" dead-end. Surfaced to the client as a `notice` frame (→ toast +
  diagnostics). The normal `⏵⏵ bypass permissions` FOOTER is not a modal — don't match it.
- **Refresh/reconnect robustness (Bug B2).** `app.ts` keeps the last-turn replay state
  (since Phase 9 it lives in the shared `TurnRunner`'s bounded history); a freshly
  connected client (page refresh) is REPLAYED reply+narration+audio+turn-done with
  `replay:true` (client SHOWS them + arms Replay but does NOT auto-play). A turn is NOT
  cancelled when the initiating socket drops — a refresh mid-turn re-joins the broadcast and
  receives the REMAINING chunks, so it never wedges. Cancel is EXPLICIT only: the `stop`
  client frame (sent on hangup) sets the turn's abort signal → `streamReply`/pipeline stop
  emitting + synthesizing. Turns stay serialized (one `busy` lock).
- **WS protocol additions:** client→server `stop`; server→client `notice`; `narration`/
  `audio` carry an `index` (progressive ordering) and `reply`/`narration`/`audio`/`turn-done`
  an optional `replay`. When chunks streamed (`result.chunks>0`) app.ts SKIPS the aggregate
  narration/audio broadcast (no double-speak); in-memory/legacy drivers with 0 chunks still
  get the aggregate frames (keeps the older web legs valid).
- **New validate legs (all green, mock):** prompt-anchored transcript (ignores concurrent
  sessions), incremental speakable units (audio starts mid-turn), runStreamingPipeline emits
  chunks before completion + abort, benign-modal auto-dismiss, and web progressive-chunks +
  notice + reconnect replay. The real-audio e2e (piper→whisper) leg still passes.

## Phase 6 — Gemini speakability backend (the hub default for streaming rewrite)
- **`gemini` is the PREFERRED streaming speakability backend** (`src/speakability/
  speakability.ts`). On hub there is no Anthropic API key, so the incremental/streaming
  spoken-summary path used to fall back to the deterministic rule rewriter (`mock`).
  Google Gemini Flash gives LLM-quality summaries for free, no Anthropic key.
- **Streaming precedence** (`pickStreamSpeakBackend` in `src/broker/broker.ts`, exported
  pure + asserted by validate): `--mock`/`CEOCHAT_MOCK` → `mock`; else `GEMINI_API_KEY`
  present → `gemini`; else `ANTHROPIC_API_KEY` present → `anthropic-api`; else `mock`.
  The whole-turn `speakify` `'auto'` resolution mirrors it (gemini → anthropic-api →
  claude-cli). `speakBackendHint()`/startup log/UI show `gemini (gemini-2.5-flash)`.
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/
  gemini-2.5-flash:generateContent`. Key via `x-goog-api-key: $GEMINI_API_KEY` header
  (equivalently `?key=`). Response text: `candidates[0].content.parts[0].text`,
  `finishReason: STOP`.
- **CRITICAL gotcha — disable thinking.** gemini-2.5-flash "thinks" by default, which
  eats the output budget and returns truncated/empty text. MUST send
  `generationConfig.thinkingConfig.thinkingBudget = 0` (also `maxOutputTokens: 200`,
  `temperature: 0.3`). The exact body is `geminiRequestBody()`; the §7.3 SYSTEM_PROMPT is
  folded into the single `contents[].parts[].text`. Body shape + thinkingBudget:0 are
  asserted by the validate leg against a faked fetch.
- **Fail-safe per chunk.** `speakify(backend:'gemini')` NEVER throws on a network/HTTP
  error or timeout (`GEMINI_TIMEOUT_MS`, AbortController): it logs and returns the
  rule-based `mockSpeakify` rewrite (`backend:'mock'`) so the incremental spoken stream
  never breaks. Low-latency by design (thinking off, short output, hard timeout).
- **`GEMINI_API_KEY`** lives in the gitignored `~/.config/ceo-chat/secrets.env` (loaded
  by `src/config/secrets.ts`, `hasGeminiCreds()`). Never hardcode/commit/echo it.
- **DI for tests:** `SpeakifyOptions.fetchImpl` (defaults to global `fetch`) +
  `geminiApiKey`/`timeoutMs` keep the backend DOM-free; `npm run validate` exercises
  selection, request shape, clean output, and the fail-safe fallback with a faked HTTP —
  NO real Gemini call. MiniMax stays off; piper TTS + whisper STT remain the voice stack.

## Phase 7 — Speakability drift on long / multi-topic replies (FIXED, CONFIRMED live)
- **The bug (captain-reproduced, `data/ceochat-test-convo.md`):** Gemini summaries are
  great on short acks but DRIFT on long / multi-topic replies. Five patterns:
  (1) **multi-ask** (e.g. claim-the-lock AND install-tooling) → one topic silently
  DROPPED; (2) **numbered options with a recommendation** → the WRONG option reported as
  recommended; (3) **very long multi-section** (memoir read-out) → three stories collapsed
  / conflated; (4) **answer buried late or behind a caveat** → head-biased summary surfaces
  the wrong thing; (5) **path/number/PID-heavy** → TTS fixates on `manuscript/entries/` or
  `process 66035` instead of the point.
- **Root cause (CONFIRMED, not just hypothesized):** the streaming path summarized each
  SENTENCE in isolation (`runStreamingPipeline` called `speakify` per `splitCompleteUnits`
  unit). A fragment can't know which topic matters or which option was recommended. Proof:
  feeding ONLY the recommendation sentence to live Gemini yields *"my recommendation
  matches working locally on all three…"* — the captain never hears it's **SSH**.
- **The fix — three layers, low-latency PRESERVED:**
  1. **Topic-block granularity, not per-sentence.** `reply.ts#splitCompleteBlocks` carves
     the stream at BLANK-LINE (paragraph) boundaries; `streamReply` takes an injectable
     `split` (default `splitCompleteUnits`; the broker passes `splitCompleteBlocks`). A
     contiguous numbered list (no blank lines) stays ONE block, so a recommendation is
     never separated from its options. First audio is still ~1-2s (the opening paragraph
     completes fast) — NOT the old 36s whole-turn latch.
  2. **Reply-so-far CONTEXT per chunk.** `runStreamingPipeline` accumulates the spoken
     text and passes it as `SpeakifyOptions.context` (capped 4000 chars); the prompt folds
     it in as read-only "already spoken — understand but do NOT repeat" so a later block
     knows what came before without re-speaking it (`speakability.ts#buildUserContent`).
  3. **Hardened §7.3 prompt** (`SYSTEM_PROMPT`): cover EVERY distinct ask (never drop a
     topic), NAME the recommended option correctly, LEAD with the answer not the preamble,
     never speak code/paths/URLs/raw-IDs (+ `RAW_ID_RE` turns "process 66035" → "a
     process"), say counts as words, concise (≤2-3 sentences; a little more only for
     genuinely multi-topic). `mockSpeakify` mirrors this offline: topic-block aware
     (`splitBlocks`), force-keeps questions/decisions/recommendations, strips markdown.
- **Tradeoff chosen:** block-granularity + accumulated context (over: per-sentence;
  whole-turn-at-end which reintroduces silence; or a separate correction pass). It keeps
  the captain's loved first-audio-in-1-2s AND continuous mid-turn audio while giving each
  summary a whole coherent topic — the best latency/quality point. A single-paragraph reply
  with NO blank lines speaks only at idle (rare; documented) — most real replies are
  multi-paragraph.
- **Tests.** `npm run validate` (deterministic, no network) gains the DRIFT legs:
  `drift — root cause` (sentence units split an option from its recommendation; blocks keep
  them together), `drift — streaming summarizes blocks with reply-so-far context` (asserts
  the two fix layers over `runStreamingPipeline`), and `drift — mock contract summaries`
  (per-fixture coverage / recommendation / screen-safe / question, incl. the PID strip).
  Fixtures (`test/harness/fixtures.ts#DRIFT_FIXTURES`) are the real reply shapes.
- **Live E2E:** `npm run validate:live` adds `live — Gemini drift fixtures` — the SAME
  contract against real `gemini-2.5-flash` (thinkingBudget:0). It is a quality REPORT, not
  a hard gate: gemini is non-deterministic, so a miss is surfaced as PENDING with the
  offending narration (never red); the deterministic mock legs are the hard guard. Needs
  `GEMINI_API_KEY` in `~/.config/ceo-chat/secrets.env` (never committed) else PENDING.

## Phase 8 — captain's OWN cloned voice (MiniMax voice clone)
- **Goal:** the captain hears first mate in THEIR voice. A cloned MiniMax `voice_id` is
  just a `voice_id` — it rides the SAME `voice_setting.voice_id` field as a stock voice,
  so once it exists nothing else in the pipeline changes.
- **Secret:** `MINIMAX_VOICE_ID` in `~/.config/ceo-chat/secrets.env` (gitignored). When
  set, `minimaxVoiceId(secrets)` (`src/config/secrets.ts`) feeds it as `SynthOptions.voiceId`
  in `Broker#synth` → `synthStreaming`; unset → falls back to `DEFAULT_VOICE_ID`
  (`male-qn-qingse`). Voice precedence is UNCHANGED: MiniMax (creds) > piper > mock.
- **Model:** `speech-2.8-turbo` (DEFAULT_MODEL) supports cloned voice_ids (confirmed vs
  live docs 2026-06) — the latency pick; `speech-2.8-hd` is the higher-fidelity sibling.
- **Clone CLI:** `src/tts/voice-clone.ts` (`npm run clone-voice -- <audio> <voice_id>`).
  Two REST calls against the INTERNATIONAL host `api.minimax.io` (NOT minimaxi.com):
  `POST /v1/files/upload` (multipart `file`+`purpose=voice_clone`, Bearer auth,
  **GroupId in query**) → `file.file_id`; then `POST /v1/voice_clone?GroupId=…` JSON
  `{file_id, voice_id}` → echoes `voice_id`. **Never sends the optional `text`/`model`
  preview fields** — a preview synthesizes audio and burns credits. `voice_id` rule:
  starts with a letter, ≥8 chars, letters+digits only (`VOICE_ID_RE`). Reusable pure fns
  (`uploadReferenceAudio`/`registerVoiceClone`/`cloneVoice`) take a DI `fetchImpl`+`baseUrl`.
- **The REAL clone is a CAPTAIN-run step** (record → clone-voice → set `MINIMAX_VOICE_ID`).
  Agents MUST NOT create a clone with throwaway audio — it spends credits + pollutes the
  account. Recording guide + read-aloud script: `docs/voice-clone.md`.
- **Mock REST server:** `startMockMinimaxRest()` in `src/tts/mock-server.ts` speaks the
  upload + voice_clone endpoints (records auth/GroupId/purpose/file/JSON body, can
  `failWith` a 1004) so `npm run validate` asserts the clone plumbing with NO creds/credits.
  The WS mock now also records `voice_setting.voice_id` (`observed.voiceId`) to prove the
  cloned voice reaches `task_start`.
- **Tests:** `npm run validate` legs `voice clone — upload + register …`, `… voice_id rules
  + base_resp error surfaced`, `… MINIMAX_VOICE_ID flows into the synth voice_setting`.
  `npm run validate:live` adds `live — MiniMax REST auth probe (get_voice, no credits)`:
  read-only `POST /v1/get_voice` confirms key+GroupId pairing WITHOUT spending credits;
  `base_resp 1004 "token not match group"` = key/GroupId belong to different accounts
  (a captain-side fix in the MiniMax console). PENDING (never red) when unpaired.

## Phase 9 - Call Mode (Twilio phone leg) + iPhone verbatim web transcript
- **first mate as a REAL phone call.** `src/server/phone.ts` is the transport shell
  (mirrors app.ts): `POST /phone/twiml` answers the Twilio voice webhook with
  `<Connect><Stream url="wss://ceo-chat.acb-apps.com/phone">`; the `/phone` WS speaks
  raw bidirectional **Media Streams** (8 kHz 8-bit mono mu-law base64 in
  `media.payload`, NO header bytes; frames start/media/dtmf/mark/stop; `clear` for
  barge-in). Raw Media Streams (NOT ConversationRelay) preserves the captain's cloned
  MiniMax voice. Pipeline below `Broker.send` is UNCHANGED - the only new audio work
  is the transcode at the seam (`src/server/phone-audio.ts`: pure G.711 mu-law codec,
  downsample-to-8k out, upsample-to-16k in for whisper, and the frame-count-based
  `UtteranceDetector` VAD - deterministic, harness-driven).
- **ONE turn engine for all transports.** `src/server/turns.ts#TurnRunner` (extracted
  from app.ts) owns the busy lock, turn counter, bounded history, and the verbatim
  tap; web WS and phone both drive it, so phone turns stream into every browser and
  turns stay serialized. app.ts is now a thin frame mapper; `createWebApp` accepts a
  pre-built `runner` + `phone` and mounts the phone HTTP/WS on the SAME port/tunnel.
  IMPORTANT: history is pushed BEFORE the turn-done event so subscribers reading
  runner state (awaitingConfirmation) see THIS turn.
- **Verbatim transcript (byte-exact).** `src/server/verbatim.ts#makeTranscriptVerbatim`
  streams the EXACT assistant say text (joined `'\n\n'`) from the same prompt-anchored
  transcript files the spoken path uses, re-resolved every poll; the runner emits
  `verbatim` frames live and a `final:true` frame that is byte-exact (the tap's text
  wins over the whitespace-normalized pipeline reply). The web UI renders it via the
  LOSSLESS `src/web/prompt-card.js#splitFencedSegments` (segment texts concatenate
  back to the input byte-for-byte; code fences get internally-scrollable containers).
- **Phone security (layered, all mock-asserted):** caller-ID allowlist at the webhook
  (`From`/`To` vs `CEOCHAT_ALLOWED_CALLER` -> `<Reject/>`); `X-Twilio-Signature`
  HMAC validation; a SINGLE-USE short-TTL stream token minted by the webhook and
  required in the WS `start` frame (a direct WS hit is closed). The single call
  slot is claimed ONLY by a token-authorized `start` - anonymous/pre-start sockets
  never hold it (so they can never make the captain's call see busy) and are
  bounded by the handshake deadline + a pre-start socket cap (`MAX_PENDING_SOCKETS`);
  frames other than `start`/`stop` are inert until an authorized start. A
  KEYPAD-ONLY (DTMF) PIN (`CEOCHAT_PHONE_PIN`) before the FIRST injection on every
  call (3 failures end it and hard-stop further attempts; pre-auth speech is
  ignored entirely - never transcribed, never an attempt, no STT gremlins);
  `guardUtterance` on the voice leg. Outbound "Call me" (web button -> `call-me`
  frame -> Twilio REST `Calls.json`) is the primary flow.
- **Interactive-prompt fallback (captain-approved):** unclear/absent answer to a
  consequential prompt -> RE-ASK once -> then a safe default that takes NO
  consequential action (never auto-approve on silence). Config = `PromptPolicy` in
  phone.ts (`reAsks`, `answerTimeoutMs`, `onUnresolved: 'no-action'|'send-cancel'`).
- **iPhone-first UI rewrite** (`src/server/public/`): verbatim transcript is the
  centerpiece (speaker separation, timestamps, auto-follow + "jump to latest" pill),
  sticky tappable answer card (`extractPrompt`: numbered options -> buttons that
  submit the number; yes/no detection), one-thumb bottom controls (Call me / Voice /
  composer), tools sheet (terminal + diagnostics), installable PWA
  (manifest.webmanifest + generated icons + apple metas, standalone, dark),
  safe-area insets, 16px inputs, >=44px targets, zero horizontal overflow. Reconnect
  resume: server replays the FULL turn history (`sent`/`reply`/`verbatim` with
  `replay:true`, audio for the newest turn only); the client dedupes by turn number
  and reconnects on visibilitychange - dead zones/app-switching never lose history.
  Reconnect is SINGLE-FLIGHT (one cancellable backoff timer; `connect()` refuses to
  stack a socket while one is CONNECTING/OPEN; stale-socket handlers are inert), so
  the visibility handler + the timer can never double-connect and double-play audio.
- **Protocol additions:** client `call-me`; server `sent` (echo of every accepted
  captain line, with `source: 'web'|'phone'` + `ts`), `verbatim`, `phone` (call
  state); `hello.phone` advertises Call-me availability.
- **Secrets (docs/call-mode.md):** `TWILIO_ACCOUNT_SID/_AUTH_TOKEN/_PHONE_NUMBER`,
  `CEOCHAT_ALLOWED_CALLER`, `CEOCHAT_PHONE_PIN` in secrets.env
  (`phoneSecrets`/`phoneCapabilities` in src/config/secrets.ts). Phone mounts only
  when allowlist+PIN exist; outbound needs the TWILIO_* trio too.
- **Validation:** mock Media Streams client legs in `npm run validate` (no Twilio
  creds): mu-law transcode + VAD, webhook allowlist/signature/token + Call-me REST
  shape, keypad-only PIN gate (NOTHING injected until it passes; pre-auth speech
  never transcribed and never burns an attempt) + hangup-mid-transcription
  listener-leak guard, anonymous-socket hardening (pre-start sockets never hold
  the call slot, tokened start claims it, deadline + cap bound them), STT->send,
  media+mark framing round-trip, barge-in `clear`+abort, hangup abort,
  re-ask/safe-default policy (incl. the 'send-cancel' config flip), byte-exact
  verbatim (pure tap + over the WS), lossless segments/answer card/PWA assets/
  reconnect resume. GOTCHA for tests: `asMediaFrame` returns the ENCODED wire
  string - send it with `ws.send(...)`, not through a JSON-stringifying helper
  (double-encoding made frames invisible).
- **Live e2e over a real number is captain-gated:** needs the captain's Twilio
  account + secrets (checklist in docs/call-mode.md). Never fabricate Twilio creds.

## Phase 10 - Text Mode (SMS/MMS on the SAME Twilio number) + captain setup guide
- **`src/server/text.ts` is the transport shell** (phone.ts's mold; docs/text-mode.md).
  Inbound: Twilio Messaging webhook `POST /text/webhook` -> **X-Twilio-Signature
  validation MANDATORY, no opt-out** (Text Mode only mounts when `textCapabilities`
  has authToken+allowlist) -> `From` allowlist (stranger = SILENT drop: empty
  `<Response/>`, nothing injected, no reply) -> Body + attachment references run
  through the SAME `TurnRunner.run(text, 'sms')` - pipeline below Driver.send
  UNCHANGED. The webhook answers empty TwiML IMMEDIATELY (turns outlive Twilio's
  ~15s webhook window); the reply rides REST `Messages.json` after the turn.
- **Reply = `formatSmsReply(narration, verbatim, publicUrl)`:** the concise
  narration leads; when the verbatim reply differs (whitespace-normalized), append
  `Full reply: <url>`; truncate the NARRATION (never the link) to Twilio's
  1600-char Body cap (REST error 21617 past it). ANY truncation FORCES the link,
  even when narration == verbatim - a cut-off text with no pointer would strand
  the captain.
- **Injected text is ONE line** - fm-send submits on newline, so `buildInjectedText`
  flattens all whitespace and appends `[MMS attachment i/n from the captain:
  <abs inbox path> (<content-type>) - open and inspect it.]` per file.
- **MMS intake:** https only; the account Basic auth is attached ONLY for
  `*.twilio.com` hosts (undici drops it on the cross-origin S3 redirect anyway -
  belt and suspenders); caps 10 items / 10 MB each; files land in the gitignored
  `inbox/` (`DEFAULT_INBOX_DIR` = repo root, `inboxDir` injectable). Partial fetch
  failures are NAMED by 1-based position (`describeMediaFailures`) on BOTH sides:
  the injected line gets `[WARNING: MMS 1 of 2 attachments (the 2nd) failed to
  download - you did NOT receive it.]` and the SMS reply LEADS with `Note: ... -
  first mate did NOT see it.` (the reply budget shrinks around the note) - so
  neither side ever mistakes a partial MMS for the whole one.
- **Proactive texts:** `POST /text/notify`, gated by `CEOCHAT_TEXT_NOTIFY`
  (default ON; 0/false/off disables) + header `x-ceochat-notify =
  sha256(TWILIO_AUTH_TOKEN)` (`notifyToken()`; the raw token never rides a
  header). It can only EVER text `CEOCHAT_ALLOWED_CALLER`. Trigger:
  `npm run text-captain -- "PR is green"` (`bin/text-captain.sh` - sed-extracts
  the token from secrets.env; sha256sum parity is leg-asserted).
- **Busy handling:** `runWhenFree` polls the shared busy lock (250ms, 180s cap).
  `runner.run` returning `turn === 0` = never started (lost busy race / empty) ->
  keep waiting; `turn > 0 && !ok` = ran and failed -> text a failure note.
- **A2P 10DLC gates OUTBOUND only** (researched + cited 2026-07-02 in
  docs/text-mode.md and the setup guide): inbound SMS/MMS works unregistered;
  unregistered US outbound is blocked (error 30034) since 2023-09-01. Sole
  proprietor tier: ~$4.50 brand + $15 vetting one-time, $2/mo campaign +
  $1.15/mo number, vetting ~1-3 weeks, throughput 1 MPS (plenty). So the captain
  can text IN immediately; replies/notifications unlock at campaign approval.
- **`docs/setup-guide.html` is a STANDALONE interactive captain guide** (calling +
  texting go-live: console webhooks, A2P walkthrough, secrets generator, live-test
  scripts, cited cost table). localStorage checklist + client-side-only value
  rendering; iPhone-first dark, 44px targets, zero horizontal overflow (pixel
  checked at 390px). Deliberately NOT served/linked by the web app (captain wants
  the app clean) - open the file directly. The PIN and auth token are never
  persisted/collected by the page. Copy buttons sit ABOVE code blocks - an
  overlaid button chops horizontally-scrolling code lines.
- **Protocol addition:** `TurnSource` now includes `'sms'`; the web transcript
  labels those turns "you (by text)". No other WS changes.
- **Validation:** 4 mock `text - …` legs in `npm run validate` (no Twilio, no
  network): pure reply framing (1600 boundary, link survival + forced link on ANY
  truncation, single-line inject incl. the failure WARNING, ordinal naming,
  notifyToken parity), webhook e2e over the REAL endpoint (403 unsigned, silent
  stranger drop, Body->send, REST reply framing, `sent` frame source 'sms'),
  MMS intake (byte-exact inbox files, Twilio-scoped credentials, https-only,
  the partial-failure note leading the SMS reply), and notify gates (token 403s,
  config-off 404, framing). Live texting stays captain-gated on A2P registration.

## Phase 11 - Call Mode UX: thinking-filler, real-only progress, attach-and-reinterpret
Three features that make a phone call feel like a human call (plan+decisions:
`data/ceochat-callux-n7/`). All three live at the phone/turn seam; the pipeline below
`Driver.send` is UNCHANGED.
- **F1 - one thinking-filler per turn** (`phone.ts`, `DEFAULT_FILLER`). When a turn is
  slow to produce its first spoken audio, ONE short varied "give me a second" line is
  spoken after `fillerThresholdMs` (default 3000). Captain decision D1: EXACTLY ONE per
  turn - a one-shot timer armed on the `sent` event, fired only if no reply `audio` has
  played, cancelled by the first audio / `turn-done`. NOT a repeating cadence. The pool
  is rotated (never canned) and synthesized through the SAME `speak`->`sendPcm` path, so
  filler inherits half-duplex (`playing=true`) and is never transcribed back; `speak(text,
  cache=true)` memoizes the finite static pool. `sendQueue` serialization guarantees the
  filler plays BEFORE the first real chunk (wait-for-gap, never a collision).
- **F2 - REAL-ONLY progress** (`src/server/activity.ts` + `phone.ts`). Captain decision
  D2 (override): progress is spoken ONLY when there is NEW real agent activity - there is
  NO generic layer, no fixed cadence, no "still working on it" pool. The transcript tap
  already parses `tool_use` (transcript.ts `toolUseAfterAnchor`); `describeToolUse` renders
  one into a short, screen-safe gerund line ("Still on it. I'm running firstmate
  bootstrap.") from `Bash.description` / TodoWrite in-progress content / Agent/Skill
  descriptions, or the bare tool VERB ("reading a file") for path-bearing tools - the path
  is NEVER spoken (`screenSafe` + `gerundClause`, §7.3). `gerundClause` conjugates ONLY a
  recognized leading verb (`KNOWN_VERBS` allowlist; 'sync' takes plain +ing, "syncing");
  a word already ending in -ing passes only when its STEM maps back to a known verb
  ("reading", "running") - "Bring"/"Ongoing" do not, so they fall back too. A free-text TodoWrite/
  Agent label that doesn't start with a known verb ("Tests for the parser") falls back
  to the tool's bare form, never gibberish. Non-narratable internal tools
  (ToolSearch, TaskGet, ...) return null = silence. The `ActivityTap`
  (`makeTranscriptActivity`, parallels `verbatim.ts`) is wired in `serve.ts` and started
  per-turn on the `sent` event; the phone leg throttles to `progressMinGapMs` (default
  20000), speaks the FRESHEST un-spoken line, NEVER the same statement twice in a turn
  (`spokenActivity` set), stays SILENT when nothing new, and YIELDS while real reply audio
  is streaming (`audioThisWindow`).
- **F3 - attach-and-reinterpret** (`turns.ts` + `phone.ts` + `app.ts` + `text.ts`). A
  follow-up utterance while a turn is in flight is MERGED into the in-flight prompt and the
  turn is re-run - primarily to fix STT misreads (decision D4: always attach while in
  flight). The crux: `runner.cancel` only stops ceo-chat SPEAKING; it does NOT stop the
  agent. New optional `Driver.interrupt()` (`Broker.interrupt` = send `Escape` to the pane,
  guarded by the SAME "esc to interrupt" idle latch the reply tap uses) actually
  interrupts claude. `TurnRunner.steer` = abort the in-flight pipeline -> interrupt the
  agent -> wait for it to unwind -> re-run `buildSteerPrompt(original, correction, source)`
  (ONE line, original verbatim; SOURCE-AWARE framing: a SPOKEN phone correction is the
  authoritative fix of a possible STT misread (D3), a typed web/SMS follow-up is an
  ADDITION that never invites replacing the original). The abort + the combined-prompt
  build happen at steer() REQUEST time (before the serialized `steerChain` entry runs),
  and the runner keeps a per-source `pendingSteers` MERGE-TARGET accumulator (the
  combined prompt each pending re-run WILL inject, removed the moment that run starts):
  a SECOND correction merges onto base + all prior corrections wherever it lands - DURING
  the steered re-run (breaks that run's await immediately) or during the UNWIND window
  before the re-run starts (supersedes the stale pending entry so it never fires; only
  the fully-merged turn runs). D4 holds for repeat corrections; the nested framing on
  the re-merged prompt is an accepted tradeoff. An aborted-for-steer turn leaves NO
  history/turn-done (no double-speak - it returns before recording) and resolves
  `TurnResult.superseded` - NOT a failure (a superseded never-ran pending steer resolves
  `superseded` with turn 0) - so text.ts's `handleInbound` stays silent for it instead of
  texting a spurious "That turn failed" (only the combined turn's SMS reply goes out; a
  genuine mid-turn failure still texts the note), and a superseded MMS turn's
  partial-failure note is CARRIED FORWARD (`carriedNotes`) to lead the combined turn's
  reply - the captain never assumes a dropped photo was seen. Steering is
  SAME-SOURCE only, enforced at BOTH ends: `submitOrSteer` attaches only a same-source
  follow-up, `steer()` never cancels/interrupts a foreign-source in-flight turn (it queues
  behind it), and the phone leg steers only a phone-sourced turn, a barge-pinned prompt
  (the pin is itself phone-only), or an ALREADY-PENDING phone steer chain - a spoken line
  during a web/SMS turn joins the ordered foreign-busy FIFO (`foreignQueue`, ONE drain
  loop with 250ms ticks; each queued line ages on its OWN 180s budget from its own
  arrival, so an early item's expiry drops only that item and a late-spoken line keeps
  its full patience window - per-utterance retry timers would race when the lock
  frees and run lines out of spoken order) and runs as its OWN turn right after, in
  spoken order, so typed work is never rewritten. The phone leg NEVER cancels a turn
  it does not own (`cancelOwnTurn`: no-op unless `runner.currentSource === 'phone'`) -
  both barge-in AND hangup/teardown cancel only a phone-sourced turn; over a foreign
  turn barge-in flushes the local Twilio audio (`clear`) and a hangup just tears the
  call down, letting the turn complete so its transport never texts a spurious
  "turn failed". The
  phone leg coalesces (`steerCoalesceMs`, default 700) + a
  Twilio `clear` flush; barge-in PINS the in-flight prompt (`steerOriginal`, TTL
  `STEER_PIN_TTL_MS`) so a mid-speech correction attaches even after the barge aborts the
  turn, and a `steerPending` counter (incremented around each `runner.steer` until it
  settles) keeps `routeUtterance` on the attach path across the steer UNWIND window -
  the aborted turn clears `busy` while the runner is still interrupting the agent, so
  without it an utterance in that slice would grab the freed lock and run bare AHEAD of
  the combined re-run (which would then override it). With a phone steer pending,
  `fireSteer` takes the foreign-busy submit fallback ONLY when `steerPending` is 0: a
  correction landing while a foreign turn transiently holds the unwind-window lock merges
  onto the pending phone entry via `runner.steer` (which queues behind the foreign turn
  without touching it), never a bare submit racing the re-run. Web routes `send` through
  `submitOrSteer`; SMS `runWhenFree` attaches a
  same-source follow-up but waits on a phone/web turn. D5 (a correction is NEVER lost):
  if `Escape` won't interrupt, the combined prompt still injects and runs right after;
  `_steer` HOLDS it until the aborted turn's lock actually frees (bounded 180s, matching
  runWhenFree) instead of force-running into a silent "one at a time" busy rejection.
- **Validation:** `npm run validate` gains `phone - F1` (single filler, one-shot,
  cancelled by prompt audio), `phone - F2 progress` (pure `describeToolUse`/`screenSafe`/
  gerund + non-verb fallback + boundary + the -ing stem rule) and `phone - F2: real-only
  progress` (throttle, no repeats, silence when nothing new, yields to audio), `turns -
  attach-and-reinterpret` (incl. per-source framing) + `turns - slow-unwind hold` (the
  correction survives an abort that outlives the wait window) + `turns - second
  correction` (a correction DURING a steered re-run merges immediately and the superseded
  turns report `superseded`) + `turns - unwind window` (a second correction landing while
  the aborted turn is still unwinding merges base + c1 + c2 and the stale pending re-run
  never fires) + the `phone - F3` legs (merge, interrupt, re-run,
  same-source-only, queue fallback, barge-in pin, foreign-source turns queued not
  steered, an utterance in the phone-leg unwind window attaches via `steerPending`
  instead of running bare ahead of the re-run, a correction merges into the pending
  phone steer even when a foreign turn holds the lock, utterances queued behind a
  foreign turn drain in spoken order, a late-queued utterance keeps its own patience
  budget, a barge-in over a foreign-source turn flushes audio without cancelling it,
  and a hangup cancels only the caller's own turn - a foreign turn survives the
  teardown) + `text - follow-up steers the SMS turn`
  (no spurious failure SMS for a
  superseded turn; a genuine failure still texts) + `text - superseded MMS turn` (its
  media-failure note is carried forward and leads the combined reply). All deterministic (injected `PhoneTimers` + fake taps + a controllable
  driver - no wall clock; the slow-unwind leg injects a virtual `now`/`sleep`). Real
  Escape-interrupt over tmux is captain-gated (needs a live claude pane).

## Validation / shipping
- Validate and ship via **no-mistakes** (`/no-mistakes`); never push to `main` or self-merge.
- **CI:** `.github/workflows/validate.yml` runs `npm ci` + `npm run typecheck` +
  `npm run validate` on every pull request and push to `main`. The suite is fully
  mock (no secrets, no network services); live legs self-skip without creds and
  tmux/piper/whisper-dependent legs report PENDING when absent, never red.
