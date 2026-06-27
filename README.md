# ceo-chat

A phone-call-style **voice interface to firstmate** — talk to your first mate hands-free
(e.g. from the car), hear concise spoken updates back, with a terminal view to glance at
when stopped. firstmate is tmux-based; ceo-chat brokers voice + a terminal view over one
connection, reusing firstmate's own text injection for voice-in and a clean transcript tap
for voice-out.

## Architecture (decided)

A small **custom broker on hub** (Node/TypeScript) coordinates three things over one
connection: the terminal view (xterm.js), the voice audio channel, and the
speakability + TTS pipeline. Voice-in reuses firstmate's `bin/fm-send.sh`; voice-out taps
the harness **transcript JSONL**, runs a fast "speakability" LLM pass (decide what to say
aloud vs. leave on the silent terminal), and streams it into MiniMax TTS.

- **Full plan:** `/home/acbecquet/firstmate/data/ceochat-plan-q7/report.md`
  (§2 firstmate session model, §6 MiniMax, §7 speakability, §10 phasing).
- **Durable project knowledge & gotchas:** [`AGENTS.md`](./AGENTS.md).

## Status — Phase 0 complete (de-risking spikes)

The three riskiest unknowns have been spiked on hub; the architecture holds (**GO** to
Phase 1). See [`phase0/`](./phase0/) — runnable spikes + [`phase0/README.md`](./phase0/README.md)
and the [`phase0/FINDINGS.md`](./phase0/FINDINGS.md) writeup.

- ✅ **Transcript tap** — Claude Code's session JSONL is a clean, tail-able source for the
  speakability layer.
- ✅ **fm-send injection** — a broker process reliably injects voice-in text into a
  dedicated `ceo-chat` session (verify via composer-cleared, not fm-send's exit code).
- ⚠️ **MiniMax TTS** — international WS endpoint authenticates and the protocol works;
  generating audio is blocked only on **MiniMax account balance**.
- ✅ **End-to-end** — typed text → firstmate → transcript → speakability rewrite → TTS runs
  end-to-end on hub (TTS leg pending the balance top-up).

Next: fund MiniMax, then build the Phase 1 thin MVP broker (plan §10).
