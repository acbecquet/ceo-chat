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
  spawnCeoChat, attachTarget, resolveTargetFromEnv, teardown, waitForComposer, fmSend,
  capturePane, capturePaneAnsi, sleep,
  type SessionCtx, type TargetSpec,
} from '../session/session.ts';
import {
  PROJECTS_DIR, mangleCwd, latestTranscriptIn, parseTranscript,
  type TranscriptEvent,
} from '../transcript/transcript.ts';
import { waitForReply } from '../transcript/reply.ts';
import { speakify } from '../speakability/speakability.ts';
import { synthStreaming, toWav, INTL_WS } from '../tts/minimax.ts';
import { runPipeline, type PipelineResult, type PipelineStage } from './pipeline.ts';
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
  private mock: MockMinimax | null = null;
  private readonly forceMock: boolean;
  private readonly targetSpec: TargetSpec | null;
  readonly ttsMode: TtsMode;

  constructor(opts: BrokerOptions) {
    this.secrets = loadSecrets();
    this.outDir = opts.outDir;
    this.log = opts.log ?? (() => {});
    this.forceMock = !!opts.mock;
    this.ttsMode = !this.forceMock && hasMinimaxCreds(this.secrets) ? 'live' : 'mock';
    // CEOCHAT_TARGET (/_SESSION/_WINDOW) -> attach to a real first mate; else spawn.
    this.targetSpec = resolveTargetFromEnv();
  }

  speakBackendHint(): string {
    if (this.forceMock) return 'mock';
    return has(this.secrets, 'ANTHROPIC_API_KEY') ? 'anthropic-api' : 'claude-cli';
  }

  /** Is the broker attaching to a captain-launched first mate (vs spawning one)? */
  isAttached(): boolean {
    return this.targetSpec !== null;
  }

  /** Human-readable description of what this broker drives (for startup logs). */
  targetLabel(): string {
    return this.targetSpec
      ? `attached to first mate ${this.targetSpec.target}`
      : 'dedicated throwaway ceo-chat session';
  }

  async start(): Promise<void> {
    mkdirSync(this.outDir, { recursive: true });
    if (this.targetSpec) {
      this.log(`attaching to existing first mate ${this.targetSpec.target}`);
      this.ctx = attachTarget(this.targetSpec, { log: this.log });
      this.projectDir = join(PROJECTS_DIR, mangleCwd(this.ctx.cwd));
      // The attached session's transcript already exists and may hold a long
      // history — its discovery happens lazily (captureBaseline) and each turn
      // baselines at the CURRENT say-count, so we only ever speak NEW replies.
    } else {
      this.log('spawning dedicated ceo-chat session');
      this.ctx = spawnCeoChat({ log: this.log });
      this.projectDir = join(PROJECTS_DIR, mangleCwd(this.ctx.cwd));
      await waitForComposer({ log: this.log });
    }
    if (this.ttsMode === 'mock') {
      this.mock = await startMockMinimax();
      this.log('TTS: mock MiniMax (no creds) — real WAV from synthetic PCM');
    } else {
      this.log('TTS: LIVE MiniMax (creds present)');
    }
  }

  // Drive one full turn: typed text -> spoken audio + narration + terminal view.
  // `onStage` (optional) lets the web UI drive its listening/thinking/speaking
  // status indicators off real pipeline progress.
  async send(
    typed: string,
    turnIndex: number,
    opts: { onStage?: (stage: PipelineStage) => void } = {},
  ): Promise<PipelineResult & { wavPath: string; narrationPath: string }> {
    if (!this.ctx) throw new Error('broker not started');
    const target = this.ctx.target;

    // Snapshot the say-count BEFORE injecting so readReply returns only THIS turn's
    // new reply — essential when attached to a live first mate whose transcript
    // already holds a backlog (and whatever the captain types directly in the pane).
    const baseline = this.captureBaseline();

    const result = await runPipeline(typed, {
      inject: async (text) => { await fmSend(text, { target, log: this.log }); },
      readReply: () => this.readReply(target, baseline),
      speakify: (text) => speakify(text, {
        apiKey: has(this.secrets, 'ANTHROPIC_API_KEY') ? this.secrets.ANTHROPIC_API_KEY : null,
        backend: this.forceMock ? 'mock' : 'auto',
        log: this.log,
      }),
      synth: (chunks) => this.synth(chunks),
      terminalView: () => capturePane(target),
      onStage: opts.onStage,
      log: this.log,
    });

    const wavPath = join(this.outDir, `turn-${turnIndex}.wav`);
    const narrationPath = join(this.outDir, `turn-${turnIndex}.txt`);
    writeFileSync(wavPath, toWav({ pcm: result.audio.pcm, sampleRate: result.audio.sampleRate }));
    writeFileSync(narrationPath, result.narration + '\n');
    return { ...result, wavPath, narrationPath };
  }

  // A colour-preserving snapshot of the live agent pane, for the web terminal view
  // (xterm.js). Empty string before the session is up.
  terminalSnapshot(): string {
    if (!this.ctx) return '';
    return capturePaneAnsi(this.ctx.target);
  }

  async stop(): Promise<void> {
    if (this.mock) { try { await this.mock.close(); } catch { /* ignore */ } this.mock = null; }
    if (this.ctx) {
      if (this.ctx.owned) {
        teardown({ cwd: this.ctx.cwd, log: this.log });
      } else {
        // Attached to the captain's first mate — leave it running, just detach.
        this.log(`detaching from ${this.ctx.target} (left running)`);
      }
      this.ctx = null;
    }
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

  // Current number of assistant `say` blocks in the transcript (0 before it appears).
  // Used as the per-turn baseline so a turn returns only the reply it triggered.
  // Re-resolves the newest transcript EACH turn (never caches for the broker's life):
  // an attached first mate rotates its JSONL on /clear, compaction, or a new session
  // UUID, and a stale cached path would silently time out at 150s every later turn.
  private captureBaseline(): number {
    const latest = latestTranscriptIn(this.projectDir);
    if (latest && latest !== this.transcriptPath) {
      if (this.transcriptPath) this.log(`transcript rotated -> ${latest}`);
      this.transcriptPath = latest;
    }
    if (!this.transcriptPath) return 0;
    return parseTranscript(this.transcriptPath).filter((e) => e.kind === 'say').length;
  }

  // Wait for the COMPLETE agent reply on the transcript tap (idle latch). `baseline`
  // is the say-count captured just before this turn's inject, so we read only the
  // new say blocks this turn produced.
  private async readReply(target: string, baseline: number): Promise<string> {
    // The transcript is written lazily — discover it after the first inject.
    for (let i = 0; i < 120 && !this.transcriptPath; i++) {
      this.transcriptPath = latestTranscriptIn(this.projectDir);
      if (!this.transcriptPath) await sleep(500);
    }
    if (!this.transcriptPath) throw new Error('no transcript appeared under ' + this.projectDir);
    const path = this.transcriptPath;

    return waitForReply({
      readSays: () => {
        const says = parseTranscript(path).filter((e) => e.kind === 'say') as Extract<TranscriptEvent, { kind: 'say' }>[];
        return { count: says.length, text: says.slice(baseline).map((e) => e.text).join('\n') };
      },
      isIdle: () => !/esc to interrupt/i.test(capturePane(target)),
      sleep,
      now: () => performance.now(),
      log: this.log,
    }, { sayBefore: baseline });
  }
}
