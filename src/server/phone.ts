// phone.ts - Call Mode: first mate as a REAL Twilio phone call (plan §1).
//
// This is the ONLY new transport component; it mirrors src/server/app.ts and
// reuses the entire pipeline below the Driver seam UNCHANGED:
//
//   Twilio Voice webhook  -> POST /phone/twiml  (returns <Connect><Stream>)
//   bidirectional Media Streams WS at /phone    (8 kHz mu-law base64 both ways)
//     inbound : mu-law -> PCM -> whisper transcribe -> TurnRunner.run(text)
//     outbound: runner audio events (s16le@22k/32k) -> 8 kHz mu-law -> media+mark
//     barge-in: sustained captain speech during playback -> `clear` + runner.cancel
//     hangup  : `stop` frame / WS close -> runner.cancel (signal.aborted)
//
// SECURITY (mandatory - the broker fronts a shell-capable agent), layered:
//   1. Caller-ID allowlist at the webhook: From/To must match CEOCHAT_ALLOWED_CALLER
//      or the call gets <Reject/> and no stream ever opens.
//   2. X-Twilio-Signature validation on the webhook (when the auth token is
//      configured), so a forged POST can't mint a stream token.
//   3. A SINGLE-USE, short-TTL stream token minted by the webhook and carried into
//      the WS `start` frame as a <Parameter> - a direct WS connection to the
//      tunnel-exposed /phone path without a fresh token is closed immediately.
//      The single call slot is claimed only by a token-authorized `start`:
//      anonymous/pre-start sockets never occupy the line (they are bounded by the
//      handshake deadline and a pre-start socket cap).
//   4. A keypad-only (DTMF) PIN (CEOCHAT_PHONE_PIN) BEFORE the first injection - on
//      EVERY call, inbound or outbound. Three failures end the call. Speech before
//      the PIN passes is ignored entirely (never transcribed, never an attempt).
//   5. guardUtterance (§3.5) on the voice leg: a consequential confirmation needs a
//      CLEAR spoken confirm/cancel; anything ambiguous is re-asked, never sent.
//   6. Turns stay serialized (the shared TurnRunner busy lock).
//
// INTERACTIVE-PROMPT FALLBACK (captain-approved safe default): when first mate is
// waiting on a consequential answer and the captain's reply is unclear or absent,
// RE-ASK once; still unclear / silent -> TIME OUT to a safe default that takes NO
// consequential action (never auto-approve on silence). Tunable via PromptPolicy.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import type { PhoneSecrets } from '../config/secrets.ts';
import { phoneCapabilities } from '../config/secrets.ts';
import type { PhoneState } from './protocol.ts';
import { TurnRunner } from './turns.ts';
import {
  twimlConnectStream, twimlReject, parseFormBody, validateTwilioSignature, sameNumber, placeCall,
} from './twilio.ts';
import {
  pcmChunkToPhoneMulaw, mulawToPcmS16le, phonePcmToWhisperPcm,
  UtteranceDetector, type VadConfig,
} from './phone-audio.ts';
import { guardUtterance, looksConsequential } from '../web/confirm.js';
import type { ActivityTap, ActivityTurnHandle } from './activity.ts';

export const PHONE_WS_PATH = '/phone';
export const PHONE_TWIML_PATH = '/phone/twiml';

// One outbound media message carries at most this many mu-law bytes (500ms @ 8k).
// Twilio buffers and plays sequentially; smaller messages keep barge-in `clear`
// responsive (only the unplayed buffer is flushed).
const MEDIA_MESSAGE_BYTES = 4000;
const PIN_MAX_ATTEMPTS = 3;
const TOKEN_TTL_MS = 5 * 60 * 1000;
// A connection must present a valid webhook-minted token in its `start` frame
// within this window, or it is closed. Pre-start sockets never hold the call slot
// (only an authorized `start` claims it); the deadline plus the cap below keep
// anonymous hits on the tunnel-exposed /phone path from piling up.
const HANDSHAKE_TIMEOUT_MS = 10 * 1000;
export const MAX_PENDING_SOCKETS = 8;
// How long a barge-in keeps the in-flight prompt pinned while waiting for the captain's
// correction to finish; dropped after this so a barge with no follow-up never strands it.
const STEER_PIN_TTL_MS = 8 * 1000;
// Retry budget for an utterance queued behind a FOREIGN-source (web/SMS-initiated) turn
// we must never steer: 720 x 250ms = 180s, matching the SMS runWhenFree wait cap, so a
// spoken line survives even a long-running foreign turn (D5: never lost).
const FOREIGN_BUSY_TRIES = 720;

