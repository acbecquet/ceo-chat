// protocol.ts — the ceo-chat web WebSocket message contract (browser <-> broker).
//
// One small, explicit JSON protocol so the browser UI and the server can't drift,
// and so `npm run validate` can assert it. All frames are JSON text. Audio is sent
// as base64 PCM (16-bit little-endian mono) the page decodes via Web Audio — this
// works identically for the mock TTS (synthetic sine) and live MiniMax, since both
// surface raw PCM through the same pipeline.

// Same-origin WS endpoint. A relative ws(s):// upgrade to this path rides whatever
// scheme/host served the page, so it works on localhost AND through the Cloudflare
// named tunnel (wss://ceo-chat.acb-apps.com) with no host assumptions.
export const WS_PATH = '/ws';

// UI status indicator states (plan §9: listening / thinking / speaking / confirm).
export type UiStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'awaiting-confirmation';

// PCM audio is always this shape (matches the pipeline / piper / mock output).
export const AUDIO_FORMAT = 'pcm-s16le-mono';

// TTS backend the broker is speaking through (plan §6 + local-voice addendum):
//   minimax = premium cloud voice (creds present); local = offline piper neural
//   voice (DEFAULT — real words, no key); mock = synthetic tone (unit tests).
export type TtsMode = 'minimax' | 'local' | 'mock';

// Sample rate the SERVER-SIDE STT path expects the browser to send mic PCM at.
export const STT_SAMPLE_RATE = 16000;

// Where a turn was initiated from. Phone and SMS turns broadcast to the web
// clients too - the web app is the companion screen showing the verbatim
// transcript whichever transport the captain used.
export type TurnSource = 'web' | 'phone' | 'sms';

// Twilio call state surfaced to the browser (the "Call me" flow + on-call status).
export type PhoneState = 'unavailable' | 'idle' | 'dialing' | 'in-call' | 'ended' | 'failed';

// ---- client -> server ----
export type ClientMessage =
  // The captain typed (or spoke, via browser STT) a line for firstmate.
  | { type: 'send'; text: string }
  // The mic button toggled — purely a status hint so other viewers see it.
  | { type: 'listening'; on: boolean }
  // SERVER-SIDE STT fallback: a chunk of captured mic PCM (base64 s16le mono).
  | { type: 'stt-audio'; pcm: string; sampleRate: number }
  // End of the spoken utterance — transcribe the buffered audio and return text.
  | { type: 'stt-end' }
  // Discard any buffered STT audio without transcribing (barge-in / mic released).
  | { type: 'stt-cancel' }
  // Barge-in / hangup: cancel the in-flight turn (stop pending speech + synthesis).
  | { type: 'stop' }
  // Outbound Call Mode: ask the broker to ring the captain's phone (Twilio REST).
  | { type: 'call-me' }
  // Liveness.
  | { type: 'ping' };

// ---- server -> client ----
export type ServerMessage =
  // Sent once on connect: current modes + audio params for the player.
  | {
      type: 'hello';
      ttsMode: TtsMode;
      ttsVoice: string;
      speakBackend: string;
      sampleRate: number;
      audioFormat: typeof AUDIO_FORMAT;
      // Server-side STT availability (local whisper). The browser still prefers its
      // own Web Speech; this is the fallback when that's unavailable/flaky.
      serverStt: boolean;
      sttLabel: string;
      // Is the outbound "Call me" phone trigger available (Twilio creds paired)?
      phone: boolean;
    }
  // Result of a SERVER-SIDE STT transcription — handed BACK to the client (not
  // auto-run) so the confirmation guard (§3.5) applies before it reaches firstmate.
  // `empty` (no speech recognized) / `reason` (why nothing came back) make a silent
  // failure VISIBLE on the device instead of "mic on, no words" — the captain's bug.
  | { type: 'transcript'; text: string; final: boolean; empty?: boolean; bytes?: number; reason?: string }
  // Status indicator transition.
  | { type: 'status'; state: UiStatus }
  // A full snapshot of the agent terminal pane (ANSI), for xterm.js.
  | { type: 'terminal'; data: string }
  // Echo of an ACCEPTED captain line (typed, spoken, or over the phone) so every
  // connected client renders the same conversation - including turns the captain
  // started from the phone call. `ts` = epoch ms for the transcript timestamps.
  | { type: 'sent'; turn: number; text: string; source: TurnSource; ts: number; replay?: boolean }
  // The 1:1 VERBATIM transcript of first mate's ACTUAL reply - the exact assistant
  // text from the session transcript, streamed live as the turn runs (each frame is
  // the full text-so-far; the client re-renders). The `final:true` frame is the
  // byte-exact complete reply - the authoritative text the captain reads for detail
  // the spoken summary compressed away.
  | { type: 'verbatim'; turn: number; text: string; final?: boolean; ts?: number; replay?: boolean }
  // Twilio Call Mode status (the "Call me" flow + on-call indicator).
  | { type: 'phone'; state: PhoneState; detail?: string }
  // The raw agent reply text (shown in the transcript column). `replay` = state
  // re-sent to a reconnecting client (page refresh) — show it, don't re-run anything.
  | { type: 'reply'; turn: number; text: string; replay?: boolean }
  // The speakability narration (the words actually spoken). Streamed PROGRESSIVELY —
  // one frame per speakable unit as the agent talks (carries `index`), so the captain
  // hears the first sentence ~1s in instead of after the whole turn.
  | { type: 'narration'; turn: number; text: string; backend: string; index?: number; replay?: boolean }
  // One unit's spoken audio, base64 PCM. Multiple per turn (progressive); the client
  // queues them gaplessly. `replay` audio (reconnect) is NOT auto-played.
  | { type: 'audio'; turn: number; pcm: string; sampleRate: number; format: typeof AUDIO_FORMAT; index?: number; replay?: boolean }
  // A benign Claude Code modal was auto-dismissed before injecting (feedback/trust
  // dialog) — surfaced for the diagnostics panel. Not an error.
  | { type: 'notice'; message: string }
  // Turn finished cleanly (metrics for the UI).
  | { type: 'turn-done'; turn: number; ttfbMs: number | null; bytes: number; replay?: boolean }
  // Something failed mid-turn; the UI returns to idle.
  | { type: 'error'; message: string }
  // Liveness.
  | { type: 'pong' };
