// broker.ts — the runnable ceo-chat broker: it OWNS a dedicated throwaway firstmate
// session and turns typed lines into spoken audio through the real pipeline.
//
// This is the "finished product" the captain manually tests. It wires the real legs
// into runStreamingPipeline() — speaking PROGRESSIVELY (a chunk per speakable unit) so
// audio starts ~1-2s in instead of after the whole turn:
//   inject     = auto-dismiss benign modals + fm-send.sh verified submit (src/session)
//   streamReply= PROMPT-ANCHORED transcript tap streaming units          (src/transcript)
//   speakify   = Anthropic API (fast) or deterministic rule rewriter     (src/speakability)
//   synth      = piper / MiniMax / mock TTS, per unit                    (src/tts)
//   terminal   = tmux capture-pane (the visual view)
//
// TTS mode is chosen automatically: MINIMAX_API_KEY present -> live; otherwise the
// broker stands up the mock MiniMax server so the captain gets real WAV output and a
// full end-to-end run even before the live key is added. Drop the key into
// secrets.env and the SAME broker flips to live with no code change.

import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadSecrets, has, hasMinimaxCreds, hasGeminiCreds, minimaxVoiceId, type Secrets } from '../config/secrets.ts';
import {
  spawnCeoChat, attachTarget, resolveTargetFromEnv, teardown, waitForComposer, fmSend,
  capturePane, capturePaneAnsi, sendKey, dismissBenignModals, sleep,
  type SessionCtx, type TargetSpec,
} from '../session/session.ts';
import {
  PROJECTS_DIR, mangleCwd, parseTranscript,
  latestTranscriptWithPrompt, findPromptAnchor, saysAfterAnchor,
} from '../transcript/transcript.ts';
import { streamReply, splitCompleteBlocks } from '../transcript/reply.ts';
import { speakify, GEMINI_MODEL, type SpeakabilityBackend } from '../speakability/speakability.ts';
import { synthStreaming, toWav, INTL_WS, DEFAULT_SAMPLE_RATE } from '../tts/minimax.ts';
import { findPiper, synthLocal, type LocalVoice } from '../tts/local-tts.ts';
import {
  runStreamingPipeline, type PipelineResult, type PipelineStage, type PipelineChunk,
} from './pipeline.ts';
import { startMockMinimax, type MockMinimax } from '../tts/mock-server.ts';
import type { TtsMode } from '../server/protocol.ts';

export type { TtsMode };

