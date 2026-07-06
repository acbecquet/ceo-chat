// turns.ts - ONE turn engine shared by every transport (web WS + Twilio phone + SMS).
//
// Before Call Mode the busy lock, turn counter and last-turn replay state lived
// inside app.ts, so only the web transport could run turns. A phone call is a
// second front-end onto the SAME single agent session, so those concerns move
// here: the runner serializes turns across ALL transports (one broker, one turn
// at a time), emits every turn event to every subscriber (a phone-initiated turn
// streams to the web transcript and vice versa), and keeps a bounded history so
// a reconnecting client resumes with the conversation instead of a blank page.
//
// It also owns the live VERBATIM tap: alongside the driver's spoken pipeline it
// streams the exact assistant text of the in-flight reply (src/server/verbatim.ts)
// so the web UI shows the 1:1 transcript growing in real time, ending in a
// byte-exact `final` frame. Everything below Driver.send is untouched.

import type { Driver } from './driver.ts';
import type { PipelineStage } from '../broker/pipeline.ts';
import type { TurnSource, UiStatus } from './protocol.ts';
import type { VerbatimTap, VerbatimTurnHandle } from './verbatim.ts';

export type TurnEvent =
  | { type: 'status'; state: UiStatus }
  | { type: 'sent'; turn: number; text: string; source: TurnSource; ts: number }
  | { type: 'verbatim'; turn: number; text: string; final?: boolean; ts?: number }
  | { type: 'narration'; turn: number; text: string; backend: string; index?: number }
  | { type: 'audio'; turn: number; pcm: Buffer; sampleRate: number; index?: number }
  | { type: 'reply'; turn: number; text: string }
  | { type: 'notice'; message: string }
  | { type: 'turn-done'; turn: number; ttfbMs: number | null; bytes: number }
  | { type: 'error'; message: string };

export interface TurnRecord {
  turn: number;
  source: TurnSource;
  sentText: string;
  ts: number;
  reply: string;
  /** The byte-exact verbatim reply text (falls back to `reply` when no tap ran). */
  verbatim: string;
  narration: string;
  backend: string;
  /** Whole-turn audio, kept ONLY for the most recent turn (replay/Replay button). */
  pcm: Buffer;
  sampleRate: number;
  ttfbMs: number | null;
  bytes: number;
  doneTs: number;
}

export interface TurnRunnerOptions {
  driver: Driver;
  /** Optional live verbatim source (the transcript tap). Absent -> final-only. */
  verbatim?: VerbatimTap;
  /** How many finished turns to keep for reconnect replay. */
  historyMax?: number;
  now?: () => number;
  /** Injectable sleep (steer waits for the aborted turn to unwind). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

// Merge a follow-up utterance into the in-flight prompt for attach-and-reinterpret
// (Feature 3, captain decision D3: keep the original verbatim, mark the correction as the
// authoritative fix of a possible speech-to-text misread). ONE line - the broker submits
// via fm-send, where an embedded newline would split the message. Pure.
export function buildSteerPrompt(original: string, correction: string): string {
  const o = (original || '').replace(/\s+/g, ' ').trim();
  const c = (correction || '').replace(/\s+/g, ' ').trim();
  if (!o) return c;
  if (!c) return o;
  return `${o}  [Correction from the captain, spoken just now - treat this as the ` +
    `authoritative fix of a possible speech-to-text misread in the message above: ${c}]`;
}

// Stage -> status mapping (moved verbatim from app.ts). synth = audio is being
// produced (speaking); inject/read/rewrite read to the captain as "thinking".
export function statusForStage(stage: PipelineStage): UiStatus | null {
  switch (stage) {
    case 'inject':
    case 'reply':
    case 'speak':
      return 'thinking';
    case 'synth':
      return 'speaking';
    case 'done':
      return null; // resolved after the turn (idle vs awaiting-confirmation)
  }
}

export class TurnRunner {
  private readonly driver: Driver;
  private readonly verbatimTap: VerbatimTap | null;
  private readonly historyMax: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<(ev: TurnEvent) => void>();
  private turnCounter = 0;
  private currentSignal: { aborted: boolean } | null = null;
  private _currentPrompt = '';
  private _currentSource: TurnSource | null = null;
  // Serialize steers so two rapid corrections can't both cancel+interrupt+re-run at once.
  private steerChain: Promise<{ ok: boolean; turn: number }> = Promise.resolve({ ok: false, turn: 0 });

  busy = false;
  history: TurnRecord[] = [];

  constructor(opts: TurnRunnerOptions) {
    this.driver = opts.driver;
    this.verbatimTap = opts.verbatim ?? null;
    this.historyMax = opts.historyMax ?? 50;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  /** The prompt of the in-flight turn (for attach-and-reinterpret). '' when idle. */
  get currentPrompt(): string { return this._currentPrompt; }
  /** The transport that started the in-flight turn. null when idle. */
  get currentSource(): TurnSource | null { return this._currentSource; }

