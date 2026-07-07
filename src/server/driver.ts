// driver.ts — what the web transport (app.ts) needs from "the thing that runs a
// turn", decoupled from tmux/claude so the HTTP+WS layer is testable on its own.
//
// The product wires a real Broker (BrokerDriver below); `npm run validate` wires a
// fully in-memory driver (test/validate.ts) that drives the SAME runPipeline with
// mock deps. So the WS contract is asserted without spawning a real agent session.

import type { PipelineStage } from '../broker/pipeline.ts';
import type { Broker } from '../broker/broker.ts';
import type { TtsMode } from './protocol.ts';

export interface DriverMeta {
  ttsMode: TtsMode;
  /** Voice/backend label for the UI (e.g. "en_US-lessac-medium", "minimax", "mock tone"). */
  ttsVoice: string;
  speakBackend: string;
  sampleRate: number;
}

// One progressively-spoken chunk handed to the web layer as the turn streams.
export interface DriverChunk {
  index: number;
  narration: string;
  speakBackend: string;
  pcm: Buffer;
  sampleRate: number;
}

export interface TurnHooks {
  onStage: (stage: PipelineStage) => void;
  /** Progressive: one chunk per speakable unit as the agent talks (before turn end). */
  onChunk?: (chunk: DriverChunk) => void;
  /** A benign Claude modal was auto-dismissed before inject (surface in diagnostics). */
  onNotice?: (message: string) => void;
  /** Barge-in / hangup: when aborted, stop pending speech + in-flight synthesis. */
  signal?: { readonly aborted: boolean };
}

export interface DriverTurn {
  reply: string;
  narration: string;
  speakBackend: string;
  audio: { pcm: Buffer; sampleRate: number; ttfbMs: number | null; bytes: number };
  /** How many progressive chunks were streamed this turn (0 = legacy aggregate path). */
  chunks?: number;
}

export interface Driver {
  meta(): DriverMeta;
  /** Bring the underlying agent session up (no-op for the in-memory test driver). */
  start(): Promise<void>;
  /** Drive one full turn: typed text -> reply -> narration -> spoken PCM. */
  send(text: string, turnIndex: number, hooks: TurnHooks): Promise<DriverTurn>;
  /**
   * Interrupt the underlying agent's in-flight turn so the NEXT injected prompt is
   * re-planned from scratch (attach-and-reinterpret, Feature 3). Best-effort: a driver
   * with no live agent (the in-memory test driver) omits it; the runner treats a missing
   * or failed interrupt as "the correction queues and runs right after" (never lost).
   */
  interrupt?(): Promise<void>;
  /** Current colour-preserving snapshot of the agent pane (for xterm.js). */
  terminalSnapshot(): string;
  stop(): Promise<void>;
}

// The real driver: a thin adapter over the existing Broker. The Broker already owns
// the dedicated `ceo-chat` session, the transcript tap, speakability and TTS — this
// just exposes them through the Driver shape the web layer consumes.
export class BrokerDriver implements Driver {
  private readonly broker: Broker;

  constructor(broker: Broker) {
    this.broker = broker;
  }

  meta(): DriverMeta {
    return {
      ttsMode: this.broker.ttsMode,
      ttsVoice: this.broker.ttsVoiceLabel(),
      speakBackend: this.broker.speakBackendHint(),
      // Hint only — each audio frame carries its own sampleRate (piper 22.05k,
      // MiniMax 32k). The player reads the per-frame rate.
      sampleRate: this.broker.ttsSampleRate(),
    };
  }

  start(): Promise<void> {
    return this.broker.start();
  }

  async send(text: string, turnIndex: number, hooks: TurnHooks): Promise<DriverTurn> {
    let chunks = 0;
    const r = await this.broker.send(text, turnIndex, {
      onStage: hooks.onStage,
      onChunk: (c) => { chunks++; hooks.onChunk?.(c); },
      onNotice: hooks.onNotice,
      signal: hooks.signal,
    });
    return {
      reply: r.reply,
      narration: r.narration,
      speakBackend: r.speakBackend,
      audio: {
        pcm: r.audio.pcm,
        sampleRate: r.audio.sampleRate,
        ttfbMs: r.audio.ttfbMs,
        bytes: r.audio.bytes,
      },
      chunks,
    };
  }

  interrupt(): Promise<void> {
    return this.broker.interrupt();
  }

  terminalSnapshot(): string {
    return this.broker.terminalSnapshot();
  }

  stop(): Promise<void> {
    return this.broker.stop();
  }
}
