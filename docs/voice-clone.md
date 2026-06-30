# Speak in your own voice — MiniMax voice cloning

ceo-chat can read first mate's replies aloud in **your own cloned voice** instead of a
stock voice. You record ~30 seconds of clean speech once, run one command to register
the clone with MiniMax, and set one secret. After that the broker speaks in your voice
with no further changes.

This is a **you-run** step: producing *your* voice requires *your* recording. The
pipeline (upload → register → speak) is built and tested; you supply the audio and run
the final clone.

---

## 1. Record a reference sample

MiniMax clones from a short, clean, **single-speaker** recording.

- **Length:** roughly **10 seconds to 5 minutes**. ~30–60s of natural speech is plenty.
- **Format:** **mp3, m4a, or wav**. Up to **20 MB**.
- **Quality:** quiet room, no music/other voices, consistent distance from the mic,
  your normal speaking pace and tone (this is the voice you'll hear on every call).

Read these phonetically diverse sentences aloud, naturally, start to finish:

1. The quick brown fox jumps over the lazy dog while the sun sets behind the hills.
2. She sells seashells by the seashore, and the shells she sells are surely seashells.
3. Bright blue jays vex the gawky throng of zebras munching juicy figs at dawn.
4. I'd like to merge the pull request, deploy to staging, and then check the logs.
5. Numbers like nineteen, forty-two, and three hundred should sound clear and even.
6. How are we doing on the budget — are we still on track for the Friday release?
7. Please push the changes, run the tests, and let me know if anything breaks.
8. Thank you for the update; let's circle back tomorrow morning after the standup.

Tips: leave a beat of silence at the start/end, and don't rush. If you fumble a line,
just pause and redo it — small imperfections are fine.

## 2. Drop the file where the tooling expects it

Save your recording here (create the folder if needed):

```
~/.config/ceo-chat/voice-samples/captain.mp3      # or .m4a / .wav
```

(The path is only a convention — you can pass any path to the clone command. This
folder sits next to `secrets.env`, outside the repo, and is never committed.)

## 3. Register the clone

You need working MiniMax credentials in `~/.config/ceo-chat/secrets.env`:

```
MINIMAX_API_KEY=...
MINIMAX_GROUP_ID=...
```

Then run, choosing a **voice id** that starts with a letter, is **≥8 characters**, and is
**letters + digits only** (e.g. `CaptainVoice1`):

```
npm run clone-voice -- ~/.config/ceo-chat/voice-samples/captain.mp3 CaptainVoice1
```

What it does (two REST calls against the MiniMax **international** host `api.minimax.io`):

1. `POST /v1/files/upload` — uploads your audio (`purpose=voice_clone`) → returns a `file_id`.
2. `POST /v1/voice_clone` — registers the clone as your chosen `voice_id`.

It does **not** request a preview synthesis, so registering the clone itself doesn't
spend synthesis credits. On success it prints your `voice_id`.

> Credentials note: cloning needs a valid `MINIMAX_API_KEY` **paired with** the matching
> `MINIMAX_GROUP_ID`. A mismatch shows up as `base_resp 1004: token not match group`. If
> you see that, the key and GroupId in `secrets.env` don't belong to the same MiniMax
> account/group — fix them in the [MiniMax console](https://platform.minimax.io) before
> cloning. You can sanity-check pairing without spending anything via
> `npm run validate:live` (the read-only "MiniMax REST auth probe" leg).

## 4. Make it ceo-chat's voice

Add the registered id to `~/.config/ceo-chat/secrets.env`:

```
MINIMAX_VOICE_ID=CaptainVoice1
```

Restart the broker (`npm run serve` or `npm run dev`). Startup will report
`MINIMAX premium cloud voice — minimax (cloned: CaptainVoice1)` and every reply is now
spoken in your voice.

---

## How it fits together

- **Voice precedence is unchanged:** MiniMax (creds present) is the preferred real voice;
  setting `MINIMAX_VOICE_ID` just swaps the *voice id* MiniMax uses (your clone instead of
  the default `male-qn-qingse`). Offline **piper** remains the fallback when there are no
  MiniMax creds; the synthetic **mock** tone is for tests / no voice installed.
- **Model:** the broker speaks via `speech-2.8-turbo` — the latency pick, and it supports
  cloned voice ids. (`speech-2.8-hd` is the higher-fidelity, higher-latency sibling.)
- **Code:** `src/tts/voice-clone.ts` (clone CLI + reusable `uploadReferenceAudio` /
  `registerVoiceClone` / `cloneVoice`), `MINIMAX_VOICE_ID` in `src/config/secrets.ts`,
  wired through `src/broker/broker.ts` → `src/tts/minimax.ts`. The upload/register/synth
  plumbing is unit-tested against the in-process mock MiniMax server (`npm run validate`,
  the `voice clone — …` legs) so no credits are spent proving it works.
```