  on(fn: (ev: TurnEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: TurnEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* one bad subscriber never breaks the turn */ }
    }
  }

  get lastTurn(): TurnRecord | null {
    return this.history.length ? this.history[this.history.length - 1]! : null;
  }

  get lastNarration(): string {
    return this.lastTurn?.narration ?? '';
  }

  /** Did the last turn end waiting on the captain (narration asked a question)? */
  get awaitingConfirmation(): boolean {
    return /\?/.test(this.lastNarration);
  }

  /** The status a freshly-connected client should see right now. */
  idleStatus(): UiStatus {
    if (this.busy) return 'thinking';
    return this.awaitingConfirmation ? 'awaiting-confirmation' : 'idle';
  }

  /** Explicit barge-in / hangup: abort the in-flight turn (if any). */
  cancel(reason: string): boolean {
    if (this.currentSignal && !this.currentSignal.aborted) {
      this.currentSignal.aborted = true;
      this.log('turn cancelled: ' + reason);
      this.emit({ type: 'status', state: 'idle' });
      return true;
    }
    return false;
  }

  /**
   * Drive one full turn. Serialized: a concurrent call emits an `error` event and
   * returns { ok: false } - one agent session, one turn at a time, any transport.
   */
  async run(text: string, source: TurnSource): Promise<{ ok: boolean; turn: number }> {
    const trimmed = (text || '').trim();
    if (!trimmed) return { ok: false, turn: 0 };
    if (this.busy) {
      this.emit({ type: 'error', message: 'a turn is already in progress - one at a time' });
      return { ok: false, turn: 0 };
    }
    this.busy = true;
    this._currentPrompt = trimmed;
    this._currentSource = source;
    const myTurn = ++this.turnCounter;
    const signal = { aborted: false };
    this.currentSignal = signal;
    const sentTs = this.now();
    this.emit({ type: 'sent', turn: myTurn, text: trimmed, source, ts: sentTs });

    // The live verbatim tap streams the exact assistant text as the reply grows.
    // afterTs is captured just before injection so the tap anchors to THIS turn's
    // prompt in the session transcript, never an identical earlier line.
    let vb: VerbatimTurnHandle | null = null;
    if (this.verbatimTap) {
      try {
        vb = this.verbatimTap({
          prompt: trimmed,
          afterTs: new Date(sentTs).toISOString(),
          onText: (t) => { if (!signal.aborted) this.emit({ type: 'verbatim', turn: myTurn, text: t }); },
        });
      } catch (e) {
        this.log('verbatim tap failed to start: ' + (e as Error).message);
      }
    }

    let chunks = 0;
    try {
      const result = await this.driver.send(trimmed, myTurn, {
        onStage: (stage) => {
          const st = statusForStage(stage);
          if (st) this.emit({ type: 'status', state: st });
        },
        // Progressive: one narration+audio event per speakable unit as the agent
        // talks, so the first sentence is heard ~1s in. Aborted turns emit nothing.
        onChunk: (c) => {
          if (signal.aborted) return;
          chunks++;
          this.emit({ type: 'narration', turn: myTurn, text: c.narration, backend: c.speakBackend, index: c.index });
          this.emit({ type: 'audio', turn: myTurn, pcm: c.pcm, sampleRate: c.sampleRate, index: c.index });
        },
        onNotice: (message) => this.emit({ type: 'notice', message }),
        signal,
      });
      const tapped = vb ? vb.stop() : '';
      vb = null;
      if (signal.aborted) {
        this.emit({ type: 'status', state: 'idle' });
        return { ok: false, turn: myTurn };
      }
      // The full raw reply lands at the end, then the authoritative byte-exact
      // verbatim text: the tap's final read when it anchored, else the reply.
      this.emit({ type: 'reply', turn: myTurn, text: result.reply });
      const verbatim = tapped || result.reply;
      const doneTs = this.now();
      this.emit({ type: 'verbatim', turn: myTurn, text: verbatim, final: true, ts: doneTs });
      // Legacy/in-memory drivers don't stream chunks - fall back to the aggregate
      // narration + audio so the page still speaks (and tests stay valid).
      if ((result.chunks ?? chunks) === 0) {
        this.emit({ type: 'narration', turn: myTurn, text: result.narration, backend: result.speakBackend });
        this.emit({ type: 'audio', turn: myTurn, pcm: result.audio.pcm, sampleRate: result.audio.sampleRate });
      }
      // Record the turn BEFORE announcing turn-done: subscribers react to turn-done
      // by reading runner state (awaitingConfirmation / lastNarration must be THIS
      // turn's - the phone leg arms its answer timer off exactly that).
      this.history.push({
        turn: myTurn, source, sentText: trimmed, ts: sentTs,
        reply: result.reply, verbatim, narration: result.narration, backend: result.speakBackend,
        pcm: result.audio.pcm, sampleRate: result.audio.sampleRate,
        ttfbMs: result.audio.ttfbMs, bytes: result.audio.bytes, doneTs,
      });
      // Bound the history; audio is kept ONLY on the newest record (replay covers
      // the last turn - older turns replay text-only, so memory stays flat).
      while (this.history.length > this.historyMax) this.history.shift();
      for (let i = 0; i < this.history.length - 1; i++) {
        if (this.history[i]!.pcm.length) this.history[i]!.pcm = Buffer.alloc(0);
      }

      this.emit({ type: 'turn-done', turn: myTurn, ttfbMs: result.audio.ttfbMs, bytes: result.audio.bytes });
      this.emit({ type: 'status', state: /\?/.test(result.narration) ? 'awaiting-confirmation' : 'idle' });
      return { ok: true, turn: myTurn };
    } catch (e) {
      this.emit({ type: 'error', message: (e as Error).message });
      this.emit({ type: 'status', state: 'idle' });
      return { ok: false, turn: myTurn };
    } finally {
      if (vb) { try { vb.stop(); } catch { /* already logged */ } }
      this.busy = false;
      this.currentSignal = null;
      this._currentPrompt = '';
      this._currentSource = null;
    }
  }

  /**
   * Attach-and-reinterpret (Feature 3): a NEW utterance/line while a turn is in flight is
   * merged into the in-flight prompt, and the agent turn is interrupted and re-run against
   * the combined prompt - so a spoken correction of an STT misread steers the reply
   * instead of being blocked. Not busy (and no explicit `original`): it's a plain new turn.
   *
   * Serialized (steerChain) so two rapid corrections don't both cancel+interrupt at once.
   * `original` pins the prompt to attach to even if the in-flight turn has already settled
   * (the phone barge-in path captures it before the caller finishes the correction).
   */
  steer(text: string, source: TurnSource, opts: { original?: string } = {}): Promise<{ ok: boolean; turn: number }> {
    this.steerChain = this.steerChain
      .catch(() => ({ ok: false, turn: 0 }))
      .then(() => this._steer(text, source, opts));
    return this.steerChain;
  }

  private async _steer(
    text: string,
    source: TurnSource,
    opts: { original?: string },
  ): Promise<{ ok: boolean; turn: number }> {
    const extra = (text || '').trim();
    if (!extra) return { ok: false, turn: 0 };
    const original = opts.original ?? this._currentPrompt;
    // Nothing in flight and no pinned prompt to attach to -> just a fresh turn.
    if (!this.busy && !opts.original) return this.run(extra, source);
    // 1. Stop speaking the in-flight reply (pipeline abort).
    this.cancel('steer: attaching a correction and reinterpreting');
    // 2. Interrupt the underlying agent so it re-plans against the combined prompt. Best
    //    effort (D5): if it will not interrupt, the combined prompt still injects and the
    //    agent runs it right after the current turn - the correction is never lost.
    try {
      await this.driver.interrupt?.();
    } catch (e) {
      this.log('steer: agent interrupt failed (' + (e as Error).message + ') - queueing instead');
    }
    // 3. Wait for the aborted turn to unwind (busy clears).
    await this.waitUntilFree(8000);
    // 4. Run the combined prompt as a fresh turn (fresh transcript anchor, fresh audio).
    const combined = original ? buildSteerPrompt(original, extra) : extra;
    return this.run(combined, source);
  }

  /**
   * Run a new turn, or - if a turn from the SAME transport is in flight - attach the text
   * and reinterpret. A DIFFERENT transport being busy falls through to run(), which
   * rejects with the "one at a time" error rather than interrupting the other channel (an
   * inbound SMS must never cut off a live phone-call turn). The phone leg drives steer()
   * directly for its own barge-in/coalesce path.
   */
  submitOrSteer(text: string, source: TurnSource): Promise<{ ok: boolean; turn: number }> {
    if (this.busy && this._currentSource === source) return this.steer(text, source);
    return this.run(text, source);
  }

  private async waitUntilFree(timeoutMs: number): Promise<boolean> {
    const start = this.now();
    while (this.busy && this.now() - start < timeoutMs) await this.sleep(50);
    return !this.busy;
  }
}
