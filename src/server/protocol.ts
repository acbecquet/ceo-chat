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

// PCM audio is always this shape (matches the pipeline / mock MiniMax output).
export const AUDIO_FORMAT = 'pcm-s16le-mono';

// ---- client -> server ----
export type ClientMessage =
  // The captain typed (or spoke, via browser STT) a line for firstmate.
  | { type: 'send'; text: string }
  // The mic button toggled — purely a status hint so other viewers see it.
  | { type: 'listening'; on: boolean }
  // Liveness.
  | { type: 'ping' };

// ---- server -> client ----
export type ServerMessage =
  // Sent once on connect: current modes + audio params for the player.
  | {
      type: 'hello';
      ttsMode: 'live' | 'mock';
      speakBackend: string;
      sampleRate: number;
      audioFormat: typeof AUDIO_FORMAT;
    }
  // Status indicator transition.
  | { type: 'status'; state: UiStatus }
  // A full snapshot of the agent terminal pane (ANSI), for xterm.js.
  | { type: 'terminal'; data: string }
  // The raw agent reply text (shown in the transcript column).
  | { type: 'reply'; turn: number; text: string }
  // The speakability narration (the words actually spoken).
  | { type: 'narration'; turn: number; text: string; backend: string }
  // One turn's spoken audio, base64 PCM.
  | { type: 'audio'; turn: number; pcm: string; sampleRate: number; format: typeof AUDIO_FORMAT }
  // Turn finished cleanly (metrics for the UI).
  | { type: 'turn-done'; turn: number; ttfbMs: number | null; bytes: number }
  // Something failed mid-turn; the UI returns to idle.
  | { type: 'error'; message: string }
  // Liveness.
  | { type: 'pong' };
