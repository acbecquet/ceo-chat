// Types for audio-player.js. The AudioContext-like surface is intentionally minimal
// so a fake satisfies it in the harness and the real Web Audio AudioContext does too.
export interface AudioCtxLike {
  state: string;
  sampleRate?: number;
  currentTime: number;
  resume(): Promise<void> | void;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufLike;
  createBufferSource(): AudioSrcLike;
  createGain?(): { gain?: { value: number }; connect(dest: unknown): void; disconnect?(): void };
  destination: unknown;
}
export interface AudioBufLike {
  copyToChannel?(src: Float32Array, channel: number, start?: number): void;
  getChannelData?(channel: number): Float32Array;
}
export interface AudioSrcLike {
  buffer: AudioBufLike | null;
  onended: (() => void) | null;
  loop?: boolean;
  connect(dest: unknown): void;
  disconnect?(): void;
  start(when?: number): void;
  stop(when?: number): void;
}
// Minimal HTMLAudioElement-like surface for the fallback playback path. A fake
// satisfies it in the harness; the real <audio> element does too.
export interface AudioElLike {
  src: string;
  muted: boolean;
  autoplay?: boolean;
  preload?: string;
  onended: (() => void) | null;
  onerror: ((e?: unknown) => void) | null;
  play(): Promise<void> | void;
  pause(): void;
}
// One structured diagnostics record (rendered live in the on-screen panel).
export interface AudioDiag {
  t: 'ctx' | 'keepalive' | 'element' | 'play' | 'playerr';
  state?: string;
  keepAlive?: boolean;
  active?: boolean;
  armed?: boolean;
  via?: 'webaudio' | 'element' | 'pending';
  bytes?: number;
  ctxState?: string;
  error?: string;
  reason?: string;
}
export interface AudioPlayerOptions {
  createContext: () => AudioCtxLike;
  now?: () => number;
  onSpeakingChange?: (speaking: boolean) => void;
  log?: (msg: string) => void;
  onDiag?: (rec: AudioDiag) => void;
  pendingMaxBytes?: number;
  createAudioElement?: () => AudioElLike;
  makeObjectUrl?: (bytes: Uint8Array) => string;
  revokeObjectUrl?: (url: string) => void;
  defaultSampleRate?: number;
}
export class AudioPlayer {
  constructor(opts: AudioPlayerOptions);
  readonly speaking: boolean;
  readonly keepAliveActive: boolean;
  readonly ctxState: string;
  ctx: AudioCtxLike | null;
  unlocked: boolean;
  unlock(): Promise<boolean>;
  enqueue(pcm: string | Uint8Array | ArrayLike<number>, sampleRate: number): void;
  stop(): void;
}
