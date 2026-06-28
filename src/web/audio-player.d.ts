// Types for audio-player.js. The AudioContext-like surface is intentionally minimal
// so a fake satisfies it in the harness and the real Web Audio AudioContext does too.
export interface AudioCtxLike {
  state: string;
  sampleRate?: number;
  currentTime: number;
  resume(): Promise<void> | void;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufLike;
  createBufferSource(): AudioSrcLike;
  destination: unknown;
}
export interface AudioBufLike {
  copyToChannel?(src: Float32Array, channel: number, start?: number): void;
  getChannelData?(channel: number): Float32Array;
}
export interface AudioSrcLike {
  buffer: AudioBufLike | null;
  onended: (() => void) | null;
  connect(dest: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface AudioPlayerOptions {
  createContext: () => AudioCtxLike;
  now?: () => number;
  onSpeakingChange?: (speaking: boolean) => void;
  log?: (msg: string) => void;
  pendingMaxBytes?: number;
}
export class AudioPlayer {
  constructor(opts: AudioPlayerOptions);
  readonly speaking: boolean;
  ctx: AudioCtxLike | null;
  unlocked: boolean;
  unlock(): Promise<boolean>;
  enqueue(pcm: string | Uint8Array | ArrayLike<number>, sampleRate: number): void;
  stop(): void;
}