/** Drop expired stream tokens so unconsumed mints never accumulate. Pure. */
export function pruneExpiredTokens(tokens: Map<string, number>, now: number): void {
  for (const [token, expiry] of tokens) {
    if (now > expiry) tokens.delete(token);
  }
}

// ── captain-tunable behavior (the "small config" the task asks for) ───────────

export interface PromptPolicy {
  /** How many times to re-ask an unclear/absent answer before the safe default. */
  reAsks: number;
  /** Silence window (ms) on a pending consequential prompt before re-ask/give-up. */
  answerTimeoutMs: number;
  /**
   * The safe default when still unresolved: 'no-action' leaves the prompt waiting
   * on screen and injects NOTHING; 'send-cancel' explicitly answers "cancel".
   * Neither ever approves - silence can never merge/deploy/delete.
   */
  onUnresolved: 'no-action' | 'send-cancel';
  reAskText: string;
  giveUpTextNoAction: string;
  giveUpTextCancel: string;
}

export const DEFAULT_PROMPT_POLICY: PromptPolicy = {
  reAsks: 1,
  answerTimeoutMs: 30000,
  onUnresolved: 'no-action',
  reAskText: 'I need a clear answer for this one. Say "confirm" to go ahead, or "cancel" to stop.',
  giveUpTextNoAction:
    'No clear answer, so I am not taking that action. It stays waiting on your screen.',
  giveUpTextCancel: 'No clear answer, so I am cancelling that action to be safe.',
};

export interface PhonePhrases {
  pinPrompt: string;
  pinRetry: string;
  pinLocked: string;
  greeting: string;
  sttUnavailable: string;
}

// ── thinking-filler (F1) ─────────────────────────────────────────────────────
// On a real phone call, dead air after the captain finishes speaking reads as
// "are you still there?". If the reply is slow to produce its first spoken audio,
// we say ONE short, natural "give me a sec" line so the line never goes silent
// waiting. Captain decision D1: EXACTLY ONE filler per turn (never a repeating
// cadence), fired only if no real reply audio has played within `thresholdMs`.
export interface FillerConfig {
  /** Silence after a turn starts before the single filler is spoken. */
  thresholdMs: number;
  /** Varied phrasings, rotated so the filler never sounds canned. */
  phrases: string[];
}

export const DEFAULT_FILLER: FillerConfig = {
  thresholdMs: 3000,
  phrases: [
    'Give me a second to think about this.',
    'Let me look into that.',
    'One moment while I work through it.',
    'Hang on, let me pull that up.',
    'Okay, let me dig into this.',
    'Give me a moment on that.',
    'Let me check on that for you.',
  ],
};

export const DEFAULT_PHRASES: PhonePhrases = {
  pinPrompt: 'First mate here. Enter your PIN on the keypad to continue.',
  pinRetry: 'That PIN did not match. Try again.',
  pinLocked: 'Too many failed attempts. Goodbye.',
  greeting: 'You are connected. Go ahead, captain.',
  sttUnavailable:
    'I cannot transcribe speech on this call right now. Use the app to type instead.',
};

// ── the transport ──────────────────────────────────────────────────────────────

export interface PhoneTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface PhoneAppOptions {
  runner: TurnRunner;
  /** whisper STT (absent -> spoken commands unavailable; the PIN is keypad-only). */
  transcribe?: (pcm: Buffer, sampleRate: number) => Promise<string>;
  /** TTS for canned phrases (PIN prompt / greeting / re-asks). Absent -> silent. */
  synthPrompt?: (text: string) => Promise<{ pcm: Buffer; sampleRate: number }>;
  secrets: PhoneSecrets;
  /** Public origin the tunnel serves (e.g. https://ceo-chat.acb-apps.com). */
  publicUrl: string;
  promptPolicy?: Partial<PromptPolicy>;
  phrases?: Partial<PhonePhrases>;
  filler?: Partial<FillerConfig>;
  /** Real-only mid-turn progress source (the tool-activity tap). Optional. */
  activity?: ActivityTap;
  /** Minimum gap between spoken progress lines (throttle). Default 20000ms. */
  progressMinGapMs?: number;
  /** Window to coalesce a burst of follow-up utterances into ONE reinterpret. Default 700ms. */
  steerCoalesceMs?: number;
  vad?: Partial<VadConfig>;
  fetchImpl?: typeof fetch;
  timers?: PhoneTimers;
  /** Default: validate X-Twilio-Signature whenever the auth token is configured. */
  validateSignature?: boolean;
  tokenTtlMs?: number;
  /** How long a fresh WS may sit without an authorized `start` before it is closed. */
  handshakeTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface PhoneApp {
  readonly capabilities: { inbound: boolean; outbound: boolean };
  /** Handle /phone/* HTTP (the TwiML webhook). Returns false when not a phone path. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
  /** Handle a /phone WS upgrade. Returns false when the path is not ours. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Outbound "Call me": ring the captain via Twilio REST. */
  callMe(): Promise<{ ok: boolean; detail: string }>;
  onState(fn: (state: PhoneState, detail?: string) => void): () => void;
  readonly activeCall: boolean;
  close(): void;
}

// Twilio Media Streams inbound frames (only the fields we read).
interface TwilioFrame {
  event?: string;
  streamSid?: string;
  start?: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> };
  media?: { payload?: string; track?: string };
  dtmf?: { digit?: string };
  mark?: { name?: string };
}

