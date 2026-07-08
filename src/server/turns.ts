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

// How long steer keeps holding a correction for the aborted turn to unwind before
// giving up loudly. Generous - an aborted pipeline can drain a long TTS synth - and
// matches the SMS runWhenFree wait cap.
const STEER_UNWIND_TIMEOUT_MS = 180 * 1000;

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

export interface TurnResult {
  ok: boolean;
  turn: number;
  /** True when a same-source follow-up steered this turn: it was deliberately aborted
   *  and its prompt re-ran merged with the correction - NOT a genuine failure, so
   *  transports must never report it as one. */
  superseded?: boolean;
}

// The active attach-and-reinterpret chain for one transport: the TRUE base utterance and
// the ordered corrections merged into it. `combined` is the single-frame prompt the re-run
// injects (base + one frame, corrections joined "; "). `superseded` marks a chain a newer
// correction re-merged - its pending/in-flight re-run must not fire.
interface SteerChain {
  base: string;
  corrections: string[];
  combined: string;
  superseded: boolean;
}

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

// The frame-lead markers a combined prompt appends after the base (exactly one, whatever
// the source). stripSteerFrames cuts from the first marker to the end to recover the TRUE
// base, so a prompt that is already combined is never re-wrapped as if it were a fresh
// base utterance - the correction-merge duplication the captain hit on a rapid
// four-utterance call (base re-embedded, each correction re-framed inside the next).
const STEER_FRAME_LEAD_RE =
  /\s*\[(?:Correction from the captain, spoken just now|Additional instruction from the captain, sent just now)\b[\s\S]*$/;

/** Recover the true base utterance from a prompt that may already carry steer frame(s). */
export function stripSteerFrames(prompt: string): string {
  return (prompt || '').replace(STEER_FRAME_LEAD_RE, '').replace(/\s+/g, ' ').trim();
}

// Merge a follow-up utterance - or the whole ordered LIST of them across a steer chain -
// into the in-flight prompt for attach-and-reinterpret (Feature 3, captain decision D3:
// keep the original verbatim). The composition is ALWAYS the true base + exactly ONE frame
// carrying the corrections in spoken order (joined "; "); the base is stripped of any
// existing frame first, so it NEVER re-wraps an already-combined prompt. However many rapid
// corrections arrive and however they interleave with steered re-runs, the base appears
// once and each correction once inside a single frame. ONE line - the broker submits via
// fm-send, where an embedded newline would split the message. Source-aware: only a SPOKEN
// (phone/STT) follow-up is framed as the authoritative fix of a possible speech-to-text
// misread; a typed web/SMS follow-up has no STT to misread, so it is framed as an ADDITION
// that must not invite rewriting the original. Pure.
export function buildSteerPrompt(
  original: string,
  correction: string | string[],
  source: TurnSource,
): string {
  const o = stripSteerFrames(original);
  const c = (Array.isArray(correction) ? correction : [correction])
    .map((x) => (x || '').replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 0)
    .join('; ');
  if (!o) return c;
  if (!c) return o;
  if (source === 'phone') {
    return `${o}  [Correction from the captain, spoken just now - treat this as the ` +
      `authoritative fix of a possible speech-to-text misread in the message above: ${c}]`;
  }
  return `${o}  [Additional instruction from the captain, sent just now - treat this as ` +
    `an addition to the message above, not a replacement of any part of it: ${c}]`;
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
  private currentSignal: { aborted: boolean; superseded?: boolean } | null = null;
  private _currentPrompt = '';
  private _currentSource: TurnSource | null = null;
  // Serialize steers so two rapid corrections can't both interrupt+re-run at once.
  private steerChain: Promise<TurnResult> = Promise.resolve({ ok: false, turn: 0 });
  // The active steer chain per source: the TRUE base utterance + the ordered list of
  // corrections merged into it. It lives for the WHOLE lifetime of the chain - it is NOT
  // dropped when a re-run starts. So a correction arriving mid-re-run, or while the aborted
  // turn is still unwinding, extends the SAME base + list (marking the stale entry
  // superseded so its re-run never fires, D4) instead of re-deriving the base from the
  // already-combined in-flight prompt - which stacked another frame each time (the
  // duplication the captain hit). Removed only when its final turn settles un-superseded,
  // so submitOrSteer then routes a fresh utterance to run() rather than a stale attach.
  private activeSteers = new Map<TurnSource, SteerChain>();

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

  /** Raw abort of the in-flight turn (if any). Transport barge-in/hangup/stop routes
   *  through the ownership-gated cancelIfSource below; the steer path calls this
   *  directly after marking the signal superseded. */
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
   * Ownership-gated cancel: abort the in-flight turn ONLY when `source` started it.
   * A transport must never cancel a turn it does not own - aborting a foreign turn
   * with `superseded` unset reads as a spurious failure on that transport (an SMS
   * "turn failed" text, a dead web turn, a cut-off phone reply). Every transport-side
   * barge-in/hangup/stop cancel routes through here; only the runner's own steer path
   * uses the raw cancel() (a steer marks the signal superseded first).
   */
  cancelIfSource(source: TurnSource, reason: string): boolean {
    if (!this.busy || this._currentSource !== source) return false;
    return this.cancel(reason);
  }

  /**
   * Drive one full turn. Serialized: a concurrent call emits an `error` event and
   * returns { ok: false } - one agent session, one turn at a time, any transport.
   */
  async run(text: string, source: TurnSource): Promise<TurnResult> {
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
    const signal: { aborted: boolean; superseded?: boolean } = { aborted: false };
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
        return { ok: false, turn: myTurn, superseded: signal.superseded === true };
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
      return { ok: false, turn: myTurn, superseded: signal.superseded === true };
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
   * The combined prompt is built and the in-flight turn aborted HERE, at request time -
   * so a correction arriving DURING a steered re-run breaks that run's await immediately
   * and merges (D4: always attach while in flight), instead of queueing behind the whole
   * combined turn and then running bare. A correction arriving while the aborted turn is
   * still UNWINDING (the re-run not yet started) merges onto the pending combined prompt
   * and supersedes that stale re-run, so no earlier correction is ever lost from the
   * final prompt. Aborted/superseded turns resolve `superseded`, never a failure.
   * Serialized (steerChain) so two rapid corrections don't both interrupt+re-run at
   * once; the returned promise resolves when the FINAL combined run() completes.
   * `original` pins the prompt to attach to even if the in-flight turn has already settled
   * (the phone barge-in path captures it before the caller finishes the correction).
   */
  steer(text: string, source: TurnSource, opts: { original?: string } = {}): Promise<TurnResult> {
    const extra = (text || '').trim();
    if (!extra) return Promise.resolve({ ok: false, turn: 0 });
    // SAME-SOURCE only: a turn started by a DIFFERENT transport is never cancelled or
    // interrupted from here - the combined prompt just queues behind it (_steer's wait).
    const foreign = this.busy && this._currentSource !== source;
    // Extend the active chain if one exists (its re-run may be in flight OR still pending
    // in the unwind window): reuse its TRUE base and append this correction in spoken
    // order. Only when there is NO active chain is the base taken from the barge-in pin or
    // the in-flight prompt - and stripSteerFrames (inside buildSteerPrompt too) guarantees
    // even that is the bare base, never a combined prompt re-wrapped. So the composition is
    // always base + ONE frame with every correction, once, in order.
    const prior = this.activeSteers.get(source) ?? null;
    const base = prior ? prior.base : stripSteerFrames(opts.original ?? this._currentPrompt);
    const corrections = prior ? [...prior.corrections, extra] : [extra];
    const entry: SteerChain = {
      base, corrections, superseded: false,
      combined: buildSteerPrompt(base, corrections, source),
    };
    // The new correction re-merges everything the prior chain carried, so its
    // pending/in-flight re-run must never fire - it would re-answer an outdated prompt.
    if (prior) prior.superseded = true;
    this.activeSteers.set(source, entry);
    if (this.busy && !foreign && this.currentSignal && !this.currentSignal.aborted) {
      // Stop speaking the in-flight reply NOW (pipeline abort), marked as deliberately
      // superseded so its transport never mistakes the abort for a failure.
      this.currentSignal.superseded = true;
      this.cancel('steer: attaching a correction and reinterpreting');
    }
    this.steerChain = this.steerChain
      .catch(() => ({ ok: false, turn: 0 }))
      .then(() => this._steer(entry, source, { interrupt: !foreign && base !== '' }));
    return this.steerChain;
  }

  private async _steer(
    entry: SteerChain,
    source: TurnSource,
    opts: { interrupt: boolean },
  ): Promise<TurnResult> {
    // A newer same-source correction re-merged this one into its own combined prompt -
    // running it now would inject a stale prompt missing that correction.
    if (entry.superseded) return { ok: false, turn: 0, superseded: true };
    if (opts.interrupt) {
      // Interrupt the underlying agent so it re-plans against the combined prompt. Best
      // effort (D5): if it will not interrupt, the combined prompt still injects and the
      // agent runs it right after the current turn - the correction is never lost.
      try {
        await this.driver.interrupt?.();
      } catch (e) {
        this.log('steer: agent interrupt failed (' + (e as Error).message + ') - queueing instead');
      }
    }
    // Wait for the aborted turn to unwind (busy clears), then run the combined prompt
    // as a fresh turn (fresh transcript anchor, fresh audio). The interrupt is
    // best-effort and a draining pipeline can hold the lock well past a few seconds -
    // HOLD the correction and keep retrying until the lock frees (bounded), never
    // force run() into a silent busy rejection (D5: a correction is never lost).
    const deadline = this.now() + STEER_UNWIND_TIMEOUT_MS;
    while (this.now() < deadline) {
      if (entry.superseded) return { ok: false, turn: 0, superseded: true };
      if (!(await this.waitUntilFree(Math.min(8000, deadline - this.now())))) {
        this.log('steer: prior turn still unwinding - holding the correction');
        continue;
      }
      if (entry.superseded) return { ok: false, turn: 0, superseded: true };
      // Keep this chain in the map DURING its re-run: a correction landing mid-re-run
      // finds it (prior) and extends the SAME base + list, never re-deriving the base from
      // the combined in-flight prompt. It is removed only once the re-run settles below.
      const r = await this.run(entry.combined, source);
      if (r.turn !== 0) {
        // The re-run actually ran. Drop the chain iff it is still the active one and was
        // not superseded mid-flight (a newer correction already replaced it in the map and
        // owns the follow-on re-run). A lost-lock race returns turn 0 -> retry.
        if (!entry.superseded && this.activeSteers.get(source) === entry) {
          this.activeSteers.delete(source);
        }
        return r; // it actually ran - done (lost lock races retry)
      }
    }
    this.log('steer: the prior turn never unwound - the correction could not run');
    if (this.activeSteers.get(source) === entry) this.activeSteers.delete(source);
    this.emit({ type: 'error', message: 'could not apply the follow-up - the previous turn never finished unwinding' });
    return { ok: false, turn: 0 };
  }

  /**
   * Run a new turn, or - if a turn from the SAME transport is in flight OR a same-source
   * steered re-run is still pending (the aborted turn unwinding) - attach the text and
   * reinterpret. A DIFFERENT transport being busy falls through to run(), which
   * rejects with the "one at a time" error rather than interrupting the other channel (an
   * inbound SMS must never cut off a live phone-call turn). The phone leg drives steer()
   * directly for its own barge-in/coalesce path.
   */
  submitOrSteer(text: string, source: TurnSource): Promise<TurnResult> {
    if ((this.busy && this._currentSource === source) || this.activeSteers.has(source)) {
      return this.steer(text, source);
    }
    return this.run(text, source);
  }

  private async waitUntilFree(timeoutMs: number): Promise<boolean> {
    const start = this.now();
    while (this.busy && this.now() - start < timeoutMs) await this.sleep(50);
    return !this.busy;
  }
}
