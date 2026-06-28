// driver.ts — what the web transport (app.ts) needs from "the thing that runs a
// turn", decoupled from tmux/claude so the HTTP+WS layer is testable on its own.
//
// The product wires a real Broker (BrokerDriver below); `npm run validate` wires a
// fully in-memory driver (test/validate.ts) that drives the SAME runPipeline with
// mock deps. So the WS contract is asserted without spawning a real agent session.

import type { PipelineStage } from '../broker/pipeline.ts';
import type { Broker } from '../broker/broker.ts';

export interface DriverMeta {
  ttsMode: 'live' | 'mock';
  speakBackend: string;
  sampleRate: number;
}

export interface TurnHooks {
  onStage: (stage: PipelineStage) => void;
}

export interface DriverTurn {
  reply: string;
  narration: string;
  speakBackend: string;
  audio: { pcm: Buffer; sampleRate: number; ttfbMs: number | null; bytes: number };
}

export interface Driver {
  meta(): DriverMeta;
  /** Bring the underlying agent session up (no-op for the in-memory test driver). */
  start(): Promise<void>;
  /** Drive one full turn: typed text -> reply -> narration -> spoken PCM. */
  send(text: string, turnIndex: number, hooks: TurnHooks): Promise<DriverTurn>;
  /** Current colour-preserving snapshot of the agent pane (for xterm.js). */
  terminalSnapshot(): string;
  stop(): Promise<void>;
}

// The real driver: a thin adapter over the existing Broker. The Broker already owns
// the dedicated `ceo-chat` session, the transcript tap, speakability and TTS — this
// just exposes them through the Driver shape the web layer consumes.
export class BrokerDriver implements Driver {
  private readonly broker: Broker;
  private readonly sampleRate: number;

  constructor(broker: Broker, sampleRate = 32000) {
    this.broker = broker;
    this.sampleRate = sampleRate;
  }

  meta(): DriverMeta {
    return {
      ttsMode: this.broker.ttsMode,
      speakBackend: this.broker.speakBackendHint(),
      sampleRate: this.sampleRate,
    };
  }

  start(): Promise<void> {
    return this.broker.start();
  }

  async send(text: string, turnIndex: number, hooks: TurnHooks): Promise<DriverTurn> {
    const r = await this.broker.send(text, turnIndex, { onStage: hooks.onStage });
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
    };
  }

  terminalSnapshot(): string {
    return this.broker.terminalSnapshot();
  }

  stop(): Promise<void> {
    return this.broker.stop();
  }
}
