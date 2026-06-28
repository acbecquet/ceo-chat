// diagnostics.js — a DOM-free ring buffer for the on-screen Diagnostics panel.
//
// The captain tests on a real iPhone with no dev tools attached, so audio/mic failures
// must be VISIBLE on the device. This holds timestamped lines (relative to first use),
// flags error lines (so the panel can auto-open), and renders a copy-pasteable dump for
// the "Copy diagnostics" button. DOM-free + injected clock so the SAME formatting the
// phone shows is unit-asserted by `npm run validate`; app.js owns the actual DOM render.

export class Diagnostics {
  // opts: { now?, max?, onAdd?, onError? }
  constructor(opts = {}) {
    this._now = opts.now || (() => Date.now());
    this._max = opts.max || 500;
    this._onAdd = opts.onAdd || (() => {});
    this._onError = opts.onError || (() => {});
    this._lines = [];
    this._t0 = this._now();
  }

  get count() { return this._lines.length; }

  add(msg, level) {
    const ts = this._now() - this._t0;
    const rec = { ts, msg: String(msg), level: level === 'error' ? 'error' : 'info' };
    this._lines.push(rec);
    while (this._lines.length > this._max) this._lines.shift();
    try { this._onAdd(rec); } catch (e) { void e; }
    if (rec.level === 'error') { try { this._onError(rec); } catch (e) { void e; } }
    return rec;
  }

  error(msg) { return this.add(msg, 'error'); }

  clear() { this._lines = []; this._t0 = this._now(); }

  lines() { return this._lines.slice(); }

  // A copy-pasteable dump: "[+1.23s] message" per line, errors marked.
  text() {
    return this._lines
      .map((r) => `[+${(r.ts / 1000).toFixed(2)}s]${r.level === 'error' ? ' ERR' : ''} ${r.msg}`)
      .join('\n');
  }
}
