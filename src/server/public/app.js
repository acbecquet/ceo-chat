/* app.js — ceo-chat browser client.
 *
 * Talks the WS contract in src/server/protocol.ts to the broker:
 *   - renders the live agent terminal (xterm.js, ANSI snapshots),
 *   - sends typed / spoken lines to firstmate,
 *   - shows the speakability narration and plays its TTS audio (Web Audio, raw PCM
 *     — works for mock synthetic audio with no key, and live MiniMax when paired),
 *   - mirrors the pipeline status (listening / thinking / speaking / confirm),
 *   - offers push-to-talk via the browser's built-in speech recognition.
 *
 * The WS is a RELATIVE same-origin upgrade, so this page works unchanged on
 * http://127.0.0.1:<port> and behind the Cloudflare tunnel (wss://…/ws).
 */
(function () {
  'use strict';

  var STATUS_LABEL = {
    idle: 'Idle',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    'awaiting-confirmation': 'Awaiting your answer',
  };

  var els = {
    connDot: document.getElementById('conn-dot'),
    status: document.getElementById('status-pill'),
    tts: document.getElementById('tts-pill'),
    speak: document.getElementById('speak-pill'),
    log: document.getElementById('log'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    mic: document.getElementById('mic'),
    hint: document.getElementById('hint'),
  };

  // ---- terminal (xterm.js) ----
  var term = new window.Terminal({
    cols: 80,
    rows: 24,
    convertEol: true,
    cursorBlink: false,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: { background: '#000000' },
  });
  term.open(document.getElementById('terminal'));
  term.write('\x1b[90mwaiting for the ceo-chat session…\x1b[0m');
  function renderTerminal(data) {
    // Each frame is a full pane snapshot — clear, home, then paint.
    term.write('\x1b[2J\x1b[H' + data);
  }

  // ---- status ----
  function setStatus(state) {
    els.status.dataset.state = state;
    els.status.textContent = STATUS_LABEL[state] || state;
  }

  // ---- conversation log ----
  function addTurn(kind, opts) {
    var div = document.createElement('div');
    div.className = 'turn ' + kind;
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = opts.who;
    div.appendChild(who);
    if (opts.spoken) {
      var s = document.createElement('div');
      s.className = 'spoken-text';
      s.textContent = opts.spoken;
      div.appendChild(s);
    }
    if (opts.raw) {
      var r = document.createElement('div');
      r.className = 'raw';
      r.textContent = opts.raw;
      div.appendChild(r);
    }
    if (opts.meta) {
      var m = document.createElement('div');
      m.className = 'meta';
      m.textContent = opts.meta;
      div.appendChild(m);
    }
    els.log.appendChild(div);
    els.log.scrollTop = els.log.scrollHeight;
    return div;
  }

  // ---- audio playback (Web Audio, raw 16-bit PCM mono) ----
  var audioCtx = null;
  var playHead = 0;
  function ensureAudio() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function playPcm(b64, sampleRate) {
    var ctx = ensureAudio();
    if (!ctx) return;
    var bytes = b64ToBytes(b64);
    var frames = Math.floor(bytes.length / 2);
    if (frames === 0) return;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var buf = ctx.createBuffer(1, frames, sampleRate || 32000);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    var now = ctx.currentTime;
    var startAt = Math.max(now, playHead);
    src.start(startAt);
    playHead = startAt + buf.duration;
  }

  // ---- websocket ----
  var ws = null;
  var sampleRate = 32000;
  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }
  function connect() {
    ws = new WebSocket(wsUrl());
    ws.onopen = function () {
      els.connDot.classList.add('up');
      setControls(true);
    };
    ws.onclose = function () {
      els.connDot.classList.remove('up');
      setControls(false);
      setStatus('idle');
      setTimeout(connect, 1500);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
  }
  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        sampleRate = msg.sampleRate || 32000;
        els.tts.textContent = 'TTS ' + msg.ttsMode;
        els.speak.textContent = 'speak ' + msg.speakBackend;
        break;
      case 'status':
        setStatus(msg.state);
        break;
      case 'terminal':
        renderTerminal(msg.data);
        break;
      case 'reply':
        addTurn('spoken', { who: 'firstmate (full reply)', raw: msg.text });
        break;
      case 'narration':
        addTurn('spoken', { who: 'spoken (' + msg.backend + ')', spoken: msg.text });
        break;
      case 'audio':
        playPcm(msg.pcm, msg.sampleRate || sampleRate);
        break;
      case 'turn-done':
        addTurn('', {
          who: 'turn ' + msg.turn,
          meta: msg.bytes + ' audio bytes · time-to-first-audio ' +
            (msg.ttfbMs == null ? 'n/a' : msg.ttfbMs + 'ms'),
        });
        break;
      case 'error':
        addTurn('err', { who: 'error', raw: msg.message });
        break;
    }
  }
  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function setControls(on) {
    els.send.disabled = !on;
    els.input.disabled = !on;
  }

  // ---- send a typed/spoken line ----
  function submit() {
    var text = els.input.value.trim();
    if (!text) return;
    ensureAudio(); // unlock audio on a user gesture
    addTurn('you', { who: 'you', spoken: text });
    sendJson({ type: 'send', text: text });
    els.input.value = '';
  }
  els.send.addEventListener('click', submit);
  els.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  // ---- push-to-talk (browser built-in STT, best-effort) ----
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recog = null;
  var recording = false;
  if (!SR) {
    els.mic.disabled = true;
    els.mic.title = 'Speech recognition not supported in this browser — type instead';
    els.hint.textContent = 'This browser has no built-in speech recognition; typing is the reliable path.';
  } else {
    els.mic.addEventListener('click', function () {
      ensureAudio();
      if (recording) { try { recog.stop(); } catch (e) {} return; }
      recog = new SR();
      recog.lang = 'en-US';
      recog.interimResults = false;
      recog.maxAlternatives = 1;
      recog.onstart = function () {
        recording = true;
        els.mic.classList.add('recording');
        sendJson({ type: 'listening', on: true });
      };
      recog.onerror = function () { /* surfaced via onend */ };
      recog.onend = function () {
        recording = false;
        els.mic.classList.remove('recording');
        sendJson({ type: 'listening', on: false });
      };
      recog.onresult = function (e) {
        var said = '';
        for (var i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
        said = said.trim();
        if (said) { els.input.value = said; submit(); }
      };
      try { recog.start(); } catch (e) {}
    });
  }

  setControls(false);
  setStatus('idle');
  connect();
})();