// Pure precedence for the PROGRESSIVE/streaming speakability backend (exported so the
// validation harness can assert it without disk secrets). Gemini Flash is PREFERRED on
// hub — fast, free-tier, no Anthropic key needed; then the Anthropic API; else the
// deterministic rule-based rewriter. `--mock`/CEOCHAT_MOCK forces 'mock'.
export function pickStreamSpeakBackend(secrets: Secrets, forceMock: boolean): SpeakabilityBackend {
  if (forceMock) return 'mock';
  if (hasGeminiCreds(secrets)) return 'gemini';
  return has(secrets, 'ANTHROPIC_API_KEY') ? 'anthropic-api' : 'mock';
}

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
  private mock: MockMinimax | null = null;
  private voice: LocalVoice | null = null;
  private readonly forceMock: boolean;
  private readonly targetSpec: TargetSpec | null;
  readonly ttsMode: TtsMode;

  constructor(opts: BrokerOptions) {
    this.secrets = loadSecrets();
    this.outDir = opts.outDir;
    this.log = opts.log ?? (() => {});
    this.forceMock = !!opts.mock;
    // TTS backend precedence: MiniMax (premium, creds present) -> local piper neural
    // voice (DEFAULT offline — real words, no key) -> mock synthetic tone (unit
    // tests / no voice installed). --mock / CEOCHAT_MOCK forces the tone.
    if (this.forceMock) {
      this.ttsMode = 'mock';
    } else if (hasMinimaxCreds(this.secrets)) {
      this.ttsMode = 'minimax';
    } else {
      this.voice = findPiper();
      this.ttsMode = this.voice ? 'local' : 'mock';
    }
    // CEOCHAT_TARGET (/_SESSION/_WINDOW) -> attach to a real first mate; else spawn.
    this.targetSpec = resolveTargetFromEnv();
  }

  // The speakability backend used for the PROGRESSIVE/streaming path. We deliberately
  // avoid `claude -p` here: spawning it per speakable unit costs seconds each and would
  // defeat the whole point of incremental speak. Precedence: Gemini Flash when a key is
  // paired (fast, free-tier, no Anthropic key — the hub default and PREFERRED), else
  // Anthropic API, else the deterministic rule-based rewriter (instant, still honors the
  // §7.3 contract — drops code/paths/URLs, keeps questions). Gemini fails SAFE per chunk
  // (errors fall back to the rule rewriter). The mock tone path forces 'mock' too.
  private streamSpeakBackend(): SpeakabilityBackend {
    return pickStreamSpeakBackend(this.secrets, this.forceMock);
  }

  speakBackendHint(): string {
    const backend = this.streamSpeakBackend();
    return backend === 'gemini' ? `gemini (${GEMINI_MODEL})` : backend;
  }

  /** Human label of the TTS voice/backend in use (for logs + the UI). */
  ttsVoiceLabel(): string {
    if (this.ttsMode === 'local') return this.voice ? this.voice.name : 'local';
    if (this.ttsMode === 'minimax') {
      const cloned = minimaxVoiceId(this.secrets);
      return cloned ? `minimax (cloned: ${cloned})` : 'minimax (default voice)';
    }
    return 'mock tone';
  }

  /** Native sample rate of the active TTS backend (audio frames carry their own). */
  ttsSampleRate(): number {
    return this.ttsMode === 'local' && this.voice ? this.voice.sampleRate : DEFAULT_SAMPLE_RATE;
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
      // history — each turn anchors to the file that recorded ITS injected prompt and
      // reads only the says after that anchor, so we only ever speak the NEW reply
      // (never the backlog), even with other concurrent claude sessions in this dir.
    } else {
      this.log('spawning dedicated ceo-chat session');
      this.ctx = spawnCeoChat({ log: this.log });
      this.projectDir = join(PROJECTS_DIR, mangleCwd(this.ctx.cwd));
      await waitForComposer({ log: this.log });
    }
    if (this.ttsMode === 'mock') {
      this.mock = await startMockMinimax();
      this.log('TTS: mock MiniMax (no creds, no voice installed) — synthetic tone for unit tests');
    } else if (this.ttsMode === 'local') {
      this.log(`TTS: LOCAL piper voice (${this.voice!.name}) — real offline speech, no key`);
    } else {
      this.log('TTS: LIVE MiniMax (creds present) — premium cloud voice');
    }
  }

  // Drive one full turn: typed text -> spoken audio + narration + terminal view.
  // Speaks PROGRESSIVELY — each speakable unit is rewritten + synthesized + emitted via
  // `onChunk` as the agent talks, so audio starts within ~1-2s instead of after the
  // whole (often 30s+) turn. `onStage` drives the web UI status; `onNotice` surfaces an
  // auto-dismissed benign modal; `signal` cancels pending speech on barge-in/hangup.
  async send(
    typed: string,
    turnIndex: number,
    opts: {
      onStage?: (stage: PipelineStage) => void;
      onChunk?: (chunk: PipelineChunk) => void;
      onNotice?: (message: string) => void;
      signal?: { readonly aborted: boolean };
    } = {},
  ): Promise<PipelineResult & { wavPath: string; narrationPath: string }> {
    if (!this.ctx) throw new Error('broker not started');
    const target = this.ctx.target;

    // Captured just before fm-send submits, so the reply tap can anchor to the user
    // line claude writes at/after this instant — never an IDENTICAL earlier turn's line
    // (the repeated-confirmation-prompt hazard). Set in inject (which runs first).
    let baselineTs = '';
    const result = await runStreamingPipeline(typed, {
      inject: async (text) => {
        // Auto-dismiss a benign Claude modal (feedback rating / trust dialog) that
        // would otherwise swallow this message into the popup — the captain's wedge.
        const dismissed = await dismissBenignModals({
          capture: () => capturePane(target),
          sendKey: (k) => sendKey(target, k),
          log: this.log,
        });
        if (dismissed) opts.onNotice?.(`Auto-dismissed ${dismissed.detail} before sending.`);
        baselineTs = new Date().toISOString();
        await fmSend(text, { target, log: this.log });
      },
      // Anchor the reply to the transcript that recorded OUR prompt (multi-session safe)
      // and stream its says as speakable units.
      streamReply: (onUnit) => this.streamReplyFor(target, typed, () => baselineTs, onUnit, opts.signal),
      speakify: (text, context) => speakify(text, {
        apiKey: has(this.secrets, 'ANTHROPIC_API_KEY') ? this.secrets.ANTHROPIC_API_KEY : null,
        geminiApiKey: hasGeminiCreds(this.secrets) ? this.secrets.GEMINI_API_KEY : null,
        backend: this.streamSpeakBackend(),
        context,
        log: this.log,
      }),
      synth: (chunks) => this.synth(chunks),
      terminalView: () => capturePane(target),
      onStage: opts.onStage,
      onChunk: (c) => opts.onChunk?.(c),
      signal: opts.signal,
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
    if (this.ttsMode === 'minimax') {
      return synthStreaming({
        apiKey: this.secrets.MINIMAX_API_KEY!,
        groupId: this.secrets.MINIMAX_GROUP_ID || '',
        textChunks: chunks,
        // The captain's CLONED voice when MINIMAX_VOICE_ID is set; otherwise
        // synthStreaming falls back to DEFAULT_VOICE_ID. This is the whole wiring
        // for "speak in my own voice" — register once via `npm run clone-voice`.
        voiceId: minimaxVoiceId(this.secrets),
        endpoint: INTL_WS,
        log: this.log,
      });
    }
    if (this.ttsMode === 'local') {
      return synthLocal(this.voice!, chunks, { log: this.log });
    }
    return synthStreaming({
      apiKey: 'mock', groupId: 'mock', textChunks: chunks,
      endpoint: this.mock!.endpoint, log: this.log,
    });
  }

  // Stream THIS turn's reply as speakable units, anchored to the transcript that
  // recorded our injected prompt. This is the robustness fix for an attached first mate:
  // ~/firstmate's project dir is shared with OTHER concurrent claude sessions (the
  // supervisor, crewmates), so "newest transcript by mtime" flip-flops between unrelated
  // files (seen live in the captain's serve.log). The file holding OUR prompt is the
  // unambiguous one. We RE-RESOLVE it every poll, so a mid-turn /clear or compaction
  // that re-records the prompt in a fresh UUID file is followed forward seamlessly; the
  // unit dedup in streamReply makes any re-read of already-spoken text a non-event.
  private async streamReplyFor(
    target: string,
    injectedText: string,
    getBaselineTs: () => string,
    onUnit: (unitText: string) => void,
    signal?: { readonly aborted: boolean },
  ): Promise<string> {
    const afterTs = (): string | undefined => getBaselineTs() || undefined;
    // The user turn is written lazily — wait for OUR prompt to appear in some transcript.
    let anchored: string | null = null;
    for (let i = 0; i < 120 && !anchored; i++) {
      if (signal?.aborted) return '';
      anchored = latestTranscriptWithPrompt(this.projectDir, injectedText, { afterTs: afterTs() });
      if (!anchored) await sleep(500);
    }
    if (!anchored) {
      throw new Error('our injected prompt never appeared in any transcript under ' + this.projectDir);
    }
    let activePath = anchored;
    let lastSig = ''; // mtime:size of activePath at the previous poll

    return streamReply({
      readSays: () => {
        let sig = '';
        try { const st = statSync(activePath); sig = st.mtimeMs + ':' + st.size; } catch { sig = ''; }
        // Only rescan the dir for a rotation when the active transcript has NOT advanced:
        // a growing file means we are still on the right one (the common path), so we skip
        // re-parsing several multi-MB siblings every poll. A stalled file may mean a
        // mid-turn /clear/compaction re-anchored our prompt to a fresh UUID — then rescan.
        if (sig === '' || sig === lastSig) {
          const latest = latestTranscriptWithPrompt(this.projectDir, injectedText, { afterTs: afterTs() });
          if (latest && latest !== activePath) {
            this.log(`transcript rotated mid-turn (prompt re-anchored) -> ${latest}`);
            activePath = latest;
            try { const st = statSync(activePath); sig = st.mtimeMs + ':' + st.size; } catch { sig = ''; }
          }
        }
        lastSig = sig;
        const events = parseTranscript(activePath);
        const says = saysAfterAnchor(events, findPromptAnchor(events, injectedText, { afterTs: afterTs() }));
        return { count: says.length, text: says.map((e) => e.text).join('\n') };
      },
      isIdle: () => !/esc to interrupt/i.test(capturePane(target)),
      sleep,
      now: () => performance.now(),
      onUnit,
      // Speak at TOPIC-block granularity (not per sentence): each unit carries enough of
      // the reply for the rewriter to keep the right topic/recommendation and not drift.
      split: splitCompleteBlocks,
      signal,
      log: this.log,
    }, { sayBefore: 0 });
  }
}
