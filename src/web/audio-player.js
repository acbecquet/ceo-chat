// audio-player.js — hands-free, mobile-safe auto-speak for first mate's replies.
//
// THE core mobile fix. On iOS Safari the Web Audio AudioContext starts SUSPENDED and
// only resumes inside a user-gesture handler — and, worse, it AUTO-SUSPENDS again
// whenever it goes idle. Replies arrive several seconds after the unlock tap, by which
// time the context has re-suspended, so a buffered reply never plays (the captain's
// "reply text shows, zero audio" bug). This player defends on two fronts:
//
//   1. KEEP-ALIVE: after the unlock gesture we start a continuous near-silent looping
//      source (a zero buffer through a ~0 gain) so the context never goes idle and iOS
//      never re-suspends it. So Web Audio is still 'running' when the reply lands.
//   2. HTMLAudioElement FALLBACK: a single <audio> element is created + played muted
//      inside the unlock gesture (satisfying iOS), then fed each reply as a WAV Blob
//      objectURL. It does NOT depend on the AudioContext staying running. We PREFER
//      Web Audio when it is genuinely 'running'; otherwise we play through the element.
//      (This also sets us up to survive the silent switch later.)
//
// enqueue() is auto-speak (no per-message tap); stop() hard-cuts (barge-in / new turn);
// "speaking" drives half-duplex (mic muted while first mate talks). DOM-free and
// dependency-injected (createContext / createAudioElement / makeObjectUrl / onDiag) so
// the SAME logic the browser runs is unit-asserted in `npm run validate` against fakes.

import { base64ToBytes, pcmS16leToFloat32, wavBytesFromPcm } from './pcm.js';

export class AudioPlayer {
  // opts: { createContext, now?, onSpeakingChange?, log?, onDiag?, pendingMaxBytes?,
  //         createAudioElement?, makeObjectUrl?, revokeObjectUrl?, defaultSampleRate? }
  constructor(opts) {
    this._createContext = opts.createContext;
    this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._onSpeaking = opts.onSpeakingChange || (() => {});
    this._log = opts.log || (() => {});
    this._diag = opts.onDiag || (() => {});
    // HTMLAudioElement fallback wiring (browser supplies these; tests inject fakes).
    this._createAudioElement = opts.createAudioElement || null;
    this._makeUrl = opts.makeObjectUrl || null;
    this._revokeUrl = opts.revokeObjectUrl || (() => {});
    this._defaultRate = opts.defaultSampleRate || 22050;

    this.ctx = null;
    this.unlocked = false;          // the unlock GESTURE has run (not "ctx is running")
    this._playHead = 0;
    this._active = new Set();       // scheduled Web Audio sources
    this._pending = [];             // {bytes, sampleRate} held before we can play
    this._pendingBytes = 0;
    this._pendingMaxBytes = opts.pendingMaxBytes || 10 * 1024 * 1024;
    this._speaking = false;

    this._keepAlive = null;         // the continuous silent source keeping ctx alive
    this._keepAliveGain = null;

    this._el = null;                // persistent <audio> for the fallback path
    this._elArmed = false;
    this._elQueue = [];             // {bytes, rate} waiting to play through the element
    this._elPlaying = false;
    this._lastState = null;         // for ctx-state-transition diagnostics
  }

  get speaking() { return this._speaking; }
  get keepAliveActive() { return !!this._keepAlive; }
  get ctxState() { return this.ctx ? this.ctx.state : 'none'; }

  _ensureCtx() {
    if (!this.ctx) this.ctx = this._createContext();
    return this.ctx;
  }

  _report(rec) {
    try { this._diag(rec); } catch (e) { void e; }
  }

  // Emit a diagnostic whenever the AudioContext state actually changes (the iOS
  // suspended/running/interrupted churn the captain needs to SEE on-device).
  _noteState(reason) {
    const s = this.ctxState;
    if (s === this._lastState) return;
    this._lastState = s;
    this._report({ t: 'ctx', state: s, keepAlive: this.keepAliveActive, reason: reason || '' });
    this._log('ctx ' + s + (reason ? ' (' + reason + ')' : ''));
  }

  _setSpeaking(v) {
    if (this._speaking === v) return;
    this._speaking = v;
    try { this._onSpeaking(v); } catch (e) { void e; }
  }

  _recomputeSpeaking() {
    this._setSpeaking(this._active.size > 0 || this._elPlaying);
  }

