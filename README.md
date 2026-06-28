# ceo-chat

A phone-call-style **voice interface to firstmate** — talk to your first mate
hands-free (e.g. from the car), hear concise spoken updates back, with a terminal
view to glance at when stopped. firstmate is tmux-based; ceo-chat brokers voice + a
terminal view over one connection, reusing firstmate's own text injection for
voice-in and a clean transcript tap for voice-out.

This repo ships the **end-to-end core** plus a **browser web app**: a runnable
broker that wires the whole pipeline, a single-page UI you open in a browser to
exercise the full loop (terminal view + type/speak → firstmate → narration → audio),
and a comprehensive validation harness that proves every leg — green with **no
credentials**, and degrading cleanly to **live** when MiniMax/LLM keys are present.
(Cloud/local STT and the phone PWA / WebRTC polish are later phases.)

## The pipeline

```
typed/spoken text
   │  fm-send.sh  (verified submit)            ← voice-IN: reuse firstmate
   ▼
dedicated throwaway `ceo-chat` firstmate session
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
npm run validate            # the harness — fully green, no creds, no network
npm run serve               # the WEB APP — open the printed http://127.0.0.1:8420/
npm run dev -- --mock "tell me the tests passed and ask if I should merge"   # CLI driver
```

`npm run serve` (and `npm run dev`) spawn their **own** dedicated `ceo-chat` tmux
session (never the captain's sessions or `fm-<id>` windows) and tear it down on exit.

## Web app — `npm run serve`

A single-page browser front-end to the same pipeline ([`src/server/`](./src/server/)).
Open the printed URL and you get:

- a **live terminal view** of the dedicated `ceo-chat` agent session (xterm.js,
  fed colour-preserving `capture-pane` snapshots over the WebSocket);
- a **text input** that sends your message to firstmate (via the same `fm-send`
  verified submit);
- the **speakability narration** as it is produced, and the **raw agent reply**;
- the **TTS audio played back in the page** (Web Audio decodes raw PCM — the mock
  server returns playable synthetic audio so this works with **no MiniMax key**, and
  live MiniMax streams the same way once paired);
- **status indicators** — listening / thinking / speaking / awaiting-confirmation —
  driven off real pipeline stages;
- a **push-to-talk mic** using the browser's built-in speech recognition
  (`webkitSpeechRecognition`) as a quick STT path; where unsupported, the text input
  is the always-reliable fallback. (Real cloud/local STT is a later phase.)

```bash
npm run serve                          # bind 127.0.0.1:8420 (mock TTS unless creds present)
CEOCHAT_PORT=9000 npm run serve        # choose the port
CEOCHAT_HOST=0.0.0.0 npm run serve     # bind all interfaces (prefer the tunnel below)
npm run serve -- --mock                # force the fully-offline path even with creds
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
| **Legs** | secrets loader · transcript JSONL normalize · speakability wiring · MiniMax WS protocol (auth/query/hex/WAV) · full `runPipeline` e2e · **web server (serves the page + brokers the WS pipeline contract)** |
| **Regressions** | the 3 fixed phase-0 bugs (below) + fm-send false-negative handling |
| **Edge cases** | speakability drops code/paths/URLs & keeps questions/decisions · confirmation flow for consequential actions · long-op / "thinking" handling |

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
src/
  config/secrets.ts        secrets loader (outside-repo, gitignored)
  session/session.ts       dedicated ceo-chat session + fm-send verified submit
  transcript/transcript.ts JSONL tap (normalize/parse/tail)
  transcript/reply.ts      reply-wait latch (injectable, regression-guarded)
  speakability/            rewrite-for-the-ear (anthropic-api | claude-cli | mock)
  tts/minimax.ts           MiniMax streaming TTS client
  tts/mock-server.ts       in-process MiniMax mock (real protocol, synthetic PCM)
  broker/pipeline.ts       the one injected end-to-end orchestration (+ onStage hook)
  broker/broker.ts         the runnable broker (owns session + tts mode)
  cli/dev.ts               the CLI driver entrypoint
  server/protocol.ts       the browser <-> broker WS message contract
  server/driver.ts         Driver interface + BrokerDriver (decouples web from tmux)
  server/app.ts            HTTP + WS transport (static UI, status, terminal stream)
  server/serve.ts          the web server entrypoint (npm run serve)
  server/public/           the single-page UI (index.html, app.js, styles.css)
                           xterm.js is vendored from node_modules, served at /vendor
test/
  validate.ts              the validation harness (npm run validate)
  harness/                 reporter + transcript/turn fixtures
phase0/                    the original de-risking spikes (preserved)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run validate` | end-to-end harness, mock mode (the gate — must be green) |
| `npm run validate:live` | same harness against real services where creds exist |
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
