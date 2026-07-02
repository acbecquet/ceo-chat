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
      this.submit(text);
    }

    /** Hand text to the runner; if a cancelled turn is still settling, retry briefly. */
    private submit(text: string, tries = 0): void {
      if (this.closed) return;
      if (runner.busy) {
        if (tries >= 20) { log('phone: runner stayed busy - dropping utterance'); return; }
        timers.setTimeout(() => this.submit(text, tries + 1), 250);
        return;
      }
      void runner.run(text, 'phone');
    }

    // ---- interactive-prompt fallback (re-ask once, then the safe default) ----
    private onTurnEvent(ev: Parameters<Parameters<TurnRunner['on']>[0]>[0]): void {
      if (this.closed || !this.authed) return;
      if (ev.type === 'audio') {
        this.playPcm(ev.pcm, ev.sampleRate);
      } else if (ev.type === 'turn-done') {
        if (runner.awaitingConfirmation && looksConsequential(runner.lastNarration)) {
          this.armAnswerTimer();
        } else {
          this.reAskCount = 0;
        }
      } else if (ev.type === 'sent') {
        // A web-side answer resolves the pending prompt - stop the phone countdown.
        this.clearAnswerTimer();
        this.reAskCount = 0;
      }
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
    private speak(text: string): void {
      if (!opts.synthPrompt || !text) return;
      this.sendQueue = this.sendQueue.then(async () => {
        if (this.closed) return;
        try {
          const { pcm, sampleRate } = await opts.synthPrompt!(text);
          this.sendPcm(pcm, sampleRate);
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

    /** Sustained captain speech while we're talking: flush the buffer + abort. */
    private onBargeIn(): void {
      if (!this.authed) return;
      log('phone: barge-in - clearing buffered audio + cancelling the turn');
      this.send({ event: 'clear', streamSid: this.streamSid });
      this.outstandingMarks = 0;
      this.detector.playing = false;
      runner.cancel('phone barge-in');
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