  // Resume + prime the context inside a user gesture, arm the element fallback, and
  // start the keep-alive. Idempotent; safe to call on every gesture (iOS can
  // re-suspend after interruptions / route changes). Returns true iff Web Audio is
  // genuinely running (the element fallback covers the false case).
  async unlock() {
    this.unlocked = true; // the gesture happened — whatever we can arm, we arm now
    const ctx = this._ensureCtx();
    try { if (ctx.state === 'suspended' || ctx.state === 'interrupted') await ctx.resume(); }
    catch (e) { this._log('resume failed: ' + (e && e.message)); }
    // A 1-frame silent buffer fully arms the Web Audio output on iOS.
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate || this._defaultRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { this._log('prime failed: ' + (e && e.message)); }
    this._armElement();
    if (ctx.state === 'running') this._ensureKeepAlive();
    this._noteState('unlock');
    this._flushPending();
    return ctx.state === 'running';
  }

  // The continuous near-silent source so iOS never idle-suspends the context. A zero
  // buffer (silent) on loop, through a ~0 gain when the ctx supports one. Stopped by
  // stop().
  _ensureKeepAlive() {
    if (this._keepAlive || !this.ctx) return;
    const ctx = this.ctx;
    try {
      const rate = ctx.sampleRate || this._defaultRate;
      const buf = ctx.createBuffer(1, Math.max(1, Math.floor(rate * 0.5)), rate); // silent (zeros)
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      if (typeof ctx.createGain === 'function') {
        const g = ctx.createGain();
        if (g.gain) g.gain.value = 0.0001; // inaudible, but a live signal path keeps it awake
        src.connect(g); g.connect(ctx.destination);
        this._keepAliveGain = g;
      } else {
        src.connect(ctx.destination);
      }
      src.start(0);
      this._keepAlive = src;
      this._report({ t: 'keepalive', active: true });
      this._log('keep-alive started');
    } catch (e) { this._log('keep-alive failed: ' + (e && e.message)); }
  }

  _stopKeepAlive() {
    if (this._keepAlive) {
      try { this._keepAlive.stop(0); } catch (e) { void e; }
      try { if (this._keepAlive.disconnect) this._keepAlive.disconnect(); } catch (e) { void e; }
    }
    if (this._keepAliveGain) { try { if (this._keepAliveGain.disconnect) this._keepAliveGain.disconnect(); } catch (e) { void e; } }
    this._keepAlive = null;
    this._keepAliveGain = null;
    this._report({ t: 'keepalive', active: false });
  }

  // Arm one persistent <audio> element inside the unlock gesture: muted-play a tiny
  // silent WAV so iOS marks it user-activated; later replies set .src + .play() with
  // no further gesture. No-op if no element factory / URL maker injected (unit fakes
  // that only exercise the Web Audio path).
  _armElement() {
    if (this._elArmed || !this._createAudioElement || !this._makeUrl) return;
    try {
      const el = this._createAudioElement();
      el.muted = true;
      el.autoplay = false;
      el.preload = 'auto';
      try {
        const silent = wavBytesFromPcm(new Uint8Array(2), this._defaultRate);
        el.src = this._makeUrl(silent);
        const p = el.play();
        if (p && typeof p.catch === 'function') p.catch((e) => this._log('element prime play: ' + (e && e.message)));
      } catch (e) { this._log('element prime failed: ' + (e && e.message)); }
      this._el = el;
      this._elArmed = true;
      this._report({ t: 'element', armed: true });
    } catch (e) { this._log('element arm failed: ' + (e && e.message)); }
  }

  _flushPending() {
    if (!this._pending.length) return;
    const queued = this._pending;
    this._pending = [];
    this._pendingBytes = 0;
    for (const item of queued) this._play(item.bytes, item.sampleRate);
  }

  _pushPending(bytes, sampleRate) {
    this._pending.push({ bytes, sampleRate });
    this._pendingBytes += bytes.length;
    // Bound the backlog (symmetric to the server STT cap): drop the OLDEST so it can't
    // grow unbounded if we can never play. Always keep at least the newest reply.
    while (this._pendingBytes > this._pendingMaxBytes && this._pending.length > 1) {
      const dropped = this._pending.shift();
      this._pendingBytes -= dropped.bytes.length;
      this._log('dropped oldest pre-unlock audio (pending cap)');
    }
  }

