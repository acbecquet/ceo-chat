// broker.ts — the runnable ceo-chat broker: it OWNS a dedicated throwaway firstmate
// session and turns typed lines into spoken audio through the real pipeline.
//
// This is the "finished product" the captain manually tests. It wires the real
// legs into runPipeline():
//   inject     = fm-send.sh verified submit            (src/session)
//   readReply  = transcript JSONL tap + idle latch     (src/transcript)
//   speakify   = Anthropic API or `claude -p` fallback (src/speakability)
//   synth      = MiniMax TTS — LIVE if creds present, else an in-process MOCK
//                server speaking the same protocol so audio still comes out
//   terminal   = tmux capture-pane (the visual view)
//
// TTS mode is chosen automatically: MINIMAX_API_KEY present -> live; otherwise the
// broker stands up the mock MiniMax server so the captain gets real WAV output and a
// full end-to-end run even before the live key is added. Drop the key into
// secrets.env and the SAME broker flips to live with no code change.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadSecrets, has, hasMinimaxCreds, type Secrets } from '../config/secrets.ts';
import {
  spawnCeoChat, teardown, waitForComposer, fmSend, capturePane, sleep,
  type SessionCtx,
} from '../session/session.ts';
import {
  PROJECTS_DIR, mangleCwd, latestTranscriptIn, parseTranscript,
  type TranscriptEvent,
} from '../transcript/transcript.ts';
import { waitForReply } from '../transcript/reply.ts';
import { speakify } from '../speakability/speakability.ts';
import { synthStreaming, toWav, INTL_WS } from '../tts/minimax.ts';
import { runPipeline, type PipelineResult } from './pipeline.ts';
import { startMockMinimax, type MockMinimax } from '../tts/mock-server.ts';

export type TtsMode = 'live' | 'mock';

export interface BrokerOptions {
  outDir: string;
  log?: (msg: string) => void;
  /**
   * Force the fully-offline demo path even when creds exist: mock MiniMax TTS +
   * deterministic mock speakability. Lets the captain exercise the whole pipeline
   * (real firstmate session + transcript tap + audio-out) without depending on live
   * MiniMax (deferred) or a live LLM. Default false -> use real services per creds.
   */
  mock?: boolean;
}

export class Broker {
  private readonly secrets: Secrets;
  private readonly outDir: string;
  private readonly log: (msg: string) => void;
  private ctx: SessionCtx | null = null;
  private projectDir = '';
  private transcriptPath: string | null = null;
  private sayBaseline = 0;
  private mock: MockMinimax | null = null;
  private readonly forceMock: boolean;
  readonly ttsMode: TtsMode;

  constructor(opts: BrokerOptions) {
    this.secrets = loadSecrets();
    this.outDir = opts.outDir;
    this.log = opts.log ?? (() => {});
    this.forceMock = !!opts.mock;
    this.ttsMode = !this.forceMock && hasMinimaxCreds(this.secrets) ? 'live' : 'mock';
  }

  speakBackendHint(): string {
    if (this.forceMock) return 'mock';
    return has(this.secrets, 'ANTHROPIC_API_KEY') ? 'anthropic-api' : 'claude-cli';
  }

  async start(): Promise<void> {
    mkdirSync(this.outDir, { recursive: true });
    this.log('spawning dedicated ceo-chat session');
    this.ctx = spawnCeoChat({ log: this.log });
    this.projectDir = join(PROJECTS_DIR, mangleCwd(this.ctx.cwd));
    await waitForComposer({ log: this.log });
    if (this.ttsMode === 'mock') {
      this.mock = await startMockMinimax();
      this.log('TTS: mock MiniMax (no creds) — real WAV from synthetic PCM');
    } else {
      this.log('TTS: LIVE MiniMax (creds present)');
    }
  }

  // Drive one full turn: typed text -> spoken audio + narration + terminal view.
  async send(typed: string, turnIndex: number): Promise<PipelineResult & { wavPath: string; narrationPath: string }> {
    if (!this.ctx) throw new Error('broker not started');
    const target = this.ctx.target;

    const result = await runPipeline(typed, {
      inject: async (text) => { await fmSend(text, { target, log: this.log }); },
      readReply: () => this.readReply(target),
      speakify: (text) => speakify(text, {
        apiKey: has(this.secrets, 'ANTHROPIC_API_KEY') ? this.secrets.ANTHROPIC_API_KEY : null,
        backend: this.forceMock ? 'mock' : 'auto',
        log: this.log,
      }),
      synth: (chunks) => this.synth(chunks),
      terminalView: () => capturePane(target),
      log: this.log,
    });

    const wavPath = join(this.outDir, `turn-${turnIndex}.wav`);
    const narrationPath = join(this.outDir, `turn-${turnIndex}.txt`);
    writeFileSync(wavPath, toWav({ pcm: result.audio.pcm, sampleRate: result.audio.sampleRate }));
    writeFileSync(narrationPath, result.narration + '\n');
    return { ...result, wavPath, narrationPath };
  }

  async stop(): Promise<void> {
    if (this.mock) { try { await this.mock.close(); } catch { /* ignore */ } this.mock = null; }
    if (this.ctx) { teardown({ cwd: this.ctx.cwd, log: this.log }); this.ctx = null; }
  }

  // ---- internals ----

  private async synth(chunks: string[]) {
    if (this.ttsMode === 'live') {
      return synthStreaming({
        apiKey: this.secrets.MINIMAX_API_KEY!,
        groupId: this.secrets.MINIMAX_GROUP_ID || '',
        textChunks: chunks,
        endpoint: INTL_WS,
        log: this.log,
      });
    }
    return synthStreaming({
      apiKey: 'mock', groupId: 'mock', textChunks: chunks,
      endpoint: this.mock!.endpoint, log: this.log,
    });
  }

  // Wait for the COMPLETE agent reply on the transcript tap (idle latch), tracking a
  // per-turn say baseline so each turn returns only its own new reply.
  private async readReply(target: string): Promise<string> {
    // The transcript is written lazily — discover it after the first inject.
    for (let i = 0; i < 120 && !this.transcriptPath; i++) {
      this.transcriptPath = latestTranscriptIn(this.projectDir);
      if (!this.transcriptPath) await sleep(500);
    }
    if (!this.transcriptPath) throw new Error('no transcript appeared under ' + this.projectDir);
    const path = this.transcriptPath;
    const baseline = this.sayBaseline;

    const reply = await waitForReply({
      readSays: () => {
        const says = parseTranscript(path).filter((e) => e.kind === 'say') as Extract<TranscriptEvent, { kind: 'say' }>[];
        return { count: says.length, text: says.slice(baseline).map((e) => e.text).join('\n') };
      },
      isIdle: () => !/esc to interrupt/i.test(capturePane(target)),
      sleep,
      now: () => performance.now(),
      log: this.log,
    }, { sayBefore: baseline });

    // advance baseline to the new total so the next turn starts clean
    this.sayBaseline = parseTranscript(path).filter((e) => e.kind === 'say').length;
    return reply;
  }
}
