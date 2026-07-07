# ceo-chat

A phone-call-style **voice interface to firstmate** — talk to your first mate
hands-free (e.g. from the car), hear concise spoken updates back, with a terminal
view to glance at when stopped. firstmate is tmux-based; ceo-chat brokers voice + a
terminal view over one connection, reusing firstmate's own text injection for
voice-in and a clean transcript tap for voice-out.

This repo ships the **end-to-end core**, an **iPhone-first browser web app**,
**Call Mode** - first mate as a **real Twilio phone call**
([`docs/call-mode.md`](./docs/call-mode.md)) - and **Text Mode** - SMS/MMS to first
mate on the same number ([`docs/text-mode.md`](./docs/text-mode.md)): a runnable
broker that wires the whole pipeline, a single-page in-call companion UI (the live
1:1 **verbatim transcript**, auto-spoken replies, hands-free mic, a tappable answer
card), and a comprehensive validation harness that proves every leg - green with
**no credentials**, including a **REAL generated-audio round-trip** (offline neural
TTS → STT) and **mock Twilio clients** for the phone and text legs.

**It speaks real words with no cloud key.** A local, offline neural voice
([piper](https://github.com/rhasspy/piper)) is the default TTS, and a local transcriber
([whisper.cpp](https://github.com/ggerganov/whisper.cpp)) powers STT — both installed
sudo-free by `npm run voice`. MiniMax is an optional premium voice when its creds are
present — and it can speak in **your own cloned voice**
([`docs/voice-clone.md`](./docs/voice-clone.md)).

## The pipeline

```
typed/spoken text
   │  fm-send.sh  (verified submit)            ← voice-IN: reuse firstmate
   ▼
your REAL first mate in tmux (CEOCHAT_TARGET)    ← attach mode; or a dedicated
                                                   throwaway `ceo-chat` session
   │  transcript JSONL tap  (prompt-anchored)  ← clean source, not the scraped TUI
   ▼
agent reply (clean assistant text)
   │  speakability rewrite  (Gemini Flash / Haiku LLM)  ← drop code/paths/URLs, keep questions
   ▼
≤2–3 spoken sentences
   │  MiniMax streaming TTS  (hex PCM → WAV)     ← voice-OUT
   ▼
spoken audio  +  terminal view (capture-pane)
```

Every leg is the real component, dependency-injected into the pipeline
([`src/broker/pipeline.ts`](./src/broker/pipeline.ts)) so the product and the
validation harness exercise the **same** orchestration code. The live web app drives
`runStreamingPipeline` — it speaks each **complete topic block as it streams** from the
transcript (paragraph boundaries; a contiguous numbered list stays one block so a
recommendation is never split from its options), giving first audio ~1–2s in instead of
after the whole turn, while each block's rewrite also gets the **reply-so-far as context**
so a per-block summary doesn't drift (drop a topic, misname the recommended option). The
CLI and in-memory test drivers use the aggregate `runPipeline`. The tap is **prompt-anchored**
(it follows the transcript file that recorded *our* injected line), so an attached first
mate sharing a project dir with other concurrent Claude sessions is read correctly.
Call Mode rides the SAME pipeline: the Twilio phone leg only transcodes at the transport
seam (8 kHz mu-law ↔ PCM) and drives the identical turn engine - nothing below
`Broker.send` changed.
Text Mode rides it too: an inbound SMS injects through the same turn engine and the
reply goes back as an SMS carrying the same concise narration the voice legs speak.

## Quick start

```bash
npm install                 # ws + xterm.js + TypeScript toolchain (Node >= 22 runs .ts directly)
npm run voice               # one-time: download/build the LOCAL offline voice (piper TTS + whisper STT)
npm run validate            # the harness — fully green; runs the REAL-audio round-trip when voice is installed
npm run serve               # the WEB APP — open the printed http://127.0.0.1:8420/ (speaks with the local voice)
npm run dev -- --mock "tell me the tests passed and ask if I should merge"   # CLI driver
```

`npm run voice` lands everything **outside the repo** in `$CEOCHAT_VOICE_DIR`
(default `~/.local/share/ceo-chat`): the piper binary + an English voice, and a
static whisper.cpp + `ggml-base.en` (an older tiny.en-only install still works -
the app falls back to it). It's sudo-free and idempotent. Without it the
app still runs (mock synthetic tone for TTS, text input for STT) and `validate` stays
green — the real-audio leg just reports PENDING.

## Talk to your REAL first mate — attach mode (`CEOCHAT_TARGET`)

By default `npm run serve`/`npm run dev` spawn their own throwaway `ceo-chat` agent.
To instead open the web app and talk to **your actual first mate** — same workspace,
same context, same terminal pane you'd otherwise drive in tmux — point ceo-chat at
that tmux session with **`CEOCHAT_TARGET`**:

```bash
# 1. Launch a first mate in tmux (loads firstmate's AGENTS.md from its home — it IS
#    your first mate). Prints the CEOCHAT_TARGET to export.
npm run firstmate                       # session "ceo-firstmate", window "main"

# 2. Point ceo-chat at it and serve the web app.
export CEOCHAT_TARGET=ceo-firstmate:main
npm run serve                           # open http://127.0.0.1:8420/
```

Now the browser **mirrors that first mate's pane**, your typed/spoken lines are
**injected into its composer** (`fm-send.sh`), and its replies are **narrated and
spoken** — tapped from *that* session's Claude Code transcript.

- **Already running a first mate in tmux?** You don't need `npm run firstmate` —
  just `export CEOCHAT_TARGET=<session>:<window>` (find it with
  `tmux list-windows -t <session>`) and `npm run serve`.
- `CEOCHAT_TARGET="session:window"` (or a bare `session`), or the split form
  `CEOCHAT_TARGET_SESSION=… CEOCHAT_TARGET_WINDOW=…`, both work.
- **Session lock:** only ONE first mate may operate a home at a time. The tmux first
  mate you launch is meant to be your **main** first mate for that home — don't run a
  second agent against the same home.
- Attach mode **never kills** the target on exit — Ctrl-C just **detaches**; your
  first mate keeps running. (Spawn mode still tears down its own throwaway session.)

Either way, ceo-chat only ever touches the session you point it at via the explicit
`session:window` escape hatch — never the captain's other sessions or `fm-<id>`
windows.

### Default (spawn) mode

With no `CEOCHAT_TARGET` set, `npm run serve` (and `npm run dev`) spawn their **own**
dedicated `ceo-chat` tmux session (never the captain's sessions or `fm-<id>` windows)
and tear it down on exit — the self-contained demo path.

## Web app — `npm run serve`

An **iPhone-first** single-page front-end to the same pipeline
([`src/server/`](./src/server/)) - an installable PWA (standalone, dark, safe-area
insets, ≥44px targets). Open the printed URL and you get:

- the **live 1:1 verbatim transcript** as the centerpiece - the EXACT reply text
  streamed from the session transcript while the turn runs (speaker separation,
  timestamps, auto-follow + a "jump to latest" pill), ending in a **byte-exact** final
  read; fenced code renders losslessly in internally-scrollable blocks;
- a **sticky tappable answer card** when first mate asks a question - numbered options
  become buttons that submit the number, yes/no is detected; tap or speak, both work;
- a **composer** that sends your typed line to firstmate (via the same `fm-send`
  verified submit), plus one-thumb bottom controls: **Call me** (ring your phone - see
  Call Mode below), **Voice**, push-to-talk mic; a follow-up line sent while your
  previous turn is still running **attaches to it as an addition** and the turn
  re-runs combined (attach-and-reinterpret);
- **auto-spoken replies** — tap **Voice** once and every reply is read aloud
  automatically, **topic-block-by-block as it streams** (gapless, ordered; Web Audio
  decodes raw PCM). The local piper voice speaks real words with no key; MiniMax streams
  the same way once paired; the mock tone is for tests. **Replay** re-speaks the whole
  last turn; **End** (or a barge-in) cancels the in-flight turn server-side (only a
  turn the web itself started - a live phone or SMS turn is never cut off);
- **status indicators** — listening / thinking / speaking / awaiting-confirmation —
  driven off real pipeline stages;
- **hands-free voice input** — robust `webkitSpeechRecognition` (re-armed for iOS),
  with a **server-side whisper STT fallback** when the browser path is unavailable;
  server-transcribed speech gets the **dictation cleanup** pass (see below) before it
  is handed back; the composer is always there too;
- a **tools sheet** (⋯) holding the **live terminal view** of the target agent pane —
  your real first mate in attach mode, else the dedicated `ceo-chat` session (xterm.js,
  fed colour-preserving `capture-pane` snapshots over the WebSocket), plus the
  diagnostics panel and the "Screen-off feel" overlay toggle.

### Mobile / hands-free (iOS Safari first)

The web app is built to feel like a **phone call** from the car:

- **Replies start speaking almost immediately.** Each complete topic block is spoken as
  the agent streams it, so the first audio lands ~1–2s in rather than after the whole
  turn — and summarizing a whole block at once (with the reply-so-far as context) keeps
  the spoken summary on the right topic and recommendation instead of drifting on a
  fragment. A page refresh mid-call **rejoins** the turn (it gets the remaining chunks) and
  is replayed the **full turn history** (deduped by turn number client-side; audio for the
  newest turn only, shown not auto-played) instead of going blank - dead zones and
  app-switching never lose the conversation. Reconnect is **single-flight** (one
  cancellable backoff timer, plus a `visibilitychange` re-connect), so it can never stack
  sockets and double-play audio.
- **Audio unlocks on the first tap.** Mobile browsers suspend audio until a user
  gesture — the **Voice** button resumes the AudioContext (and holds a **Wake
  Lock**), after which replies auto-play with no further taps. Replies that arrive
  before the tap are buffered, not lost. iOS Safari also auto-*re*-suspends the context
  when idle, so a reply arriving seconds later would otherwise be silent: a near-silent
  **keep-alive** source holds the context running, and a primed **HTMLAudioElement
  fallback** plays the reply as a WAV blob whenever the context isn't genuinely running.
- **Half-duplex:** the mic mutes while first mate is speaking, so the read-aloud isn't
  transcribed back.
- **Mic failures are visible, not silent.** Tap-to-talk resumes the capture context in
  the gesture and falls back to a `ScriptProcessorNode` when `AudioWorklet` is missing,
  so older iOS still streams PCM; the server always returns a transcript frame — even an
  empty one carrying the reason and bytes-received — so "mic on, no words" shows up on
  screen ("Heard nothing — …") instead of being dropped.
- **On-screen Diagnostics panel:** in the tools sheet, off by default, **auto-opens on
  the first audio/mic error**. Shows live AudioContext state / keep-alive / mic chips, each
  reply's play path (Web Audio vs HTMLAudio fallback vs buffered) and play errors, and
  mic getUserMedia / worklet-vs-scriptprocessor / bytes-streamed / server transcript —
  with a one-tap **Copy diagnostics** button, so a device test can be sighted by pasting
  the log back.
- **Benign Claude prompts don't wedge the call.** A stray "How is Claude doing this
  session?" rating or the first-run trust dialog is auto-dismissed before each message
  (surfaced as a toast + diagnostics note); a genuine question to you is never
  auto-answered.
- **Voice-safe confirmations (plan §3.5):** when first mate asks to confirm a
  consequential action (merge/push/deploy/delete…), a *spoken* reply must be a clear
  "confirm" or "cancel" — a misheard "yeah" is held and re-prompted, never
  auto-approved. Typed input is always explicit.
- **Screen-off feel:** a tools-sheet toggle (and an iOS raise-to-ear heuristic via
  DeviceMotion) shows a cheek-proof black overlay while audio keeps running. **Web
  limitation:** Safari can't power the backlight off or read the proximity sensor — the
  backlight stays on; true screen-off needs a native wrapper (the code leaves a clean
  seam for one). For a REAL native-call experience use Call Mode (below).
- **Terminal** is a collapsible, touch-scrollable glance in the tools sheet — secondary
  to the voice loop.

> **Real-device note:** the dev box has no mic and isn't an iPhone, so Web Speech
> reliability, the raise-to-ear thresholds, and audible read-aloud through the tunnel
> need the captain's **iPhone 14 / Safari** retest. The headless gate proves the logic
> and the real offline audio; the device proves the sensors/permissions.

```bash
npm run serve                                   # bind 127.0.0.1:8420 (mock TTS unless creds present)
CEOCHAT_TARGET=ceo-firstmate:main npm run serve # attach to your real first mate (see above)
CEOCHAT_PORT=9000 npm run serve                 # choose the port
CEOCHAT_HOST=0.0.0.0 npm run serve              # bind all interfaces (prefer the tunnel below)
npm run serve -- --mock                         # force the fully-offline path even with creds
```

The server serves plain HTTP on `127.0.0.1` and brokers everything over a
**same-origin** WebSocket (`/ws`). `npm start` is an alias for `npm run serve`.

### Behind the Cloudflare named tunnel

The app is built to sit behind a Cloudflare **named tunnel** on `acb-apps.com` at
**`https://ceo-chat.acb-apps.com`**. Cloudflare terminates TLS and forwards to the
local HTTP port; the page upgrades to a **relative** `wss://…/ws`, so nothing in the
app assumes a public host and the same build works on localhost and through the
tunnel. firstmate wires `cloudflared` separately once the domain is active — this
app just needs to be running on the bound port (the tunnel's `service:` target,
e.g. `http://127.0.0.1:8420`).

## Call Mode - first mate as a real phone call

With a Twilio number paired, first mate becomes a **real phone call**: iOS treats it as
a native call (lock screen, over other apps, OS-provided background mic and ducking),
you hear the summarized narration in the captain's cloned MiniMax voice (or piper), and
the web app is the **in-call companion** showing the exact reply text.

- **Transport shell only.** [`src/server/phone.ts`](./src/server/phone.ts) answers the
  Twilio voice webhook (`POST /phone/twiml`) with `<Connect><Stream>` and bridges the
  raw bidirectional **Media Streams** WS at `/phone` (8 kHz mu-law; `clear` for
  barge-in) into the SAME pipeline - raw Media Streams (not ConversationRelay)
  preserves the cloned voice, and the only new audio work is the pure transcode seam
  ([`src/server/phone-audio.ts`](./src/server/phone-audio.ts)). Both endpoints mount
  on the web app's port, so one Cloudflare tunnel fronts the browser and the phone.
- **One turn engine.** The phone and the web share a single serialized `TurnRunner`
  ([`src/server/turns.ts`](./src/server/turns.ts)) - a turn started on the call streams
  its verbatim text into every connected browser, and vice versa.
- **Outbound is primary:** tap **Call me** in the web app and first mate rings your
  phone (Twilio REST). Inbound (calling the number) is the gated secondary.
- **Layered security** (the broker fronts a shell-capable agent): caller-ID allowlist
  at the webhook, `X-Twilio-Signature` validation, a single-use short-TTL stream token
  required in the WS `start` frame (a direct WS hit is closed; anonymous sockets never
  hold the call slot), a **keypad-only PIN before anything is injected** on every call
  (speech before the PIN passes is ignored entirely; three failures end the call), and
  the §3.5 spoken-confirmation guard.
- **Safe interactive prompts:** an unclear or absent spoken answer to a consequential
  question is re-asked once, then times out to a default that takes **no consequential
  action** - silence can never approve anything (`PromptPolicy` in `phone.ts`).
- **Feels like a human call:** if the first spoken audio is slow, ONE short varied
  "give me a second" filler line plays (exactly one per turn, never a repeating
  cadence); during long turns the call speaks **REAL progress only** - short
  screen-safe lines derived from the agent's actual tool activity
  ([`src/server/activity.ts`](./src/server/activity.ts)), throttled, never repeated,
  silent when nothing new happened. **Speak over it to correct it:** barge-in flushes
  the audio and your next utterance **attaches to the in-flight prompt** as the
  authoritative fix of a possible STT misread - the agent is interrupted (Escape to
  the pane) and the turn re-runs with the combined prompt; a correction is never
  lost (if the agent won't interrupt, it runs right after). Steering is same-source
  only: the phone never cancels or rewrites a web/SMS-started turn - spoken lines
  queue in spoken order and run right after it.
- **Spoken requests arrive clean:** each utterance is transcribed locally (whisper
  `base.en`) and run through the dictation cleanup pass (next section) before it is
  injected - while a consequential yes/no confirmation always bypasses the cleanup
  LLM and is classified on your raw words.

Call Mode mounts only when `CEOCHAT_ALLOWED_CALLER` + `CEOCHAT_PHONE_PIN` are in
`~/.config/ceo-chat/secrets.env`; outbound "Call me" also needs the
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` trio. The captain
setup checklist, usage, security model, and per-minute cost live in
[`docs/call-mode.md`](./docs/call-mode.md). Everything is proven against a **mock Media
Streams client** with no Twilio account (see the harness below); the end-to-end call
over a real number is the remaining captain-gated live test.

## Dictation cleanup - spoken words arrive as a clean prompt

Server-transcribed speech - a phone-call utterance or the web app's server-STT
fallback - runs through a **Wispr-Flow-style dictation cleanup**
([`src/stt/cleanup.ts`](./src/stt/cleanup.ts)) before it reaches first mate:
one fast LLM call fixes obvious speech-to-text misreads ("pole request" →
"pull request"), drops filler, and reshapes rambling speech into the request you
meant - never adding, dropping, or changing a specific.
It can never stall a live call: on any error, timeout, or suspect output (empty,
ballooned, or truncated) the RAW transcript is injected instead.
And a consequential **yes/no confirmation always bypasses the cleanup LLM** - it is
classified on your raw words, so a model can never turn a "no" into a "yes".
The local whisper model is now **`base.en`** (materially fewer telephony misreads
than the old tiny.en, at ~2s/utterance on CPU).

Backends: **Gemini Flash** by default (the same free-tier `GEMINI_API_KEY`
speakability uses), MiniMax configurable (spends credits), plus a deterministic
offline mock the harness asserts.
All config is optional, set in `secrets.env` or the environment:
`CEOCHAT_STT_CLEANUP` (`auto` default - on iff a cleanup key exists; `on`; `off`),
`CEOCHAT_STT_CLEANUP_BACKEND` (`gemini` | `minimax`), and
`CEOCHAT_STT_CLEANUP_TIMEOUT_MS` (default 1500).
`CEOCHAT_STT_ENGINE` is a reserved name for future cloud transcription engines -
only `whisper-local` is wired today.

## Text Mode - SMS/MMS to first mate on the same number

When the captain cannot talk, **text the Call Mode number** instead
([`docs/text-mode.md`](./docs/text-mode.md)):

- **Text in, SMS back.** [`src/server/text.ts`](./src/server/text.ts) answers the
  Twilio Messaging webhook (`POST /text/webhook`) and injects the Body through the
  SAME serialized `TurnRunner` as speech - nothing below the Driver seam changed.
  The reply rides Twilio REST after the turn (turns outlive the ~15s webhook window):
  the concise spoken-style summary within Twilio's 1600-char Body cap, plus a
  `Full reply:` link to the web transcript whenever the verbatim reply holds more
  detail. Any truncation FORCES that link (a cut-off text always carries the
  pointer), and the link itself always survives the cut. SMS turns broadcast to
  every connected browser too, labeled "you (by text)". A quick follow-up text while
  your previous text's turn is still running **attaches to it as an addition** and
  the turn re-runs combined; the superseded turn stays silent (no spurious
  "turn failed" text), and a superseded MMS turn's attachment-failure note is
  carried forward to lead the combined reply.
- **MMS attachments land in `inbox/`.** Photos/files are fetched (https-only,
  Basic auth attached only for Twilio hosts, capped at 10 items / 10 MB each) into
  the gitignored `inbox/` dir and referenced by absolute path in the injected line,
  so first mate opens and inspects exactly what you sent. An attachment that fails
  to fetch is named by position on BOTH sides - a `WARNING` in the injected line
  and a leading `Note: ... - first mate did NOT see it.` in the SMS reply - so a
  partial MMS is never mistaken for the whole one.
- **Proactive texts.** `npm run text-captain -- "PR is green"` POSTs `/text/notify`
  on the running server, which texts `CEOCHAT_ALLOWED_CALLER` - the captain's own
  number and nobody else's. Gated by `CEOCHAT_TEXT_NOTIFY` (default ON) plus a
  derived `x-ceochat-notify: sha256(TWILIO_AUTH_TOKEN)` header token, so the raw
  Twilio token never rides an HTTP header.
- **Layered security:** `X-Twilio-Signature` validation is MANDATORY (Text Mode
  does not mount without `TWILIO_AUTH_TOKEN`), and a non-allowlisted sender is
  SILENTLY dropped - empty TwiML, nothing injected, no reply, nothing revealed.
- **A2P 10DLC gates outbound only:** texting IN (including MMS) works the moment the
  messaging webhook is set; SMS replies and notifications unlock when the (cheap)
  Sole Proprietor registration is approved. The cited walkthrough and cost table
  live in [`docs/text-mode.md`](./docs/text-mode.md) and the interactive
  [`docs/setup-guide.html`](./docs/setup-guide.html) (open the file directly in a
  browser - it is deliberately not served by the web app).

Text Mode reuses the Call Mode secrets: inbound needs `TWILIO_AUTH_TOKEN` +
`CEOCHAT_ALLOWED_CALLER`; replies and proactive texts also need `TWILIO_ACCOUNT_SID`
+ `TWILIO_PHONE_NUMBER`. Everything is proven by mock legs with no Twilio account
(see the harness below); live texting is captain-gated on the A2P registration.

## Validation harness — `npm run validate`

The centerpiece. One command exercises the complete pipeline and prints a readable
PASS/FAIL report per leg + overall. It runs **fully green with no live
credentials**: an in-process **mock MiniMax server**
([`src/tts/mock-server.ts`](./src/tts/mock-server.ts)) speaks the real WS protocol
(Bearer auth, GroupId-in-query, `task_start → continue → finish`, **hex**-encoded
PCM) and returns synthetic sine-wave PCM, so audio-path assertions are real bytes.
Speakability runs against a deterministic offline backend that encodes the §7.3
contract.

**CI runs the same gate** on every pull request and push to `main`
([`.github/workflows/validate.yml`](./.github/workflows/validate.yml): `npm ci` +
`npm run typecheck` + `npm run validate`) - no secrets needed; live legs self-skip
without creds and tmux/piper/whisper-dependent legs report PENDING, never red.

It covers:

| Group | What it asserts |
|---|---|
| **Legs** | secrets loader · transcript JSONL normalize · speakability wiring · **Gemini backend (selection precedence, request shape incl. `thinkingBudget:0`, fail-safe fallback; faked HTTP)** · MiniMax WS protocol (auth/query/hex/WAV) · **voice clone (REST upload + register against the mock server, voice_id rules, base_resp errors, `MINIMAX_VOICE_ID` → synth `voice_setting`; `validate:live` adds a read-only `get_voice` auth probe, no credits)** · full `runPipeline` e2e · **web server (serves the page + brokers the WS pipeline contract)** · **attach mode (`CEOCHAT_TARGET` env resolution, pane mirror + cwd-derivation, non-ownership; PENDING without tmux)** |
| **Regressions** | the 3 fixed phase-0 bugs (below) + fm-send false-negative handling |
| **Streaming & robustness** | prompt-anchored transcript tap (ignores concurrent sessions in a shared project dir) · incremental speakable units (audio starts mid-turn) · `runStreamingPipeline` emits chunks before completion + aborts on barge-in · benign-modal auto-dismiss · web progressive chunks + `notice` + reconnect replay |
| **Speakability drift** | root cause (sentence fragments lose context, topic blocks keep it) · `runStreamingPipeline` summarizes blocks with the reply-so-far as context · mock-contract summaries cover every topic, name the recommended option, strip paths/URLs/PIDs (real reply-shape fixtures); `validate:live` adds a real-Gemini quality report (PENDING, never red) |
| **Edge cases** | speakability drops code/paths/URLs & keeps questions/decisions · confirmation flow for consequential actions · long-op / "thinking" handling |
| **Mobile** | pcm codec (browser↔node) · WAV header (HTMLAudio fallback) · audio auto-speak (unlock/queue/barge-in) · audio keep-alive + HTMLAudioElement fallback (iOS idle-suspend) · diagnostics ring buffer · STT controller (iOS restart/half-duplex/errors) · confirmation guard (§3.5) · server-STT seam over the WS · server-STT empty/failed surfaces a clear signal · **REAL audio e2e** (reply → speakify → piper TTS → whisper STT, "merge" survives; PENDING without `npm run voice`) |
| **Dictation cleanup (STT)** | mock contract + sanitize (ASR fixes like "pole request"→"pull request", filler/repeat removal, single line; empty or ballooned output rejected → raw) · request bodies + backend/config selection (`thinkingBudget:0`, `auto`/`on`/`off`, gemini default / minimax) · fail-safe (error / non-200 / timeout / empty / truncated all return the RAW transcript, never a throw) · **D4 guard-safety over the real phone WS and the web WS** (a normal command IS cleaned; a consequential confirmation is injected / handed back raw and the cleanup LLM is never called) · spoken-order serialization (a fast second utterance never overtakes a slow first) · `validate:live` adds a real-Gemini cleanup quality report (PENDING without a key) |
| **Call Mode (phone, mock Media Streams client - no Twilio account)** | mu-law codec + 8 kHz transcode (the exact Twilio wire bytes) · TwiML webhook (allowlist / signature / stream token / Call-me REST shape) · **keypad-only PIN gate** (nothing injected until it passes; pre-auth speech ignored entirely; hangup mid-transcription leaks nothing) · STT→send · media+mark framing round-trip · barge-in `clear`+abort / hangup abort (both **ownership-gated**: only a phone-sourced turn; a web/SMS turn survives, as does a foreign turn on a web `stop`) · unauth-WS hardening (anonymous sockets never hold the call slot; handshake deadline + pre-start cap) · interactive-prompt re-ask/safe-default policy · **human-call UX** (single thinking-filler per turn, one-shot, cancelled by real audio · real-only progress: throttle / no repeats / silence when nothing new / yields to reply audio · attach-and-reinterpret: merge + interrupt + re-run, source-aware framing, same-source-only, foreign-busy FIFO in spoken order with per-item budgets, barge-in pin, unwind-window attach) · **byte-exact verbatim transcript** (pure tap + over the WS) · iPhone UI (lossless fenced segments, answer card, PWA assets, reconnect resume) |
| **Text Mode (SMS/MMS, mock Twilio - no account, no network)** | reply framing (narration leads; the `Full reply:` link survives the 1600-char boundary and is FORCED by any truncation; one-line inject incl. the partial-MMS `WARNING`; ordinal failure naming; notify-token parity with `bin/text-captain.sh`) · webhook e2e over the real endpoint (**403 unsigned**, silent stranger drop, Body→send through the same seam as speech, REST reply framing, `sent` frame source `'sms'`) · MMS intake (byte-exact inbox files, Twilio-scoped credentials, https-only, the failure note leads the SMS reply) · follow-up steering (a second text attaches + re-runs the in-flight SMS turn; a superseded turn sends NO spurious failure text while a genuine failure still texts; a superseded MMS turn's failure note is carried forward) · notify gates (bad token 403, config-off 404, REST framing) |

### Regression guards (the 3 fixed bugs cannot silently return)

- **reply-wait latch** — never speak a *partial* reply: require the transcript say
  count to grow **and** the harness to be idle before reading the turn.
- **MiniMax `task_started` audio-drop** — audio frames can ride on the
  `task_started` ack; they must be harvested, not dropped.
- **transcript tail cursor race** — the byte cursor advances by exactly what was
  consumed and buffers a partial trailing line until its newline — no dropped or
  duplicated turns.

### Live mode — `npm run validate:live`

Reads creds from `~/.config/ceo-chat/secrets.env`. When present, the same legs run
against the **real** services and measure true time-to-first-audio. Until the
captain pairs the MiniMax credentials at home, the live TTS leg is expected to not
produce audio — a `1004` (cred pairing), `1008` (balance), or transport error is
reported as **PENDING** (yellow), never a red failure or a crash. It flips to a real
PASS the moment audio flows.

## Running the product — `npm run dev`

An interactive CLI driver ([`src/cli/dev.ts`](./src/cli/dev.ts)): type a message,
watch it go through firstmate, and get the spoken narration (written to a WAV under
`out/`) plus the terminal view.

```bash
npm run dev                       # interactive REPL; Ctrl-D or "exit" to quit
npm run dev -- "your message"     # one-shot: drive a single line and exit
npm run dev -- --mock "..."       # force the fully-offline path (mock TTS + speak)
```

- **TTS backend is automatic.** Precedence: `MINIMAX_API_KEY` present → premium
  MiniMax; else the local piper voice if installed (`npm run voice`) → real offline
  speech, no key; else the mock synthetic tone (still a real, playable WAV). `--mock`
  (or `CEOCHAT_MOCK=1`) forces the mock tone even when creds/voice exist — handy for
  exercising the firstmate/transcript legs without depending on live MiniMax.
- **Speakability backend is automatic.** Precedence: `GEMINI_API_KEY` present →
  Google Gemini Flash (`gemini-2.5-flash`) — the PREFERRED rewriter (fast, free-tier,
  no Anthropic key, the hub default); else `ANTHROPIC_API_KEY` present → Anthropic
  Messages API; else the locally-authenticated `claude -p` pure-rewriter (whole-turn)
  or the deterministic rule-based rewriter (streaming path). `--mock`/`CEOCHAT_MOCK=1`
  forces the rule-based rewriter. The Gemini backend fails SAFE per chunk: any
  error/timeout falls back to the rule-based rewriter so speech never breaks.

### Detailed manual testing

1. `npm run validate` — confirm green (mock).
2. `npm run dev -- --mock "<a turn that has code, a URL, and a question>"` — verify
   the narration drops the code/URL ("on your screen") and keeps the question, that
   `out/turn-N.wav` is produced, and that the terminal view matches.
3. Try multi-turn in the interactive REPL; each turn tracks its own reply baseline.
4. Inspect `out/turn-N.txt` (narration) and play `out/turn-N.wav`.

## Flip to live MiniMax (when home)

1. Put the paired credentials in `~/.config/ceo-chat/secrets.env` (gitignored,
   **outside** the repo):
   ```env
   MINIMAX_API_KEY=...
   MINIMAX_GROUP_ID=...
   # optional — speak in YOUR OWN cloned voice (register it via `npm run clone-voice`;
   # see docs/voice-clone.md). Unset → MiniMax's default system voice:
   MINIMAX_VOICE_ID=...
   # optional — the PREFERRED speakability backend AND the default dictation-cleanup
   # backend (fast, free-tier, no Anthropic key):
   GEMINI_API_KEY=...
   # optional — switches speakability to the Anthropic Messages API:
   ANTHROPIC_API_KEY=...
   # optional - dictation cleanup tuning (defaults shown; see "Dictation cleanup"):
   # CEOCHAT_STT_CLEANUP=auto            # on iff a cleanup key exists; or on|off
   # CEOCHAT_STT_CLEANUP_BACKEND=gemini  # or minimax (spends credits)
   # CEOCHAT_STT_CLEANUP_TIMEOUT_MS=1500
   # optional - Call Mode (the Twilio phone leg) adds TWILIO_ACCOUNT_SID /
   # TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER + CEOCHAT_ALLOWED_CALLER +
   # CEOCHAT_PHONE_PIN - see docs/call-mode.md
   # Text Mode (SMS/MMS on the same number) reuses those Twilio keys; optional
   # CEOCHAT_TEXT_NOTIFY=0 disables proactive texts - see docs/text-mode.md
   ```
2. `npm run validate:live` — the live MiniMax leg flips from PENDING to PASS and
   prints the real time-to-first-audio.
3. `npm run serve` (or `npm run dev "..."`) — TTS now streams from live MiniMax
   automatically (no code change); the browser plays the live audio through the same
   Web Audio path. The international endpoint is `wss://api.minimax.io` (not
   `minimaxi.com`).

### Speak in your own voice — `npm run clone-voice`

MiniMax can read replies aloud in **your own cloned voice**. Record ~30s of clean
speech, register it once, and set one secret:

```bash
npm run clone-voice -- ~/.config/ceo-chat/voice-samples/captain.mp3 CaptainVoice1
# → prints the voice_id; then add MINIMAX_VOICE_ID=CaptainVoice1 to secrets.env
```

The CLI uploads the reference audio and registers the clone via MiniMax's REST API
(no preview synthesis, so registering spends no synthesis credits). Once
`MINIMAX_VOICE_ID` is set the live MiniMax path speaks in that voice — voice
precedence is unchanged (MiniMax > piper > mock). Full recording guide and the
read-aloud script: [`docs/voice-clone.md`](./docs/voice-clone.md).

## Layout

```
.github/workflows/
  validate.yml             CI: npm ci + typecheck + the mock validation harness on PRs / main
bin/
  launch-firstmate.sh      launch a first mate in tmux to attach to (npm run firstmate)
  setup-local-voice.sh     download/build the offline voice stack (npm run voice)
  text-captain.sh          proactively text the captain via /text/notify (npm run text-captain)
src/
  config/secrets.ts        secrets loader (outside-repo, gitignored)
  session/session.ts       attach to a target session OR spawn a throwaway; fm-send + pane mirror + benign-modal dismiss
  transcript/transcript.ts JSONL tap (normalize/parse/tail; prompt-anchored resolution)
  transcript/reply.ts      reply-wait latch + incremental streamReply (injectable, regression-guarded)
  speakability/            rewrite-for-the-ear (gemini | anthropic-api | claude-cli | mock)
  stt/cleanup.ts           Wispr-Flow dictation cleanup: raw ASR transcript -> clean prompt (raw fallback)
  tts/minimax.ts           MiniMax streaming TTS client (+ WAV codec; cloned voice_id support)
  tts/voice-clone.ts       register the captain's OWN cloned voice (npm run clone-voice)
  tts/local-tts.ts         LOCAL piper neural voice — the default offline TTS
  tts/mock-server.ts       in-process MiniMax mock (real WS protocol + voice-clone REST, synthetic PCM)
  broker/pipeline.ts       the injected orchestration: aggregate runPipeline + streaming runStreamingPipeline (+ onStage hook)
  broker/broker.ts         the runnable broker (owns session + TTS backend: minimax|local|mock)
  cli/dev.ts               the CLI driver entrypoint
  server/protocol.ts       the browser <-> broker WS message contract
  server/driver.ts         Driver interface + BrokerDriver (decouples web from tmux)
  server/turns.ts          ONE turn engine shared by web + phone + SMS (busy lock, history, verbatim tap, attach-and-reinterpret steering)
  server/verbatim.ts       the live 1:1 verbatim transcript source (byte-exact tap)
  server/activity.ts       REAL-only mid-turn progress from the agent's tool activity (screen-safe spoken lines)
  server/app.ts            HTTP + WS transport (static UI, status, terminal, STT seam)
  server/phone.ts          Call Mode transport shell (Twilio webhook + Media Streams WS bridge)
  server/phone-audio.ts    pure G.711 mu-law codec + 8k↔16k resample + utterance VAD
  server/text.ts           Text Mode transport shell (messaging webhook + MMS intake + /text/notify)
  server/twilio.ts         pure Twilio surface: TwiML, signature validation, Call-me + SMS REST
  server/stt.ts            LOCAL whisper.cpp transcriber (server STT + the e2e gate)
  server/serve.ts          the web server entrypoint (npm run serve)
  server/public/           the single-page UI (index.html, app.js [ESM], styles.css,
                           PWA manifest + icons)
  web/                     PURE browser modules served at /lib + asserted by validate:
                           pcm · audio-player · speech · confirm · prompt-card ·
                           capture-worklet · diagnostics
test/
  validate.ts              the validation harness (npm run validate)
  harness/                 reporter + transcript/turn fixtures
phase0/                    the original de-risking spikes (preserved)
```

> The offline voice binaries live OUTSIDE the repo in `$CEOCHAT_VOICE_DIR`
> (default `~/.local/share/ceo-chat`) — installed by `npm run voice`, never committed.

## Scripts

| Command | What it does |
|---|---|
| `npm run validate` | end-to-end harness, mock mode (the gate — must be green) |
| `npm run validate:live` | same harness against real services where creds exist |
| `npm run voice` | install the LOCAL offline voice (piper TTS + whisper STT) outside the repo |
| `npm run clone-voice -- <audio> <voice_id>` | register the captain's OWN cloned MiniMax voice (see `docs/voice-clone.md`) |
| `npm run firstmate` | launch a first mate in tmux to attach to (prints `CEOCHAT_TARGET`) |
| `npm run serve` / `npm start` | run the **web app** (browser UI + WS broker; mounts Call Mode + Text Mode when their secrets are paired) |
| `npm run text-captain -- "message"` | proactively text the captain through the running server (`/text/notify`) |
| `npm run dev` | run the CLI driver (interactive or one-shot) |
| `npm run typecheck` / `build` / `lint` | `tsc --noEmit` (we run `.ts` directly on Node ≥22) |
| `npm test` | alias for `npm run validate` |

## More

- **Durable architecture & gotchas:** [`AGENTS.md`](./AGENTS.md).
- **Call Mode setup (Twilio), security model & cost:**
  [`docs/call-mode.md`](./docs/call-mode.md); build plan:
  `/home/acbecquet/firstmate/data/ceochat-callmode-cx/report.md`.
- **Text Mode (SMS/MMS), security model & A2P 10DLC cost:**
  [`docs/text-mode.md`](./docs/text-mode.md); interactive go-live guide for calling
  + texting: [`docs/setup-guide.html`](./docs/setup-guide.html) (open the file
  directly - not served by the web app).
- **Full plan:** `/home/acbecquet/firstmate/data/ceochat-plan-q7/report.md`
  (§2 session model, §6 MiniMax, §7 speakability, §10 phasing).
- **Phase 0 spikes + findings:** [`phase0/`](./phase0/),
  [`phase0/FINDINGS.md`](./phase0/FINDINGS.md).
