// speech.js — robust browser speech-to-text (Web Speech API) tuned for iOS Safari.
//
// iOS Safari's webkitSpeechRecognition is notoriously flaky: `continuous` is broken,
// each session ends after a single utterance or a beat of silence, and it must be
// re-armed to keep listening — the captain's "mic activates but no words appear" bug
// is almost always a session that ended and was never restarted. This controller
// encodes the known-good pattern:
//   - continuous=false + interimResults=true, RE-ARMED on every `end` while the call
//     is live (the only reliable way to "keep listening" on iOS),
//   - debounced final results delivered via onResult (interim shown for live UI),
//   - error handling that distinguishes PERMANENT failures (no mic permission /
//     service-not-allowed → stop + tell the UI) from TRANSIENT ones (no-speech /
//     aborted / network → just re-arm),
//   - pause()/resume() for HALF-DUPLEX: the mic is muted while first mate is speaking
//     so the TTS isn't transcribed back as input (plan §3.1),
//   - a minimum restart interval so a hard-failing recognizer can't busy-loop.
//
// DOM-free + dependency-injected (createRecognition / now / setTimeout) so the
// harness drives a fake recognizer through real iOS-shaped event sequences.

export class SpeechController {
  // opts: { createRecognition, lang?, now?, setTimeout?, clearTimeout?,
  //         minRestartMs?, onState?, onResult?, onError?, log? }
  constructor(opts) {
    this._create = opts.createRecognition;
    this._lang = opts.lang || 'en-US';
    this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((h) => clearTimeout(h));
    this._minRestartMs = opts.minRestartMs != null ? opts.minRestartMs : 350;
    this._onState = opts.onState || (() => {});
    this._onResult = opts.onResult || (() => {});
    this._onError = opts.onError || (() => {});
    this._log = opts.log || (() => {});

    this._recog = null;
    this._want = false;     // caller wants to be listening
    this._paused = false;   // half-duplex mute while TTS speaks
    this._state = 'idle';   // idle | listening | paused | error
    this._lastStart = -1e9;
    this._restartTimer = null;
  }

  get state() { return this._state; }
  get listening() { return this._state === 'listening'; }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    try { this._onState(s); } catch (e) { void e; }
  }

  /** Begin (or resume wanting) hands-free listening. */
  start() {
    this._want = true;
    if (this._paused) return;
    this._arm();
  }

  /** Stop listening entirely (caller hung up / switched to text). */
  stop() {
    this._want = false;
    this._clearRestart();
    this._abort();
    this._setState('idle');
  }

  /** Mute the mic while first mate speaks (half-duplex). */
  pause() {
    this._paused = true;
    this._clearRestart();
    this._abort();
    if (this._want) this._setState('paused');
  }

  /** Un-mute after first mate finishes speaking; re-arm if still wanted. */
  resume() {
    this._paused = false;
    if (this._want) this._arm();
  }

  _clearRestart() {
    if (this._restartTimer != null) { this._clearTimeout(this._restartTimer); this._restartTimer = null; }
  }

  _abort() {
    const r = this._recog;
    this._recog = null;
    if (r) { try { r.abort(); } catch (e) { void e; } }
  }

  // Re-arm respecting the minimum restart interval (debounce against busy-loops).
  _arm() {
    if (!this._want || this._paused) return;
    if (this._recog) return; // already running
    this._clearRestart();
    const since = this._now() - this._lastStart;
    if (since < this._minRestartMs) {
      this._restartTimer = this._setTimeout(() => { this._restartTimer = null; this._spawn(); }, this._minRestartMs - since);
      return;
    }
    this._spawn();
  }

  _spawn() {
    if (!this._want || this._paused || this._recog) return;
    let r;
    try { r = this._create(); } catch (e) { this._onError({ kind: 'unsupported', message: String(e && e.message) }); this._setState('error'); return; }
    r.lang = this._lang;
    r.continuous = false;     // iOS ignores true anyway; we re-arm on `end`
    r.interimResults = true;
    r.maxAlternatives = 1;
    this._lastStart = this._now();

    r.onstart = () => { this._setState('listening'); };
    r.onresult = (ev) => {
      let finalText = '';
      let interim = '';
      const results = ev.results || [];
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const alt = res[0] || {};
        const t = alt.transcript || '';
        if (res.isFinal) finalText += t; else interim += t;
      }
      if (interim.trim()) this._onResult(interim.trim(), { isFinal: false });
      if (finalText.trim()) this._onResult(finalText.trim(), { isFinal: true });
    };
    r.onerror = (ev) => {
      const err = (ev && ev.error) || 'unknown';
      this._log('recognition error: ' + err);
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        // Permanent: no mic permission / blocked. Stop and surface to the UI.
        this._want = false;
        this._recog = null;
        this._setState('error');
        this._onError({ kind: 'permission', message: err });
        return;
      }
      // Transient (no-speech / aborted / network / audio-capture): onend re-arms.
      this._onError({ kind: 'transient', message: err });
    };
    r.onend = () => {
      this._recog = null;
      if (this._want && !this._paused) this._arm(); // the iOS keep-alive
      else if (this._paused && this._want) this._setState('paused');
      else this._setState('idle');
    };

    this._recog = r;
    try { r.start(); } catch (e) {
      // Some browsers throw if start() races a previous session; re-arm shortly.
      this._recog = null;
      this._log('start threw: ' + (e && e.message));
      this._arm();
    }
  }
}