  // Queue one reply's audio. base64 OR raw Uint8Array of s16le PCM. Auto-speaks.
  enqueue(pcm, sampleRate) {
    const bytes = typeof pcm === 'string' ? base64ToBytes(pcm) : (pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm));
    if (!bytes.length) return;
    const ctx = this._ensureCtx();
    // Not unlocked yet (reply arrived before the first tap): HOLD it, and try to resume
    // opportunistically. resume() only truly un-suspends inside a gesture on iOS, so we
    // flush ONLY when it actually resolves to 'running' (never synchronously, or audio
    // would play before the tap). The next explicit unlock() also flushes.
    if (!this.unlocked) {
      this._pushPending(bytes, sampleRate);
      if (ctx.state !== 'running' && ctx.resume) {
        Promise.resolve()
          .then(() => ctx.resume())
          .then(() => { this._noteState('opportunistic'); if (ctx.state === 'running') { this._ensureKeepAlive(); this._flushPending(); } })
          .catch((e) => this._log('opportunistic resume failed: ' + (e && e.message)));
      }
      return;
    }
    this._play(bytes, sampleRate);
  }

  // Dispatch one reply: PREFER Web Audio when the context is genuinely running; else
  // fall back to the HTMLAudioElement; else (nothing armed yet) buffer it.
  _play(bytes, sampleRate) {
    const ctx = this.ctx;
    this._noteState();
    if (ctx && ctx.state === 'running') {
      // Belt-and-suspenders: if the keep-alive somehow died, restart it.
      this._ensureKeepAlive();
      this._schedule(bytes, sampleRate);
      this._report({ t: 'play', via: 'webaudio', bytes: bytes.length });
      return;
    }
    if (this._el) {
      this._playViaElement(bytes, sampleRate);
      this._report({ t: 'play', via: 'element', bytes: bytes.length, ctxState: ctx ? ctx.state : 'none' });
      // Keep trying to bring Web Audio back for subsequent replies.
      if (ctx && ctx.state !== 'running' && ctx.resume) {
        Promise.resolve().then(() => ctx.resume()).then(() => { this._noteState('resume-after-element'); if (ctx.state === 'running') this._ensureKeepAlive(); }).catch(() => {});
      }
      return;
    }
    // No element fallback available and Web Audio not running — hold it.
    this._pushPending(bytes, sampleRate);
    this._report({ t: 'play', via: 'pending', bytes: bytes.length, ctxState: ctx ? ctx.state : 'none' });
  }

  _schedule(bytes, sampleRate) {
    const ctx = this.ctx;
    const float = pcmS16leToFloat32(bytes);
    const frames = float.length;
    if (!frames) return;
    const rate = sampleRate || ctx.sampleRate || this._defaultRate;
    const buf = ctx.createBuffer(1, frames, rate);
    // copyToChannel when present (real ctx); fall back to getChannelData (fakes).
    if (typeof buf.copyToChannel === 'function') buf.copyToChannel(float, 0, 0);
    else { const ch = buf.getChannelData(0); for (let i = 0; i < frames; i++) ch[i] = float[i]; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this._playHead);
    const dur = frames / rate;
    this._active.add(src);
    this._recomputeSpeaking();
    src.onended = () => {
      this._active.delete(src);
      this._recomputeSpeaking();
    };
    try {
      src.start(startAt);
      this._playHead = startAt + dur;
    } catch (e) {
      this._log('start failed: ' + (e && e.message));
      this._report({ t: 'playerr', via: 'webaudio', error: (e && e.message) || 'start failed' });
      this._active.delete(src);
      src.onended = null;
      this._recomputeSpeaking();
    }
  }

  // HTMLAudioElement fallback: serialize replies through the single armed element,
  // each as a WAV Blob objectURL. Gapless enough for speech; survives a suspended ctx.
  _playViaElement(bytes, sampleRate) {
    this._elQueue.push({ bytes, sampleRate });
    if (!this._elPlaying) this._elNext();
  }

  _elNext() {
    if (!this._elQueue.length) { this._elPlaying = false; this._recomputeSpeaking(); return; }
    const item = this._elQueue.shift();
    this._elPlaying = true;
    this._recomputeSpeaking();
    let url = null;
    try {
      const wav = wavBytesFromPcm(item.bytes, item.sampleRate || this._defaultRate);
      url = this._makeUrl(wav);
      this._el.src = url;
      this._el.muted = false;
      this._el.onended = () => this._elAfter(url);
      this._el.onerror = () => { this._report({ t: 'playerr', via: 'element', error: 'media error' }); this._elAfter(url); };
      const p = this._el.play();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => { this._log('element play failed: ' + (e && e.message)); this._report({ t: 'playerr', via: 'element', error: (e && e.message) || 'play() rejected' }); this._elAfter(url); });
      }
    } catch (e) {
      this._log('element play threw: ' + (e && e.message));
      this._report({ t: 'playerr', via: 'element', error: (e && e.message) || 'threw' });
      this._elAfter(url);
    }
  }

  _elAfter(url) {
    if (url) { try { this._revokeUrl(url); } catch (e) { void e; } }
    this._elNext();
  }

  // Hard-stop everything (barge-in / new turn / hangup) and tear down the keep-alive.
  stop() {
    for (const src of this._active) { try { src.stop(0); } catch (e) { void e; } src.onended = null; }
    this._active.clear();
    this._elQueue = [];
    this._elPlaying = false;
    if (this._el) { try { this._el.pause(); } catch (e) { void e; } this._el.onended = null; this._el.onerror = null; }
    this._pending = [];
    this._pendingBytes = 0;
    this._playHead = this.ctx ? this.ctx.currentTime : 0;
    this._stopKeepAlive();
    this._noteState('stop');
    this._setSpeaking(false);
  }
}
