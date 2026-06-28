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
  (`MINIMAX_API_KEY`, `MINIMAX_GROUP_ID`, optional `ANTHROPIC_API_KEY`). Never hardcode or
  commit. `.gitignore` covers `*.env`, `phase0/out/`, `out/` (broker WAV/narration),
  `*.wav`/`*.pcm`, `node_modules/`, and TS artifacts (`dist/`, `*.tsbuildinfo`).

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
- **Refresh/reconnect robustness (Bug B2).** `app.ts` keeps `lastTurnState`; a freshly
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

## Validation / shipping
- Validate and ship via **no-mistakes** (`/no-mistakes`); never push to `main` or self-merge.
