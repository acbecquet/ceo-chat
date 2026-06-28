// audio-player.js — hands-free, mobile-safe auto-speak for first mate's replies.
//
// THE core mobile fix. On iOS Safari / Android Chrome the Web Audio AudioContext
// starts SUSPENDED and only resumes inside a user-gesture handler — so without an
// explicit unlock, playback silently never starts (the captain's "no speech back"
// bug). This player:
//   - unlock(): created + resume()d + primed with a silent buffer on the FIRST tap
//     (the "Start call" button / mic), the only reliable iOS unlock.
//   - enqueue(): every reply's PCM is queued and played gapless on the AudioContext
//     clock (AudioBufferSourceNode scheduled at a running playHead) — auto-speak, no
//     per-message tap. Frames that arrive before unlock are buffered, then flushed.
//   - tracks "speaking" so the caller can mute the mic while first mate talks
//     (half-duplex, plan §3.1) and show a Speaking indicator.
//   - stop(): hard-cuts all scheduled audio instantly (barge-in / new turn).
//
// DOM-free and dependency-injected (createContext / now / onSpeakingChange) so the
// SAME logic the browser runs is unit-asserted in `npm run validate` against a fake
// AudioContext — no headless audio device required.

import { base64ToBytes, pcmS16leToFloat32 } from './pcm.js';

export class AudioPlayer {
  // opts: { createContext, now?, onSpeakingChange?, log? }
  constructor(opts) {
    this._createContext = opts.createContext;
    this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._onSpeaking = opts.onSpeakingChange || (() => {});
    this._log = opts.log || (() => {});
    this.ctx = null;
    this.unlocked = false;
    this._playHead = 0;
    this._active = new Set();
    this._pending = []; // {bytes, sampleRate} queued before unlock
    this._speaking = false;
  }

  get speaking() { return this._speaking; }

  _ensureCtx() {
    if (!this.ctx) this.ctx = this._createContext();
    return this.ctx;
  }

  _setSpeaking(v) {
    if (this._speaking === v) return;
    this._speaking = v;
    try { this._onSpeaking(v); } catch (e) { void e; }
  }

  // Resume + prime the context inside a user gesture. Idempotent; safe to call on
  // every gesture (iOS can re-suspend after interruptions / route changes).
  async unlock() {
    const ctx = this._ensureCtx();
    try { if (ctx.state === 'suspended' || ctx.state === 'interrupted') await ctx.resume(); }
    catch (e) { this._log('resume failed: ' + (e && e.message)); }
    // A 1-frame silent buffer fully arms the output on iOS.
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { this._log('prime failed: ' + (e && e.message)); }
    this.unlocked = ctx.state === 'running';
    if (this.unlocked) this._flushPending();
    return this.unlocked;
  }

  _flushPending() {
    if (!this._pending.length) return;
    const queued = this._pending;
    this._pending = [];
    for (const item of queued) this._schedule(item.bytes, item.sampleRate);
  }

  // Queue one reply's audio. base64 OR raw Uint8Array of s16le PCM.
  enqueue(pcm, sampleRate) {
    const bytes = typeof pcm === 'string' ? base64ToBytes(pcm) : (pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm));
    if (!bytes.length) return;
    const ctx = this._ensureCtx();
    // If still locked/suspended, HOLD it (don't drop the reply) and opportunistically
    // try to resume. resume() only actually un-suspends inside a user gesture on iOS,
    // and it's async — so we flush ONLY when it truly resolves to running (never
    // synchronously, or audio would play before the unlock tap). The buffered audio
    // is also flushed by the next explicit unlock().
    if (!this.unlocked || (ctx.state && ctx.state !== 'running')) {
      this._pending.push({ bytes, sampleRate });
      if (ctx.state !== 'running' && ctx.resume) {
        Promise.resolve()
          .then(() => ctx.resume())
          .then(() => { if (ctx.state === 'running') { this.unlocked = true; this._flushPending(); } })
          .catch((e) => this._log('opportunistic resume failed: ' + (e && e.message)));
      }
      return;
    }
    this._schedule(bytes, sampleRate);
  }

  _schedule(bytes, sampleRate) {
    const ctx = this.ctx;
    const float = pcmS16leToFloat32(bytes);
    const frames = float.length;
    if (!frames) return;
    const rate = sampleRate || ctx.sampleRate || 22050;
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
    this._setSpeaking(true);
    src.onended = () => {
      this._active.delete(src);
      if (this._active.size === 0) this._setSpeaking(false);
    };
    try {
      src.start(startAt);
      this._playHead = startAt + dur;
    } catch (e) {
      this._log('start failed: ' + (e && e.message));
      this._active.delete(src);
      src.onended = null;
      if (this._active.size === 0) this._setSpeaking(false);
    }
  }

  // Hard-stop everything scheduled (barge-in / cancel). Leaves the context unlocked.
  stop() {
    for (const src of this._active) { try { src.stop(0); } catch (e) { void e; } src.onended = null; }
    this._active.clear();
    this._pending = [];
    this._playHead = this.ctx ? this.ctx.currentTime : 0;
    this._setSpeaking(false);
  }
}
