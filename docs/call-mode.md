# Call Mode - first mate as a real phone call (Twilio)

Call Mode turns first mate into a **real phone call**.
Because iOS treats it as a native call, it works across every app - over YouTube, on the lock screen, anywhere - with the OS providing background mic, audio ducking, and interruption for free.
The web app at `https://ceo-chat.acb-apps.com` is the in-call companion: it shows the **live 1:1 verbatim transcript** of the session while the call speaks the summarized narration.

The build plan behind this is `/home/acbecquet/firstmate/data/ceochat-callmode-cx/report.md`.

## How it works

```
 iPhone (native Phone app)
   <-> Twilio Programmable Voice (your number)
         Voice webhook: POST https://ceo-chat.acb-apps.com/phone/twiml
         -> TwiML <Connect><Stream url="wss://ceo-chat.acb-apps.com/phone">
   <-> bidirectional Media Streams WS (8 kHz mu-law base64)
         src/server/phone.ts (the transport shell; the pipeline below is unchanged)
           inbound : mu-law -> PCM -> whisper -> TurnRunner -> fm-send inject
           outbound: pipeline audio chunks -> 8 kHz mu-law -> media+mark
           barge-in: speak over first mate -> `clear` + turn abort
```

The phone shell reuses the whole existing stack: whisper STT, Gemini speakability, the captain's cloned MiniMax voice (or piper), the prompt-anchored transcript tap, and fm-send injection.
Nothing below `Broker.send` changed.

## Captain setup checklist

**The interactive setup guide covers this end to end.**
Open `docs/setup-guide.html` directly in a browser (it is a single self-contained file, not served by the web app): it walks the Twilio console for calling AND texting, the A2P 10DLC registration with the cited cost table, the exact secrets.env block generated from your own numbers, and the live-test scripts, with persistent checkboxes so you can pick up where you left off.
The list below stays as the quick reference for the voice leg alone.

1. **Create a Twilio account** (pay-as-you-go, no plan commitment).
2. **Buy one US local phone number** in the Twilio console (about $1.15/mo).
3. **Point the number's Voice webhook** (configure > Voice > "A call comes in") at:
   `https://ceo-chat.acb-apps.com/phone/twiml` (HTTP POST).
4. **Add the secrets** to `~/.config/ceo-chat/secrets.env` (gitignored, never committed):

   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
   CEOCHAT_ALLOWED_CALLER=+1YYYYYYYYYY   # your mobile number
   CEOCHAT_PHONE_PIN=4321                # pick your own 4-6 digits
   ```

5. Restart `npm run serve`.
   The startup banner shows `call mode: inbound + outbound ("Call me")` when everything is paired.

MiniMax cloned voice, Gemini, and whisper are already configured - unchanged by Call Mode.

## Using it

- **Outbound (primary):** tap **"Call me"** in the web app.
  first mate rings `CEOCHAT_ALLOWED_CALLER` from your Twilio number.
- **Inbound (gated secondary):** call your Twilio number from the allowlisted phone.
- Either way the call starts with a **PIN prompt**: enter `CEOCHAT_PHONE_PIN` on the keypad.
  PIN entry is keypad-only; anything you say before the PIN passes is ignored entirely (never transcribed, never counted as an attempt).
  Three keypad failures end the call.
  Nothing is ever injected into the session before the PIN passes.
- Talk normally; pause and first mate answers.
  **Speak over it to interrupt** (barge-in flushes the audio and cancels the turn).
- Keep the web app open one-handed: the exact reply text streams there verbatim, and questions pin a tappable answer card (tap or speak - both work).

## Interactive prompts on a call (the safe default)

When first mate asks a consequential question (merge / deploy / delete / push / spend), the phone leg applies the §3.5 voice guard plus a captain-approved fallback:

1. An **unclear** spoken answer (or a bare "yeah") is **re-asked once**.
2. Still unclear, or **no answer** within 30 seconds: it **times out to a safe default that takes NO consequential action**.
   By default it says so and leaves the prompt waiting on screen; silence can never approve anything.

This lives in one small config - `PromptPolicy` in `src/server/phone.ts` (`DEFAULT_PROMPT_POLICY`):
`reAsks` (how many re-asks), `answerTimeoutMs` (the silence window), and `onUnresolved` (`'no-action'` or `'send-cancel'` to answer an explicit "cancel" instead).
The spoken phrases are right next to it.

## Security model

- **Caller-ID allowlist** - the webhook rejects any call where neither `From` nor `To` is `CEOCHAT_ALLOWED_CALLER` (`<Reject/>`, the call never connects).
- **Webhook authentication** - `X-Twilio-Signature` (HMAC-SHA1, keyed by the auth token) is validated on `/phone/twiml`, so a forged POST cannot mint a stream.
- **Single-use stream token** - the TwiML embeds a short-TTL token that must come back in the Media Streams `start` frame; a direct WS hit on the tunnel-exposed `/phone` path is closed immediately.
  The call slot is claimed only by a token-authorized `start`, so anonymous sockets can never make your call see busy (they are bounded by a handshake deadline and a pre-start cap).
- **Keypad PIN before the first injection** - on every call, inbound or outbound (caller ID is spoofable; the PIN is not). Speech before the PIN passes is ignored entirely.
- **Confirmation guard** - consequential actions still require a clear spoken confirm/cancel (`guardUtterance`), and the timeout default above never approves.
- **One turn at a time** - the phone and the web share a single serialized turn engine.

## Cost (from the plan's cited Twilio pricing, 2026-07-01)

- Number: **$1.15/mo**.
- Inbound: $0.0085/min + $0.004/min Media Streams = **$0.0125/min** (~$0.75/hr).
- Outbound: $0.0140/min + $0.004/min = **$0.0180/min** (~$1.08/hr).
- STT/speakability/TTS: no new fees (self-hosted whisper, existing Gemini + MiniMax/piper).

## Validation

`npm run validate` includes mock Call Mode legs (no Twilio account, no network):
the mu-law wire transcode, the webhook allowlist + signature + token, the keypad-only PIN gate (nothing injected until it passes; pre-auth speech ignored entirely), anonymous-socket hardening (pre-start sockets never hold the call slot; handshake deadline + cap), STT -> send, media+mark framing, barge-in `clear` + turn abort, hangup abort, the interactive-prompt re-ask/safe-default policy, and the byte-exact verbatim web transcript.

## Remaining live test (captain-gated)

Everything above is proven against the mock Media Streams client.
The end-to-end call over a real number needs the captain's Twilio account + secrets, then: `npm run serve`, tap "Call me", and verify greeting/PIN/turn audio latency and barge-in feel on the real phone (ideally while another app plays audio).
