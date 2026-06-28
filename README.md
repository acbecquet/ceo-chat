# ceo-chat

A phone-call-style **voice interface to firstmate** — talk to your first mate
hands-free (e.g. from the car), hear concise spoken updates back, with a terminal
view to glance at when stopped. firstmate is tmux-based; ceo-chat brokers voice + a
terminal view over one connection, reusing firstmate's own text injection for
voice-in and a clean transcript tap for voice-out.

This repo ships the **end-to-end core** plus a **mobile-first browser web app**: a
runnable broker that wires the whole pipeline, a single-page phone-call UI (auto-spoken
replies, hands-free mic, a glanceable terminal), and a comprehensive validation harness
that proves every leg — green with **no credentials**, including a **REAL generated-audio
round-trip** (offline neural TTS → STT).

**It speaks real words with no cloud key.** A local, offline neural voice
([piper](https://github.com/rhasspy/piper)) is the default TTS, and a local transcriber
([whisper.cpp](https://github.com/ggerganov/whisper.cpp)) powers STT — both installed
sudo-free by `npm run voice`. MiniMax is an optional premium voice when its creds are
present.

## The pipeline

```
typed/spoken text
   │  fm-send.sh  (verified submit)            ← voice-IN: reuse firstmate
   ▼
your REAL first mate in tmux (CEOCHAT_TARGET)    ← attach mode; or a dedicated
                                                   throwaway `ceo-chat` session
   │  transcript JSONL tap  (idle latch)       ← clean source, not the scraped TUI
   ▼
agent reply (clean assistant text)
   │  speakability rewrite  (Haiku-class LLM)   ← drop code/paths/URLs, keep questions
   ▼
≤2–3 spoken sentences
   │  MiniMax streaming TTS  (hex PCM → WAV)     ← voice-OUT
   ▼
spoken audio  +  terminal view (capture-pane)
```

Every leg is the real component, dependency-injected into one `runPipeline()`
([`src/broker/pipeline.ts`](./src/broker/pipeline.ts)) so the product and the
validation harness exercise the **same** orchestration code.

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
static whisper.cpp + `ggml-tiny.en`. It's sudo-free and idempotent. Without it the
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

A single-page browser front-end to the same pipeline ([`src/server/`](./src/server/)).
Open the printed URL and you get:

- a **live terminal view** of the target agent pane — your real first mate in attach
  mode, else the dedicated `ceo-chat` session (xterm.js, fed colour-preserving
  `capture-pane` snapshots over the WebSocket);
- a **text input** that sends your message to firstmate (via the same `fm-send`
  verified submit);
- the **speakability narration** as it is produced, and the **raw agent reply**;
- **auto-spoken replies** — tap **Start call** once and every reply is read aloud
  automatically (Web Audio decodes raw PCM). The local piper voice speaks real words
  with no key; MiniMax streams the same way once paired; the mock tone is for tests;
- **status indicators** — listening / thinking / speaking / awaiting-confirmation —
  driven off real pipeline stages;
- **hands-free voice input** — robust `webkitSpeechRecognition` (re-armed for iOS),
  with a **server-side whisper STT fallback** when the browser path is unavailable;
  the text input is always there too.

### Mobile / hands-free (iOS Safari first)

The web app is built to feel like a **phone call** from the car:

- **Audio unlocks on the first tap.** Mobile browsers suspend audio until a user
  gesture — the **Start call** button resumes the AudioContext (and holds a **Wake
  Lock**), after which replies auto-play with no further taps. Replies that arrive
  before the tap are buffered, not lost.
- **Half-duplex:** the mic mutes while first mate is speaking, so the read-aloud isn't
  transcribed back.
- **Voice-safe confirmations (plan §3.5):** when first mate asks to confirm a
  consequential action (merge/push/deploy/delete…), a *spoken* reply must be a clear
  "confirm" or "cancel" — a misheard "yeah" is held and re-prompted, never
  auto-approved. Typed input is always explicit.
- **Call mode:** a toggle (and an iOS raise-to-ear heuristic via DeviceMotion) shows a
  cheek-proof black overlay while audio keeps running. **Web limitation:** Safari
  can't power the backlight off or read the proximity sensor — the backlight stays on;
  true screen-off needs a native wrapper (the code leaves a clean seam for one).
- **Terminal** is a collapsible, touch-scrollable glance — secondary to the voice loop.

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

## Validation harness — `npm run validate`

The centerpiece. One command exercises the complete pipeline and prints a readable
PASS/FAIL report per leg + overall. It runs **fully green with no live
credentials**: an in-process **mock MiniMax server**
([`src/tts/mock-server.ts`](./src/tts/mock-server.ts)) speaks the real WS protocol
(Bearer auth, GroupId-in-query, `task_start → continue → finish`, **hex**-encoded
PCM) and returns synthetic sine-wave PCM, so audio-path assertions are real bytes.
Speakability runs against a deterministic offline backend that encodes the §7.3
contract.

It covers:

| Group | What it asserts |
|---|---|
| **Legs** | secrets loader · transcript JSONL normalize · speakability wiring · MiniMax WS protocol (auth/query/hex/WAV) · full `runPipeline` e2e · **web server (serves the page + brokers the WS pipeline contract)** · **attach mode (`CEOCHAT_TARGET` env resolution, pane mirror + cwd-derivation, non-ownership; PENDING without tmux)** |
| **Regressions** | the 3 fixed phase-0 bugs (below) + fm-send false-negative handling |
| **Edge cases** | speakability drops code/paths/URLs & keeps questions/decisions · confirmation flow for consequential actions · long-op / "thinking" handling |
| **Mobile** | pcm codec (browser↔node) · audio auto-speak (unlock/queue/barge-in) · STT controller (iOS restart/half-duplex/errors) · confirmation guard (§3.5) · server-STT seam over the WS · **REAL audio e2e** (reply → speakify → piper TTS → whisper STT, "merge" survives; PENDING without `npm run voice`) |

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

- **TTS mode is automatic.** No `MINIMAX_API_KEY` → the broker stands up the mock
  MiniMax server so you still get a real WAV. Key present → live MiniMax. `--mock`
  (or `CEOCHAT_MOCK=1`) forces the offline path even when creds exist — handy for
  exercising the firstmate/transcript legs without depending on live MiniMax.
- **Speakability backend is automatic.** `ANTHROPIC_API_KEY` present → Anthropic
  Messages API; otherwise the locally-authenticated `claude -p` pure-rewriter
  fallback.

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
   # optional — switches speakability to the Anthropic Messages API:
   ANTHROPIC_API_KEY=...
   ```
2. `npm run validate:live` — the live MiniMax leg flips from PENDING to PASS and
   prints the real time-to-first-audio.
3. `npm run serve` (or `npm run dev "..."`) — TTS now streams from live MiniMax
   automatically (no code change); the browser plays the live audio through the same
   Web Audio path. The international endpoint is `wss://api.minimax.io` (not
   `minimaxi.com`).

## Layout

```
bin/
  launch-firstmate.sh      launch a first mate in tmux to attach to (npm run firstmate)
  setup-local-voice.sh     download/build the offline voice stack (npm run voice)
src/
  config/secrets.ts        secrets loader (outside-repo, gitignored)
  session/session.ts       attach to a target session OR spawn a throwaway; fm-send + pane mirror
  transcript/transcript.ts JSONL tap (normalize/parse/tail)
  transcript/reply.ts      reply-wait latch (injectable, regression-guarded)
  speakability/            rewrite-for-the-ear (anthropic-api | claude-cli | mock)
  tts/minimax.ts           MiniMax streaming TTS client (+ WAV codec)
  tts/local-tts.ts         LOCAL piper neural voice — the default offline TTS
  tts/mock-server.ts       in-process MiniMax mock (real protocol, synthetic PCM)
  broker/pipeline.ts       the one injected end-to-end orchestration (+ onStage hook)
  broker/broker.ts         the runnable broker (owns session + TTS backend: minimax|local|mock)
  cli/dev.ts               the CLI driver entrypoint
  server/protocol.ts       the browser <-> broker WS message contract
  server/driver.ts         Driver interface + BrokerDriver (decouples web from tmux)
  server/app.ts            HTTP + WS transport (static UI, status, terminal, STT seam)
  server/stt.ts            LOCAL whisper.cpp transcriber (server STT + the e2e gate)
  server/serve.ts          the web server entrypoint (npm run serve)
  server/public/           the single-page UI (index.html, app.js [ESM], styles.css)
  web/                     PURE browser modules served at /lib + asserted by validate:
                           pcm · audio-player · speech · confirm · capture-worklet
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
| `npm run firstmate` | launch a first mate in tmux to attach to (prints `CEOCHAT_TARGET`) |
| `npm run serve` / `npm start` | run the **web app** (browser UI + WS broker) |
| `npm run dev` | run the CLI driver (interactive or one-shot) |
| `npm run typecheck` / `build` / `lint` | `tsc --noEmit` (we run `.ts` directly on Node ≥22) |
| `npm test` | alias for `npm run validate` |

## More

- **Durable architecture & gotchas:** [`AGENTS.md`](./AGENTS.md).
- **Full plan:** `/home/acbecquet/firstmate/data/ceochat-plan-q7/report.md`
  (§2 session model, §6 MiniMax, §7 speakability, §10 phasing).
- **Phase 0 spikes + findings:** [`phase0/`](./phase0/),
  [`phase0/FINDINGS.md`](./phase0/FINDINGS.md).
