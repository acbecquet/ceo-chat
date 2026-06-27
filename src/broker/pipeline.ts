// pipeline.ts — the integrated ceo-chat flow, as ONE orchestration function.
//
//   typed text  ->  inject into firstmate (fm-send)  ->  read the agent reply from
//   the transcript tap  ->  speakability rewrite  ->  MiniMax streaming TTS  ->
//   spoken audio (PCM/WAV).
//
// Every leg is injected (PipelineDeps), so the SAME code runs:
//   - in the product (real session + transcript + speakability + MiniMax), and
//   - in `npm run validate` (synthetic agent + mock speakability + mock MiniMax).
// The harness therefore exercises the real integration, not a parallel copy.

import type { SpeakifyResult } from '../speakability/speakability.ts';
import type { SynthResult } from '../tts/minimax.ts';

export interface PipelineDeps {
  /** Inject the typed line into firstmate (verified submit). */
  inject: (text: string) => Promise<void>;
  /** Wait for and return the COMPLETE agent reply (transcript tap + idle latch). */
  readReply: () => Promise<string>;
  /** Rewrite the reply for the ear. */
  speakify: (text: string) => Promise<SpeakifyResult>;
  /** Stream narration chunks into TTS -> PCM. */
  synth: (chunks: string[]) => Promise<SynthResult>;
  /** Optional: a snapshot of the visual terminal (capture-pane). */
  terminalView?: () => string;
  log?: (msg: string) => void;
}

export interface PipelineResult {
  typed: string;
  reply: string;
  narration: string;
  speakBackend: SpeakifyResult['backend'];
  audio: {
    pcm: Buffer;
    bytes: number;
    ttfbMs: number | null;
    sampleRate: number;
    frames: number;
    billing: Record<string, unknown> | null;
  };
  terminal?: string;
}

// Split narration into sentence-sized chunks for streaming task_continue frames —
// this is what lets TTS start speaking before the whole narration is ready.
export function sentenceChunks(narration: string): string[] {
  return narration.match(/[^.!?]+[.!?]*\s*/g) ?? [narration];
}

export async function runPipeline(typed: string, deps: PipelineDeps): Promise<PipelineResult> {
  const log = deps.log ?? (() => {});

  log('inject -> firstmate');
  await deps.inject(typed);

  log('read agent reply (transcript tap)');
  const reply = await deps.readReply();
  if (!reply.trim()) throw new Error('agent reply was empty');

  log('speakability rewrite');
  const { narration, backend } = await deps.speakify(reply);
  if (!narration.trim()) throw new Error('speakability produced empty narration');

  log('MiniMax streaming TTS');
  const synth = await deps.synth(sentenceChunks(narration));

  return {
    typed,
    reply,
    narration,
    speakBackend: backend,
    audio: {
      pcm: synth.pcm,
      bytes: synth.pcm.length,
      ttfbMs: synth.ttfbMs,
      sampleRate: synth.sampleRate,
      frames: synth.frames,
      billing: synth.billing,
    },
    terminal: deps.terminalView ? deps.terminalView() : undefined,
  };
}