export function createPhoneApp(opts: PhoneAppOptions): PhoneApp {
  const runner = opts.runner;
  const log = opts.log ?? (() => {});
  const secrets = opts.secrets;
  const capabilities = phoneCapabilities(secrets);
  const policy: PromptPolicy = { ...DEFAULT_PROMPT_POLICY, ...(opts.promptPolicy ?? {}) };
  const phrases: PhonePhrases = { ...DEFAULT_PHRASES, ...(opts.phrases ?? {}) };
  const filler: FillerConfig = { ...DEFAULT_FILLER, ...(opts.filler ?? {}) };
  const progressMinGapMs = opts.progressMinGapMs ?? 20000;
  const steerCoalesceMs = opts.steerCoalesceMs ?? 700;
  // Cache synthesized PCM for the FINITE static phrases (filler pool, PIN/greeting) so a
  // recurring line is synthesized once per server lifetime, not once per call - the
  // "pre-synthesize the filler pool" cost win. Dynamic progress lines are NOT cached.
  const phraseCache = new Map<string, { pcm: Buffer; sampleRate: number }>();
  const timers: PhoneTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  };
  const publicUrl = opts.publicUrl.replace(/\/+$/, '');
  const wsUrl = publicUrl.replace(/^http/, 'ws') + PHONE_WS_PATH;
  const twimlUrl = publicUrl + PHONE_TWIML_PATH;
  const validateSig = opts.validateSignature ?? !!secrets.authToken;
  const tokenTtlMs = opts.tokenTtlMs ?? TOKEN_TTL_MS;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;

  const stateListeners = new Set<(state: PhoneState, detail?: string) => void>();
  const emitState = (state: PhoneState, detail?: string): void => {
    log(`phone: ${state}${detail ? ' - ' + detail : ''}`);
    for (const fn of stateListeners) { try { fn(state, detail); } catch { /* ignore */ } }
  };

  // Single-use stream tokens minted by the webhook, consumed by the WS start frame.
  const tokens = new Map<string, number>();
  const mintToken = (): string => {
    pruneExpiredTokens(tokens, Date.now());
    const token = randomBytes(16).toString('hex');
    tokens.set(token, Date.now() + tokenTtlMs);
    return token;
  };
  const consumeToken = (token: string | undefined): boolean => {
    if (!token) return false;
    const expiry = tokens.get(token);
    tokens.delete(token); // single-use, valid or not
    return typeof expiry === 'number' && Date.now() <= expiry;
  };

  // ── one live call ────────────────────────────────────────────────────────────
  // `session` is the single ACTIVE call - claimed only when a stream presents a
  // valid webhook-minted token in its `start` frame. Sockets that have not started
  // yet wait in `pending` (bounded by MAX_PENDING_SOCKETS + the handshake deadline)
  // and can never make a legitimate call see "busy".
  let session: CallSession | null = null;
  const pending = new Set<CallSession>();

  class CallSession {
    private readonly ws: WebSocket;
    private streamSid = '';
    private started = false;
    private authed = false;
    private handshakeTimer: unknown = null;
    private pinBuffer = '';
    private pinAttempts = 0;
    private outstandingMarks = 0;
    private markSeq = 0;
    private closePending = false;
    private unsubRunner: (() => void) | null = null;
    private answerTimer: unknown = null;
    private reAskCount = 0;
    private sttWarned = false;
    private closed = false;
    // ---- per-turn spoken-status window (filler F1 + real progress F2) ----
    private currentTurn = 0;             // the in-flight turn (0 = none)
    private turnHadAudio = false;        // any real reply audio played this turn
    private fillerTimer: unknown = null; // one-shot; fires the SINGLE filler
    private fillerFired = false;         // exactly one filler per turn
    private fillerIdx = 0;               // rotate the pool across turns (never canned)
    private activityHandle: ActivityTurnHandle | null = null;
    private progressTimer: unknown = null;
    private pendingActivity = '';        // freshest un-spoken real activity line
    private audioThisWindow = false;     // real audio played since the last progress tick
    private spokenActivity = new Set<string>(); // never speak the same statement twice
    // ---- attach-and-reinterpret (F3): coalesce follow-up utterances, then steer ----
    private steerBuffer: string[] = [];
    private steerTimer: unknown = null;
    private steerPinTimer: unknown = null;
    private steerOriginal: string | null = null; // pinned at barge-in so a mid-speech
                                                  // correction still attaches to that prompt
    // Serializes prompt/chunk playback so audio order is preserved.
    private sendQueue: Promise<void> = Promise.resolve();
    private readonly detector: UtteranceDetector;

    constructor(ws: WebSocket) {
      this.ws = ws;
      this.detector = new UtteranceDetector({
        onUtterance: (pcm) => { void this.onUtterance(pcm); },
        onBargeIn: () => this.onBargeIn(),
      }, opts.vad);
      ws.on('message', (raw) => this.onFrame(raw as Buffer));
      const gone = (): void => this.teardown('socket closed');
      ws.on('close', gone);
      ws.on('error', gone);
      this.handshakeTimer = timers.setTimeout(() => {
        this.handshakeTimer = null;
        if (!this.started && !this.closed) {
          log('phone: no authorized start within the handshake window - closing');
          this.teardown('handshake timeout');
        }
      }, handshakeTimeoutMs);
    }

    // ---- inbound Twilio frames ----
    private onFrame(raw: Buffer): void {
      let msg: TwilioFrame;
      try { msg = JSON.parse(raw.toString()) as TwilioFrame; } catch { return; }
      switch (msg.event) {
        case 'connected':
          break;
        case 'start': {
          const token = msg.start?.customParameters?.token;
          if (!consumeToken(token)) {
            log('phone: stream start REFUSED - missing/expired token (direct WS hit?)');
            this.ws.close(1008, 'unauthorized');
            return;
          }
          if (session) {
            log('phone: a call is already active - refusing a second stream');
            this.ws.close(1013, 'busy');
            return;
          }
          session = this;
          pending.delete(this);
          this.streamSid = msg.start?.streamSid || msg.streamSid || '';
          this.started = true;
          if (this.handshakeTimer != null) { timers.clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
          emitState('in-call', msg.start?.callSid);
          // The PIN gate: nothing reaches the broker until it passes (see checkPin).
          this.speak(phrases.pinPrompt);
          break;
        }
        case 'media': {
          if (!this.started) return; // no audio before an authorized start
          const payload = msg.media?.payload || '';
          if (!payload) return;
          const pcm8k = mulawToPcmS16le(Buffer.from(payload, 'base64'));
          this.detector.feed(pcm8k);
          break;
        }
        case 'dtmf': {
          if (!this.started) return; // no PIN attempts before an authorized start
          const digit = (msg.dtmf?.digit || '').trim();
          if (!this.authed && this.pinAttempts < PIN_MAX_ATTEMPTS && /^[0-9]$/.test(digit)) {
            this.pinBuffer += digit;
            this.checkPinBuffer();
          }
          break;
        }
        case 'mark': {
          if (!this.started) return;
          if (this.outstandingMarks > 0) this.outstandingMarks--;
          if (this.outstandingMarks === 0) {
            this.detector.playing = false;
            if (this.closePending) this.ws.close(1000, 'bye');
          }
          break;
        }
        case 'stop':
          this.teardown('caller hung up');
          break;
      }
    }

    // ---- PIN gate ----
    private checkPinBuffer(): void {
      const pin = secrets.pin || '';
      if (!pin || this.pinBuffer.length < pin.length) return;
      this.tryPin(this.pinBuffer.slice(-pin.length));
      if (this.pinBuffer.length >= pin.length) this.pinBuffer = '';
    }

    private tryPin(candidate: string): void {
      const pin = secrets.pin || '';
      if (pin && candidate === pin) {
        this.authed = true;
        log('phone: PIN accepted - call authenticated');
        this.speak(phrases.greeting);
        // Only NOW does the call hear (and drive) the pipeline.
        this.unsubRunner = runner.on((ev) => this.onTurnEvent(ev));
        return;
      }
      this.pinFailed();
    }

    private pinFailed(): void {
      this.pinAttempts++;
      if (this.pinAttempts >= PIN_MAX_ATTEMPTS) {
        log('phone: PIN locked out after ' + this.pinAttempts + ' attempts - ending call');
        this.speak(phrases.pinLocked);
        this.closeAfterAudio();
      } else {
        this.speak(phrases.pinRetry);
      }
    }

    // ---- captain speech ----
    private async onUtterance(pcm8k: Uint8Array): Promise<void> {
      if (!this.started || this.closed) return;
      // The PIN is keypad-only: speech before it passes is ignored entirely -
      // never transcribed, never counted as an attempt, never injected.
      if (!this.authed) return;
      if (!opts.transcribe) {
        if (!this.sttWarned) { this.sttWarned = true; this.speak(phrases.sttUnavailable); }
        return;
      }
      const { pcm, sampleRate } = phonePcmToWhisperPcm(pcm8k);
      let text = '';
      try {
        text = (await opts.transcribe(Buffer.from(pcm), sampleRate)).trim();
      } catch (e) {
        log('phone: transcription failed: ' + (e as Error).message);
        return;
      }
      if (this.closed) return;
      if (!text) return;
      this.handleCommand(text);
    }

    /** An authenticated spoken line: §3.5 guard, then into the shared runner. */
    private handleCommand(text: string): void {
      this.clearAnswerTimer();
      if (runner.awaitingConfirmation && looksConsequential(runner.lastNarration)) {
        const decision = guardUtterance({
          source: 'voice', text,
          awaitingConfirmation: true, lastNarration: runner.lastNarration,
        });
        if (decision.action === 'reprompt') {
          this.reAskCount++;
          if (this.reAskCount > policy.reAsks) { this.resolveSafeDefault(); return; }
          log(`phone: unclear answer to a consequential prompt - re-asking (${this.reAskCount}/${policy.reAsks})`);
          this.speak(policy.reAskText);
          this.armAnswerTimer();
          return;
        }
      }
      this.reAskCount = 0;
      this.routeUtterance(text);
    }

    // A captain utterance: a FRESH turn when nothing is in flight (immediate, so first
    // audio stays fast), else attach-and-reinterpret - the follow-up is coalesced with any
    // others and steers the in-flight turn (Feature 3, decision D4: always attach while in
    // flight). SAME-SOURCE only: steering interrupts and rewrites the in-flight prompt, so
    // it applies ONLY to a phone-initiated turn (or a barge-in pinned prompt, which is
    // phone-sourced by construction). A foreign (web/SMS-initiated) turn is never touched -
    // the utterance takes the D5 silent-queue path and runs as its own turn right after.
    private routeUtterance(text: string): void {
      if (this.closed) return;
      const phoneOwnsTurn = runner.busy && runner.currentSource === 'phone';
      if (phoneOwnsTurn || this.steerTimer != null || this.steerOriginal != null) {
        this.steerBuffer.push(text);
        this.armSteerTimer();
      } else if (runner.busy) {
        this.submit(text, 0, FOREIGN_BUSY_TRIES);
      } else {
        this.submit(text);
      }
    }

    private armSteerTimer(): void {
      if (this.steerTimer != null) timers.clearTimeout(this.steerTimer);
      this.steerTimer = timers.setTimeout(() => this.fireSteer(), steerCoalesceMs);
    }

    // Fire ONE reinterpret for the coalesced follow-up(s): flush any buffered outbound
    // audio (so the correction is acted on now, not after the old reply drains) and steer.
    private fireSteer(): void {
      this.steerTimer = null;
      if (this.steerPinTimer != null) { timers.clearTimeout(this.steerPinTimer); this.steerPinTimer = null; }
      if (this.closed) return;
      const joined = this.steerBuffer.join(' ').replace(/\s+/g, ' ').trim();
      this.steerBuffer = [];
      const original = this.steerOriginal;
      this.steerOriginal = null;
      if (!joined) return;
      // A foreign-source turn grabbed the lock while the buffer coalesced (no pin, not a
      // phone turn): never steer it - queue the utterance to run as its own turn (D5).
      if (!original && runner.busy && runner.currentSource !== 'phone') {
        this.submit(joined, 0, FOREIGN_BUSY_TRIES);
        return;
      }
      this.send({ event: 'clear', streamSid: this.streamSid });
      this.outstandingMarks = 0;
      this.detector.playing = false;
      void runner.steer(joined, 'phone', original ? { original } : {});
    }

    /** Hand text to the runner as a fresh turn (captain utterances when nothing phone-
     *  owned is in flight, and internal injects like the safe-default 'cancel'); if the
     *  runner is busy - a cancelled turn settling, a busy-flip race, or a foreign-source
     *  turn we must never interrupt - retry until it frees (bounded by maxTries). */
    private submit(text: string, tries = 0, maxTries = 20): void {
      if (this.closed) return;
      if (runner.busy) {
        if (tries >= maxTries) { log('phone: runner stayed busy - dropping utterance'); return; }
        timers.setTimeout(() => this.submit(text, tries + 1, maxTries), 250);
        return;
      }
      void runner.run(text, 'phone');
    }

    // ---- interactive-prompt fallback (re-ask once, then the safe default) ----
    private onTurnEvent(ev: Parameters<Parameters<TurnRunner['on']>[0]>[0]): void {
      if (this.closed || !this.authed) return;
      if (ev.type === 'audio') {
        this.turnHadAudio = true;
        this.audioThisWindow = true;
        this.cancelFiller(); // real reply audio arrived -> the single filler is moot
        this.playPcm(ev.pcm, ev.sampleRate);
      } else if (ev.type === 'turn-done') {
        this.endTurnWindow();
        if (runner.awaitingConfirmation && looksConsequential(runner.lastNarration)) {
          this.armAnswerTimer();
        } else {
          this.reAskCount = 0;
        }
      } else if (ev.type === 'sent') {
        // A web-side answer resolves the pending prompt - stop the phone countdown.
        this.clearAnswerTimer();
        this.reAskCount = 0;
        // Begin the spoken-status window for this turn (single filler + real progress).
        this.beginTurnWindow(ev.turn, ev.text, ev.ts);
      } else if (ev.type === 'status' && ev.state === 'idle') {
        // An aborted turn emits no turn-done; idle closes the window either way.
        this.endTurnWindow();
      }
    }

    // ---- spoken-status window: F1 single filler + F2 real-only progress ----
    private beginTurnWindow(turn: number, prompt: string, ts: number): void {
      this.endTurnWindow(); // never overlap two windows
      this.currentTurn = turn;
      this.turnHadAudio = false;
      this.fillerFired = false;
      this.audioThisWindow = false;
      this.pendingActivity = '';
      this.spokenActivity = new Set();
      // F1: one-shot filler if no real reply audio has played by the threshold.
      this.fillerTimer = timers.setTimeout(() => {
        this.fillerTimer = null;
        if (this.closed || !this.authed) return;
        if (this.turnHadAudio || this.fillerFired) return;
        this.fillerFired = true;
        this.speak(this.pickFiller(), true);
      }, filler.thresholdMs);
      // F2: tap the tool activity for this turn (real-only progress). The tap reads the
      // session transcript anchored to THIS prompt; the throttle below decides speaking.
      if (opts.activity) {
        try {
          this.activityHandle = opts.activity({
            prompt,
            afterTs: new Date(ts).toISOString(),
            onActivity: (line) => this.onActivity(line),
          });
        } catch (e) {
          log('phone: activity tap failed to start: ' + (e as Error).message);
        }
        this.armProgressTimer();
      }
    }

    private endTurnWindow(): void {
      this.cancelFiller();
      if (this.progressTimer != null) { timers.clearTimeout(this.progressTimer); this.progressTimer = null; }
      if (this.activityHandle) { try { this.activityHandle.stop(); } catch { /* ignore */ } this.activityHandle = null; }
      this.currentTurn = 0;
      this.pendingActivity = '';
    }

    private cancelFiller(): void {
      if (this.fillerTimer != null) { timers.clearTimeout(this.fillerTimer); this.fillerTimer = null; }
    }

    private pickFiller(): string {
      const pool = filler.phrases.length ? filler.phrases : DEFAULT_FILLER.phrases;
      const line = pool[this.fillerIdx % pool.length]!;
      this.fillerIdx++; // rotate so the filler never repeats back-to-back across turns
      return line;
    }

    // A NEW real activity line from the tap: keep only the FRESHEST un-spoken one; the
    // throttle tick decides whether/when to say it. De-dup so the same statement (e.g.
    // repeated "reading a file") is never spoken twice in a turn (captain decision D2).
    private onActivity(line: string): void {
      if (this.closed || !this.authed || this.currentTurn === 0) return;
      if (this.spokenActivity.has(line)) return;
      this.pendingActivity = line;
    }

    private armProgressTimer(): void {
      this.progressTimer = timers.setTimeout(() => this.progressTick(), progressMinGapMs);
    }

    // Every progressMinGapMs: if the agent produced real reply audio in the last window it
    // is already talking, so stay silent; otherwise, if there is NEW real activity, speak
    // the freshest line. REAL ONLY - never a generic "still working" when nothing is new.
    private progressTick(): void {
      this.progressTimer = null;
      if (this.closed || !this.authed || this.currentTurn === 0) return;
      if (this.audioThisWindow) {
        this.audioThisWindow = false; // the reply is streaming - no progress needed
      } else if (this.pendingActivity && !this.spokenActivity.has(this.pendingActivity)) {
        const line = this.pendingActivity;
        this.pendingActivity = '';
        this.spokenActivity.add(line);
        this.speak(line); // dynamic real-progress line - not cached
      }
      this.armProgressTimer(); // keep checking until the window ends
    }

    private armAnswerTimer(): void {
      this.clearAnswerTimer();
      this.answerTimer = timers.setTimeout(() => {
        this.answerTimer = null;
        if (this.closed || !runner.awaitingConfirmation) return;
        this.reAskCount++;
        if (this.reAskCount > policy.reAsks) { this.resolveSafeDefault(); return; }
        log(`phone: no answer to a consequential prompt - re-asking (${this.reAskCount}/${policy.reAsks})`);
        this.speak(policy.reAskText);
        this.armAnswerTimer();
      }, policy.answerTimeoutMs);
    }

    private clearAnswerTimer(): void {
      if (this.answerTimer != null) { timers.clearTimeout(this.answerTimer); this.answerTimer = null; }
    }

    /** Unclear/absent past the re-ask budget: NEVER approve. */
    private resolveSafeDefault(): void {
      this.clearAnswerTimer();
      this.reAskCount = 0;
      if (policy.onUnresolved === 'send-cancel') {
        log('phone: prompt unresolved - safe default: sending an explicit cancel');
        this.speak(policy.giveUpTextCancel);
        this.submit('cancel');
      } else {
        log('phone: prompt unresolved - safe default: taking NO action (prompt stays on screen)');
        this.speak(policy.giveUpTextNoAction);
      }
    }

    // ---- outbound audio ----
    // Speak a canned phrase (PIN prompt / greeting / filler / progress). `cache:true`
    // memoizes the synth for the finite static phrases (the filler pool) so a recurring
    // line synthesizes once. Goes through sendQueue -> sendPcm, so it is ordered with the
    // reply audio and inherits half-duplex (playing=true) - it is never transcribed back.
    private speak(text: string, cache = false): void {
      if (!opts.synthPrompt || !text) return;
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.closed) return;
        try {
          let out = cache ? phraseCache.get(text) : undefined;
          if (!out) {
            out = await opts.synthPrompt!(text);
            if (cache) phraseCache.set(text, out);
          }
          this.sendPcm(out.pcm, out.sampleRate);
        } catch (e) {
          log('phone: prompt synth failed: ' + (e as Error).message);
        }
      });
    }

    private playPcm(pcm: Buffer, sampleRate: number): void {
      this.sendQueue = this.sendQueue.then(() => { if (!this.closed) this.sendPcm(pcm, sampleRate); });
    }

    /** Transcode one PCM chunk to the wire and ship media messages + one mark. */
    private sendPcm(pcm: Uint8Array, sampleRate: number): void {
      if (!this.streamSid || this.ws.readyState !== this.ws.OPEN) return;
      const mulaw = pcmChunkToPhoneMulaw(pcm, sampleRate);
      if (mulaw.length === 0) return;
      for (let off = 0; off < mulaw.length; off += MEDIA_MESSAGE_BYTES) {
        const slice = mulaw.subarray(off, Math.min(mulaw.length, off + MEDIA_MESSAGE_BYTES));
        this.send({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: Buffer.from(slice).toString('base64') },
        });
      }
      const name = 'm' + ++this.markSeq;
      this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
      this.outstandingMarks++;
      this.detector.playing = true; // half-duplex until Twilio echoes the mark back
    }

    /** Sustained captain speech while we're talking: flush the buffer, stop the old reply,
     *  and pin the in-flight prompt so the ensuing correction attaches + reinterprets. */
    private onBargeIn(): void {
      if (!this.authed) return;
      log('phone: barge-in - clearing buffered audio; capturing the follow-up to reinterpret');
      // Pin the in-flight prompt: the barge-in aborts the turn, so busy may clear before the
      // captain finishes the correction - the pin keeps the attach target (Feature 3).
      // Phone-sourced turns ONLY: a foreign (web/SMS) turn is never pinned or steered.
      if (runner.busy && runner.currentPrompt && runner.currentSource === 'phone') {
        this.steerOriginal = runner.currentPrompt;
        if (this.steerPinTimer != null) timers.clearTimeout(this.steerPinTimer);
        // Drop a stale pin if no correction actually follows the barge-in.
        this.steerPinTimer = timers.setTimeout(() => {
          this.steerPinTimer = null;
          if (this.steerTimer == null) this.steerOriginal = null;
        }, STEER_PIN_TTL_MS);
      }
      this.send({ event: 'clear', streamSid: this.streamSid });
      this.outstandingMarks = 0;
      this.detector.playing = false; // start collecting the captain's ongoing speech
      runner.cancel('phone barge-in'); // stop the old reply audio now
    }

    private send(obj: unknown): void {
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(obj));
    }

    private closeAfterAudio(): void {
      this.closePending = true;
      // Fallback: if Twilio never echoes the mark (or the mock client doesn't),
      // close anyway after a grace period.
      timers.setTimeout(() => { if (!this.closed) this.ws.close(1000, 'bye'); }, 8000);
    }

    /** External teardown (server shutdown). */
    end(reason: string): void {
      this.teardown(reason);
    }

    private teardown(reason: string): void {
      if (this.closed) return;
      this.closed = true;
      this.clearAnswerTimer();
      this.endTurnWindow(); // stop the filler/progress timers + the activity tap
      if (this.steerTimer != null) { timers.clearTimeout(this.steerTimer); this.steerTimer = null; }
      if (this.steerPinTimer != null) { timers.clearTimeout(this.steerPinTimer); this.steerPinTimer = null; }
      this.steerBuffer = [];
      this.steerOriginal = null;
      if (this.handshakeTimer != null) { timers.clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
      this.detector.reset();
      if (this.unsubRunner) { this.unsubRunner(); this.unsubRunner = null; }
      // Hanging up cancels the in-flight turn (stops speech + synthesis) - but only
      // an AUTHENTICATED call has a stake in it; an anonymous/refused connection
      // dropping must never abort the captain's live turn.
      if (this.authed) runner.cancel('phone hangup (' + reason + ')');
      try { this.ws.close(); } catch { /* ignore */ }
      pending.delete(this);
      if (session === this) session = null;
      // Only a stream that actually started is a call the UI should see end -
      // anonymous/pre-start churn never flips the phone pill.
      if (this.started) emitState('ended', reason);
      log('phone: call torn down - ' + reason);
    }
  }

  // ── HTTP: the TwiML webhook ─────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  function answerTwiml(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (d: Buffer) => { body += d.toString(); if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      const params = parseFormBody(body);
      if (validateSig && secrets.authToken) {
        const sig = String(req.headers['x-twilio-signature'] || '');
        if (!validateTwilioSignature(secrets.authToken, twimlUrl, params, sig)) {
          log('phone: webhook REFUSED - bad X-Twilio-Signature');
          res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
          return;
        }
      }
      // Caller-ID allowlist: inbound calls carry the captain in From; the outbound
      // "Call me" leg carries the captain in To (From is our own Twilio number).
      const allowed = secrets.allowedCaller &&
        (sameNumber(params.From, secrets.allowedCaller) || sameNumber(params.To, secrets.allowedCaller));
      if (!allowed || !secrets.pin) {
        log(`phone: call REJECTED - caller not allowlisted (From=${params.From || '?'} To=${params.To || '?'})`);
        res.writeHead(200, { 'content-type': 'text/xml' }).end(twimlReject());
        return;
      }
      const token = mintToken();
      log(`phone: call accepted (${params.Direction || 'inbound'}) - bridging to ${wsUrl}`);
      res.writeHead(200, { 'content-type': 'text/xml' }).end(twimlConnectStream(wsUrl, { token }));
    });
  }

  const app: PhoneApp = {
    capabilities,
    get activeCall(): boolean { return session !== null; },

    handleHttp(req, res): boolean {
      const path = (req.url || '/').split('?')[0]!;
      if (!path.startsWith('/phone')) return false;
      if (path === PHONE_TWIML_PATH && req.method === 'POST') {
        answerTwiml(req, res);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
      return true;
    },

    handleUpgrade(req, socket, head): boolean {
      const path = (req.url || '/').split('?')[0]!;
      if (path !== PHONE_WS_PATH) return false;
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (pending.size >= MAX_PENDING_SOCKETS) {
          log('phone: too many pre-start connections - refusing');
          ws.close(1013, 'busy');
          return;
        }
        pending.add(new CallSession(ws));
      });
      return true;
    },

    async callMe(): Promise<{ ok: boolean; detail: string }> {
      if (!capabilities.outbound) {
        const detail = 'outbound calling not configured (need TWILIO_* + CEOCHAT_ALLOWED_CALLER + CEOCHAT_PHONE_PIN)';
        emitState('failed', detail);
        return { ok: false, detail };
      }
      if (session) {
        const detail = 'already on a call';
        emitState('failed', detail);
        return { ok: false, detail };
      }
      emitState('dialing', secrets.allowedCaller);
      const result = await placeCall({
        accountSid: secrets.accountSid!,
        authToken: secrets.authToken!,
        from: secrets.phoneNumber!,
        to: secrets.allowedCaller!,
        twimlUrl,
        fetchImpl: opts.fetchImpl,
      });
      if (!result.ok) emitState('failed', result.detail);
      return result;
    },

    onState(fn): () => void {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },

    close(): void {
      try { wss.close(); } catch { /* ignore */ }
      for (const p of [...pending]) p.end('server shutdown');
      pending.clear();
      if (session) {
        session.end('server shutdown');
        session = null;
      }
    },
  };
  return app;
}
