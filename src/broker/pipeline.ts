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

// Coarse pipeline stages, emitted via onStage so a front-end (the web UI) can drive
// listening/thinking/speaking status indicators without scraping log strings.
export type PipelineStage = 'inject' | 'reply' | 'speak' | 'synth' | 'done';

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
  /** Optional: notified as each stage begins (drives UI status indicators). */
  onStage?: (stage: PipelineStage) => void;
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

// One progressively-spoken chunk: a complete speakable unit that has been rewritten
// (narration) and synthesized (pcm), ready to broadcast/play before the turn finishes.
export interface PipelineChunk {
  index: number;
  narration: string;
  speakBackend: SpeakifyResult['backend'];
  pcm: Buffer;
  sampleRate: number;
  ttfbMs: number | null;
  frames: number;
}

export interface StreamingPipelineDeps {
  inject: (text: string) => Promise<void>;
  /** Stream the reply, invoking onUnit for each complete speakable unit. */
  streamReply: (onUnit: (unitText: string) => void) => Promise<string>;
  speakify: (text: string) => Promise<SpeakifyResult>;
  synth: (chunks: string[]) => Promise<SynthResult>;
  /** Emitted as each unit finishes synth — drives progressive broadcast/playback. */
  onChunk: (chunk: PipelineChunk) => void;
  terminalView?: () => string;
  onStage?: (stage: PipelineStage) => void;
  /** Barge-in / hangup: when aborted, stop emitting + synthesizing further units. */
  signal?: { readonly aborted: boolean };
  log?: (msg: string) => void;
}

// Incremental pipeline: inject -> stream the reply -> for each complete unit, rewrite
// (speakify) + synthesize (TTS) + emit a chunk, so audio starts within ~1-2s and
// continues as the agent keeps talking. Returns the SAME aggregate shape as runPipeline
// (full reply, concatenated narration + pcm) so callers can persist/replay the turn.
export async function runStreamingPipeline(
  typed: string,
  deps: StreamingPipelineDeps,
): Promise<PipelineResult> {
  const log = deps.log ?? (() => {});
  const stage = deps.onStage ?? (() => {});
  const aborted = (): boolean => !!deps.signal?.aborted;

  stage('inject');
  log('inject -> firstmate');
  await deps.inject(typed);

  stage('reply');
  log('stream agent reply (transcript tap) — speaking units as they arrive');

  const narrations: string[] = [];
  const pcms: Buffer[] = [];
  let index = 0;
  let sampleRate = 0;
  let firstTtfb: number | null = null;
  let totalFrames = 0;
  let speakBackend: SpeakifyResult['backend'] = 'noop';

  // Process units one at a time so audio stays ORDERED and synth never overlaps. Each
  // unit: rewrite (speakify) -> TTS (synth) -> emit a chunk for progressive playback.
  let queue: Promise<void> = Promise.resolve();
  const handleUnit = (unitText: string): void => {
    queue = queue.then(async () => {
      if (aborted()) return;
      const text = unitText.trim();
      if (!text) return;
      const { narration, backend } = await deps.speakify(text);
      if (aborted() || !narration.trim()) return;
      speakBackend = backend;
      const synth = await deps.synth(sentenceChunks(narration));
      if (aborted()) return;
      if (index === 0) stage('synth');
      const chunk: PipelineChunk = {
        index: index++, narration, speakBackend: backend,
        pcm: synth.pcm, sampleRate: synth.sampleRate, ttfbMs: synth.ttfbMs, frames: synth.frames,
      };
      narrations.push(narration);
      pcms.push(synth.pcm);
      if (sampleRate === 0) sampleRate = synth.sampleRate;
      if (firstTtfb == null) firstTtfb = synth.ttfbMs;
      totalFrames += synth.frames;
      deps.onChunk(chunk);
    }).catch((e: unknown) => { log('unit speak failed: ' + (e as Error).message); });
  };

  const reply = await deps.streamReply(handleUnit);
  await queue; // drain any unit still being rewritten/synthesized
  stage('done');

  // An aborted turn (barge-in/hangup) legitimately yields no reply — don't treat that
  // as an error. A non-aborted empty reply is a real failure (nothing to speak).
  if (!reply.trim() && !aborted()) throw new Error('agent reply was empty');

  const pcm = Buffer.concat(pcms);
  return {
    typed,
    reply,
    narration: narrations.join(' ').replace(/\s+/g, ' ').trim(),
    speakBackend,
    audio: {
      pcm, bytes: pcm.length, ttfbMs: firstTtfb,
      sampleRate: sampleRate || 22050, frames: totalFrames, billing: null,
    },
    terminal: deps.terminalView ? deps.terminalView() : undefined,
  };
}

export async function runPipeline(typed: string, deps: PipelineDeps): Promise<PipelineResult> {
  const log = deps.log ?? (() => {});
  const stage = deps.onStage ?? (() => {});

  stage('inject');
  log('inject -> firstmate');
  await deps.inject(typed);

  stage('reply');
  log('read agent reply (transcript tap)');
  const reply = await deps.readReply();
  if (!reply.trim()) throw new Error('agent reply was empty');

  stage('speak');
  log('speakability rewrite');
  const { narration, backend } = await deps.speakify(reply);
  if (!narration.trim()) throw new Error('speakability produced empty narration');

  stage('synth');
  log('MiniMax streaming TTS');
  const synth = await deps.synth(sentenceChunks(narration));
  stage('done');

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
