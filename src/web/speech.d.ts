// Types for speech.js — the robust Web Speech (STT) controller.
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechState = 'idle' | 'listening' | 'paused' | 'error';
export interface SpeechResultMeta { isFinal: boolean }
export interface SpeechError { kind: 'permission' | 'transient' | 'unsupported'; message: string }
export interface SpeechControllerOptions {
  createRecognition: () => RecognitionLike;
  lang?: string;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  minRestartMs?: number;
  onState?: (state: SpeechState) => void;
  onResult?: (text: string, meta: SpeechResultMeta) => void;
  onError?: (err: SpeechError) => void;
  log?: (msg: string) => void;
}
export class SpeechController {
  constructor(opts: SpeechControllerOptions);
  readonly state: SpeechState;
  readonly listening: boolean;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
}
