// app.js - ceo-chat browser client (ES module). The iPhone in-call companion.
//
// The transcript is the centerpiece: a live 1:1 VERBATIM feed of the session's
// actual replies (frames: `sent` / `verbatim` / `narration`), rendered with code
// blocks in internally-scrollable containers and byte-exact final text. On a real
// phone call (Call Mode) the voice is the summary; this page is where the captain
// reads the exact words.
//
// Wired from the shared /lib modules (the SAME logic `npm run validate` asserts):
//   AudioPlayer        - unlock on first tap, auto-speak replies (queued, gapless)
//   SpeechController   - robust Web Speech STT (iOS restart-on-end, half-duplex)
//   guardUtterance     - a misheard phrase can't approve a consequential action
//   splitFencedSegments/extractPrompt - lossless verbatim rendering + answer card
//
// Resilient on cellular: the WS reconnects with backoff, pings for liveness, and
// the server replays the turn history on reconnect (frames carry replay:true),
// deduped here by turn number - app-switching or a dead zone never loses history.

import { AudioPlayer } from '/lib/audio-player.js';
import { SpeechController } from '/lib/speech.js';
import { guardUtterance } from '/lib/confirm.js';
import { bytesToBase64, float32ToPcmS16le, downsampleFloat32 } from '/lib/pcm.js';
import { Diagnostics } from '/lib/diagnostics.js';
import { STT_SAMPLE_RATE } from '/lib/protocol-consts.js';
import { splitFencedSegments, extractPrompt } from '/lib/prompt-card.js';

(function () {
  'use strict';

  var STATUS = {
    idle: 'Idle',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    'awaiting-confirmation': 'Your answer?',
  };

  var els = {};
  ['conn-dot', 'status-pill', 'phone-pill', 'transcript', 'empty-hint', 'jump-latest',
    'prompt-card', 'pc-question', 'pc-options', 'pc-dismiss',
    'call-me', 'voice-start', 'voice-stop', 'mic-toggle', 'replay', 'tools-toggle',
    'mic', 'input', 'send', 'tools', 'tools-close', 'tools-close-strip', 'callmode-toggle',
    'term-details', 'terminal', 'diag-details', 'diag-log', 'diag-ctx', 'diag-keepalive',
    'diag-mic', 'diag-copy', 'diag-clear', 'callmode-overlay', 'cm-status', 'cm-exit',
  ].forEach(function (id) { els[camel(id)] = document.getElementById(id); });
  function camel(id) { return id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  // ---- diagnostics panel (sighted device testing) ----
  var diag = new Diagnostics({
    onAdd: function (rec) { renderDiagLine(rec); },
    onError: function () {
      try { els.tools.classList.remove('hidden'); els.diagDetails.open = true; } catch (e) {}
    },
  });
  function renderDiagLine(rec) {
    if (!els.diagLog) return;
    var line = document.createElement('div');
    line.className = 'd-line' + (rec.level === 'error' ? ' d-err' : '');
    var ts = document.createElement('span'); ts.className = 'd-ts';
    ts.textContent = '[+' + (rec.ts / 1000).toFixed(2) + 's] ';
    line.appendChild(ts);
    line.appendChild(document.createTextNode(rec.msg));
    els.diagLog.appendChild(line);
    while (els.diagLog.childElementCount > diag.max) els.diagLog.removeChild(els.diagLog.firstChild);
    els.diagLog.scrollTop = els.diagLog.scrollHeight;
  }
  function setDiagStat(el, label, val, cls) {
    if (!el) return;
    el.textContent = label + ': ' + val;
    el.className = 'diag-stat' + (cls ? ' ' + cls : '');
  }
  els.diagCopy.addEventListener('click', function () {
    var text = diag.text();
    var done = function () { toast('diagnostics copied to clipboard'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, fallbackCopy); }
      else fallbackCopy();
    } catch (e) { fallbackCopy(); }
    function fallbackCopy() {
      try {
        var ta = document.createElement('textarea'); ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
        ta.focus(); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
      } catch (e2) { toast('copy failed - select the log manually'); }
    }
  });
  els.diagClear.addEventListener('click', function () { diag.clear(); els.diagLog.textContent = ''; });

  // ---- terminal (xterm.js) ----
  var term = new window.Terminal({
    cols: 80, rows: 24, convertEol: true, cursorBlink: false, fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: { background: '#000000' },
  });
  term.open(els.terminal);
  term.write('\x1b[90mwaiting for the session…\x1b[0m');
  function renderTerminal(data) { term.write('\x1b[2J\x1b[H' + data); }

  // ---- shared state ----
  var inCall = false;               // browser voice-call mode (not the phone call)
  var serverStt = false, sttLabel = '';
  var phoneAvailable = false;
  var lastNarration = '';
  var lastTurnAudio = null;         // {turn, chunks:[{pcm, sampleRate}]} for Replay
  var awaitingConfirmation = false;
  var serverState = 'idle';
  var micState = 'idle';
  var wakeLock = null;
  var lastFinalVerbatim = '';

  // Per-turn render state, keyed by turn number (dedupes replayed history).
  var turns = new Map();

  // ---- audio: auto-speak ----
  var lastCtxState = '';
  var audio = new AudioPlayer({
    createContext: function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      return new AC();
    },
    createAudioElement: function () { return new Audio(); },
    makeObjectUrl: function (bytes) { return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); },
    revokeObjectUrl: function (url) { try { URL.revokeObjectURL(url); } catch (e) {} },
    onSpeakingChange: function (speaking) {
      if (speaking) { speech.pause(); }
      else if (inCall && micWanted) { speech.resume(); }
      refreshStatus();
    },
    onDiag: function (rec) {
      if (rec.t === 'ctx') {
        diag.add('AudioContext -> ' + rec.state + (rec.reason ? ' (' + rec.reason + ')' : '') + (rec.keepAlive ? ' [keep-alive on]' : ''));
        refreshAudioStats();
      } else if (rec.t === 'keepalive') {
        diag.add('keep-alive ' + (rec.active ? 'STARTED' : 'stopped')); refreshAudioStats();
      } else if (rec.t === 'element') {
        diag.add('HTMLAudio element armed (fallback ready)');
      } else if (rec.t === 'play') {
        diag.add('reply audio: ' + rec.bytes + ' bytes -> ' + (rec.via === 'webaudio' ? 'Web Audio' : rec.via === 'element' ? 'HTMLAudio fallback' : 'BUFFERED (ctx ' + (rec.ctxState || '?') + ')'));
      } else if (rec.t === 'playerr') {
        diag.error('play error (' + rec.via + '): ' + (rec.error || 'unknown'));
      }
    },
    log: function (m) { console.debug('[audio]', m); },
  });
  setInterval(function () {
    var s = audio.ctxState;
    if (s !== lastCtxState) { lastCtxState = s; refreshAudioStats(); if (inCall && s === 'suspended') diag.add('AudioContext idle-suspended (poll) - keep-alive ' + (audio.keepAliveActive ? 'on' : 'OFF')); }
  }, 1000);
  function refreshAudioStats() {
    var s = audio.ctxState;
    setDiagStat(els.diagCtx, 'ctx', s, s === 'running' ? 'good' : s === 'suspended' || s === 'interrupted' ? 'bad' : '');
    setDiagStat(els.diagKeepalive, 'keep-alive', audio.keepAliveActive ? 'on' : 'off', audio.keepAliveActive ? 'good' : '');
  }

  // ---- speech (Web Speech STT) ----
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micWanted = false;
  var speech = new SpeechController({
    createRecognition: function () {
      if (!SR) throw new Error('no SpeechRecognition');
      return new SR();
    },
    onState: function (s) { micState = s; if (webSpeechOk) setDiagStat(els.diagMic, 'mic', 'WebSpeech ' + s, s === 'listening' ? 'good' : ''); refreshStatus(); refreshMicUi(); },
    onResult: function (text, meta) { if (webSpeechOk && meta.isFinal) diag.add('WebSpeech -> "' + text + '"'); onSpoken(text, meta.isFinal); },
    onError: function (err) {
      console.debug('[speech]', err);
      diag.error('WebSpeech error: ' + err.kind);
      if (err.kind === 'permission' || err.kind === 'unsupported') {
        webSpeechOk = false;
        refreshMicUi();
        if (serverStt) toast('Mic uses on-server transcription - tap the mic to talk.');
        else toast('Speech recognition unavailable here - type instead.');
      }
    },
    log: function (m) { console.debug('[speech]', m); },
  });
  var webSpeechOk = !!SR;

  // ---- websocket (reconnect + liveness, cellular-friendly) ----
  // Reconnect is SINGLE-FLIGHT: one cancellable timer, and connect() refuses to
  // stack a second socket while one is CONNECTING/OPEN - the visibilitychange
  // handler and the backoff timer can never create two live sockets (which would
  // double-play every broadcast audio frame).
  var ws = null, sampleRate = 22050, pingTimer = null, reconnectDelay = 800, reconnectTimer = null;
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws'; }
  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    var socket = new WebSocket(wsUrl());
    ws = socket;
    socket.onopen = function () {
      if (ws !== socket) { try { socket.close(); } catch (e) {} return; }
      els.connDot.classList.add('up');
      setControls(true);
      reconnectDelay = 800;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(function () { sendJson({ type: 'ping' }); }, 25000);
    };
    socket.onclose = function () {
      if (ws !== socket) return; // a stale socket closing must not touch live state
      els.connDot.classList.remove('up');
      setControls(false);
      serverState = 'idle'; refreshStatus();
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(8000, reconnectDelay * 1.7);
      }
    };
    socket.onerror = function () { try { socket.close(); } catch (e) {} };
    socket.onmessage = function (ev) { if (ws !== socket) return; var m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
  }
  function sendJson(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }
  // Coming back from the app switcher / screen lock: reconnect immediately.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
      if (inCall && !wakeLock) acquireWakeLock();
    }
  });

  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        sampleRate = msg.sampleRate || 22050;
        serverStt = !!msg.serverStt; sttLabel = msg.sttLabel || '';
        phoneAvailable = !!msg.phone;
        els.callMe.classList.toggle('hidden', !phoneAvailable);
        refreshMicUi();
        break;
      case 'status':
        serverState = msg.state;
        awaitingConfirmation = msg.state === 'awaiting-confirmation';
        if (awaitingConfirmation) showPromptCard(); else hidePromptCard();
        refreshStatus();
        break;
      case 'terminal': renderTerminal(msg.data); break;
      case 'sent': renderSent(msg); break;
      case 'verbatim': renderVerbatim(msg); break;
      case 'reply': renderReply(msg); break;
      case 'narration':
        lastNarration = msg.text || '';
        renderNarration(msg);
        break;
      case 'audio': {
        var sr = msg.sampleRate || sampleRate;
        if (msg.replay) {
          lastTurnAudio = { turn: msg.turn, chunks: [{ pcm: msg.pcm, sampleRate: sr }] };
        } else {
          if (!lastTurnAudio || lastTurnAudio.turn !== msg.turn) lastTurnAudio = { turn: msg.turn, chunks: [] };
          lastTurnAudio.chunks.push({ pcm: msg.pcm, sampleRate: sr });
          audio.enqueue(msg.pcm, sr);
        }
        break;
      }
      case 'phone': {
        var on = msg.state === 'in-call' || msg.state === 'dialing';
        els.phonePill.classList.toggle('hidden', false);
        els.phonePill.classList.toggle('on', on);
        els.phonePill.textContent = msg.state === 'in-call' ? '📞 on call'
          : msg.state === 'dialing' ? '📞 calling…'
          : msg.state === 'ended' ? '📞 ended' : '📞';
        if (msg.state === 'failed') toast('Call failed: ' + (msg.detail || 'unknown'));
        if (msg.state === 'dialing') toast('Calling your phone…');
        diag.add('phone: ' + msg.state + (msg.detail ? ' (' + msg.detail + ')' : ''));
        break;
      }
      case 'notice':
        diag.add('notice: ' + msg.message);
        toast(msg.message);
        break;
      case 'transcript':
        if (msg.empty || !(msg.text || '').trim()) {
          var why = msg.reason || 'no words recognized';
          diag.error('server STT empty: ' + why + (msg.bytes != null ? ' (' + msg.bytes + ' bytes)' : ''));
          setDiagStat(els.diagMic, 'mic', 'heard nothing', 'bad');
          toast('Heard nothing - ' + why);
          break;
        }
        diag.add('server STT -> "' + msg.text + '"' + (msg.bytes != null ? ' (' + msg.bytes + ' bytes)' : ''));
        setDiagStat(els.diagMic, 'mic', 'transcribed', 'good');
        onSpoken(msg.text || '', true);
        break;
      case 'turn-done':
        markTurnDone(msg.turn);
        break;
      case 'error': addNote('err', msg.message); break;
    }
  }

  // ---- transcript rendering (the centerpiece) ----
  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  function nearBottom() {
    var t = els.transcript;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
  }
  function follow(force) {
    if (force || nearBottom()) {
      els.transcript.scrollTop = els.transcript.scrollHeight;
      els.jumpLatest.classList.add('hidden');
    } else {
      // Anchor the pill just above the transcript's bottom edge, which moves when
      // the prompt card pins (the card sits below the transcript in the flex flow).
      var edge = window.innerHeight - els.transcript.getBoundingClientRect().bottom;
      els.jumpLatest.style.bottom = Math.max(90, edge + 12) + 'px';
      els.jumpLatest.classList.remove('hidden');
    }
  }
  els.transcript.addEventListener('scroll', function () {
    if (nearBottom()) els.jumpLatest.classList.add('hidden');
  });
  els.jumpLatest.addEventListener('click', function () { follow(true); });

  function turnState(turn) {
    var t = turns.get(turn);
    if (!t) {
      els.emptyHint && els.emptyHint.remove();
      var root = document.createElement('div');
      root.className = 'turn';
      root.dataset.turn = String(turn);
      els.transcript.appendChild(root);
      t = { root: root, sent: null, fm: null, fmBody: null, spoken: null, hasVerbatim: false, done: false };
      turns.set(turn, t);
    }
    return t;
  }

  function renderSent(msg) {
    var t = turnState(msg.turn);
    if (t.sent) return; // dedupe (replay after reconnect)
    var el = document.createElement('div');
    el.className = 'msg you';
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = msg.source === 'phone' ? '📞 you (on the call)'
      : msg.source === 'sms' ? '💬 you (by text)' : 'you';
    var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtTime(msg.ts);
    who.appendChild(ts);
    var body = document.createElement('div'); body.className = 'vb'; body.textContent = msg.text;
    el.appendChild(who); el.appendChild(body);
    t.sent = el;
    t.root.insertBefore(el, t.root.firstChild);
    follow(false);
  }

  // Render the verbatim text EXACTLY: plain segments wrap; fenced code segments go
  // into internally-scrollable monospace blocks. textContent everywhere, so the
  // rendered characters are the byte-exact reply (fences included).
  function renderVerbatimBody(container, text, live) {
    container.textContent = '';
    var segs = splitFencedSegments(text);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].kind === 'code') {
        var pre = document.createElement('span');
        pre.className = 'code';
        pre.textContent = segs[i].text;
        container.appendChild(pre);
      } else {
        container.appendChild(document.createTextNode(segs[i].text));
      }
    }
    container.classList.toggle('vb-live', !!live);
  }

  function fmBubble(t) {
    if (!t.fm) {
      var el = document.createElement('div');
      el.className = 'msg fm';
      var who = document.createElement('div');
      who.className = 'who';
      who.textContent = 'first mate';
      var ts = document.createElement('span'); ts.className = 'ts'; who.appendChild(ts);
      var body = document.createElement('div'); body.className = 'vb';
      el.appendChild(who); el.appendChild(body);
      t.fm = el; t.fmBody = body; t.fmTs = ts;
      t.root.appendChild(el);
    }
    return t.fm;
  }

  function renderVerbatim(msg) {
    var t = turnState(msg.turn);
    t.hasVerbatim = true;
    fmBubble(t);
    renderVerbatimBody(t.fmBody, msg.text, !msg.final);
    if (msg.final) {
      lastFinalVerbatim = msg.text;
      if (msg.ts && t.fmTs) t.fmTs.textContent = fmtTime(msg.ts);
      if (awaitingConfirmation) showPromptCard();
    }
    follow(false);
  }

  // Legacy aggregate reply (drivers with no verbatim tap): only used if no
  // verbatim frame ever arrives for the turn - the verbatim text wins otherwise.
  function renderReply(msg) {
    var t = turnState(msg.turn);
    if (t.hasVerbatim) return;
    fmBubble(t);
    renderVerbatimBody(t.fmBody, msg.text, false);
    if (!lastFinalVerbatim) lastFinalVerbatim = msg.text;
    follow(false);
  }

  function renderNarration(msg) {
    var t = turnState(msg.turn);
    if (!t.spoken) {
      t.spoken = document.createElement('div');
      t.spoken.className = 'spoken';
      var b = document.createElement('b'); b.textContent = '🔊 spoken: ';
      t.spoken.appendChild(b);
      t.spokenText = document.createElement('span');
      t.spoken.appendChild(t.spokenText);
      t.root.appendChild(t.spoken);
    }
    if (typeof msg.index === 'number' && !msg.replay) {
      t.spokenText.textContent = (t.spokenText.textContent ? t.spokenText.textContent + ' ' : '') + msg.text;
    } else {
      t.spokenText.textContent = msg.text;
    }
    follow(false);
  }

  function markTurnDone(turn) {
    var t = turns.get(turn);
    if (!t || t.done) return;
    t.done = true;
    if (t.fmBody) t.fmBody.classList.remove('vb-live');
  }

  function addNote(kind, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + (kind || 'note');
    el.textContent = text;
    els.transcript.appendChild(el);
    follow(false);
    return el;
  }
  function toast(text) { addNote('note', text); }

  // ---- the sticky interactive-answer card ----
  var pcDismissedFor = '';
  function showPromptCard() {
    var source = lastFinalVerbatim || lastNarration;
    var p = extractPrompt(source) || (lastNarration ? extractPrompt(lastNarration) : null);
    if (!p) { hidePromptCard(); return; }
    if (pcDismissedFor === p.question) return; // the captain closed this one
    els.pcQuestion.textContent = p.question;
    els.pcOptions.textContent = '';
    var opts = p.options.slice();
    for (var i = 0; i < opts.length; i++) {
      (function (opt) {
        var b = document.createElement('button');
        b.textContent = opt.label;
        b.addEventListener('click', function () {
          hidePromptCard();
          submit(opt.send, 'text');
        });
        els.pcOptions.appendChild(b);
      })(opts[i]);
    }
    els.promptCard.classList.remove('hidden');
  }
  function hidePromptCard() { els.promptCard.classList.add('hidden'); }
  els.pcDismiss.addEventListener('click', function () {
    pcDismissedFor = els.pcQuestion.textContent;
    hidePromptCard();
  });

  // ---- status UI ----
  function displayedStatus() {
    if (audio.speaking) return 'speaking';
    if (awaitingConfirmation) return 'awaiting-confirmation';
    if (serverState === 'thinking') return 'thinking';
    if (inCall && micState === 'listening') return 'listening';
    return 'idle';
  }
  function refreshStatus() {
    var s = displayedStatus();
    els.statusPill.dataset.state = s;
    els.statusPill.textContent = STATUS[s] || STATUS.idle;
    els.cmStatus.textContent = STATUS[s] || STATUS.idle;
  }

  // ---- sending / confirmation guard ----
  function onSpoken(text, isFinal) {
    text = (text || '').trim();
    if (!text) return;
    if (!isFinal) { clearInterim(); interimEl = addNote('note interim', '🎙 ' + text); return; }
    clearInterim();
    var decision = guardUtterance({ source: 'voice', text: text, awaitingConfirmation: awaitingConfirmation, lastNarration: lastNarration });
    if (decision.action === 'reprompt') {
      addNote('note', 'safety: ' + decision.reason + ' - held back: "' + text + '"');
      localSay(decision.speak);
      return;
    }
    submit(text, 'voice');
  }
  var interimEl = null;
  function clearInterim() { if (interimEl) { interimEl.remove(); interimEl = null; } }

  function submit(text, source) {
    text = (text || '').trim(); if (!text) return;
    audio.unlock(); // a typed send is also a gesture - keep audio armed
    pcDismissedFor = '';
    sendJson({ type: 'send', text: text });
    follow(true);
  }
  els.send.addEventListener('click', function () { var t = els.input.value.trim(); if (t) { submit(t, 'text'); els.input.value = ''; } });
  els.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var t = els.input.value.trim(); if (t) { submit(t, 'text'); els.input.value = ''; } } });

  function localSay(text) {
    if (!text) return;
    try { var u = new SpeechSynthesisUtterance(text); window.speechSynthesis.speak(u); } catch (e) {}
  }

  // ---- Call me (outbound Twilio call) ----
  els.callMe.addEventListener('click', function () {
    audio.unlock();
    sendJson({ type: 'call-me' });
  });

  // ---- browser voice-call lifecycle ----
  async function startCall() {
    inCall = true;
    diag.add('Voice tapped - unlocking audio');
    var running = await audio.unlock();
    diag.add('after unlock: ctx ' + audio.ctxState + ', keep-alive ' + (audio.keepAliveActive ? 'on' : 'off') + (running ? ' (Web Audio running)' : ' (will use fallback if needed)'));
    refreshAudioStats();
    await acquireWakeLock();
    micWanted = true;
    if (webSpeechOk) speech.start();
    els.voiceStart.classList.add('hidden');
    els.voiceStop.classList.remove('hidden');
    els.micToggle.classList.remove('hidden');
    refreshStatus(); refreshMicUi();
    localSay('Voice on.');
  }
  function hangup() {
    sendJson({ type: 'stop' });
    inCall = false; micWanted = false;
    speech.stop(); stopServerCapture(); audio.stop();
    releaseWakeLock(); exitCallMode(true);
    els.voiceStart.classList.remove('hidden');
    els.voiceStop.classList.add('hidden');
    els.micToggle.classList.add('hidden');
    serverState = 'idle'; refreshStatus();
  }
  els.voiceStart.addEventListener('click', function () { void startCall(); });
  els.voiceStop.addEventListener('click', hangup);
  els.replay.addEventListener('click', function () {
    audio.unlock();
    if (!lastTurnAudio || !lastTurnAudio.chunks.length) return;
    lastTurnAudio.chunks.forEach(function (c) { audio.enqueue(c.pcm, c.sampleRate); });
  });

  // ---- mic button + server STT (tap-to-talk fallback) ----
  els.micToggle.addEventListener('click', function () {
    micWanted = !micWanted;
    if (micWanted) {
      if (webSpeechOk) speech.start();
      else if (serverStt) startServerCapture();
    } else {
      speech.stop(); stopServerCapture(true);
    }
    refreshMicUi();
  });
  els.mic.addEventListener('click', function () {
    audio.unlock();
    if (webSpeechOk) { micWanted = !micWanted; micWanted ? speech.start() : speech.stop(); refreshMicUi(); return; }
    if (serverStt) { capturing ? stopServerCapture(true) : startServerCapture(); }
    else toast('Speech recognition unavailable here - type instead.');
  });
  function refreshMicUi() {
    var on = webSpeechOk ? (micWanted && micState !== 'idle') : capturing;
    els.mic.classList.toggle('recording', !!on || micState === 'listening');
    els.micToggle.setAttribute('aria-pressed', micWanted ? 'true' : 'false');
  }

  // server STT capture: getUserMedia -> AudioWorklet (or ScriptProcessor fallback)
  // -> downsample 16k -> stream. Hardened for iOS (see AGENTS.md Phase 4.1).
  var capturing = false, capCtx = null, capStream = null, capNode = null, capSource = null, capProc = null;
  var capBytesSent = 0, capMethod = '', capFramesRecv = 0, capWatchdog = null;
  function onCapFrame(f32) {
    capFramesRecv++;
    if (audio.speaking) return; // half-duplex: skip first mate's reply
    var down = downsampleFloat32(f32, capCtx.sampleRate, STT_SAMPLE_RATE);
    var pcm = float32ToPcmS16le(down);
    capBytesSent += pcm.length;
    sendJson({ type: 'stt-audio', pcm: bytesToBase64(pcm), sampleRate: STT_SAMPLE_RATE });
  }
  function startScriptProcessor() {
    var spn = capCtx.createScriptProcessor ? capCtx.createScriptProcessor(4096, 1, 1) : capCtx.createJavaScriptNode(4096, 1, 1);
    capProc = spn;
    spn.onaudioprocess = function (ev) { onCapFrame(ev.inputBuffer.getChannelData(0)); };
    capSource.connect(spn); spn.connect(capCtx.destination);
    capMethod = 'ScriptProcessor';
  }
  function armWorkletWatchdog() {
    if (capWatchdog) clearTimeout(capWatchdog);
    capWatchdog = setTimeout(function () {
      capWatchdog = null;
      if (!capturing || capMethod !== 'AudioWorklet' || capFramesRecv > 0) return;
      diag.error('AudioWorklet silent (0 frames in 1.5s) - switching to ScriptProcessor');
      try { if (capNode) { capNode.port.onmessage = null; capNode.disconnect(); } } catch (e) {}
      capNode = null;
      try {
        startScriptProcessor();
        diag.add('mic capture restarted via ' + capMethod);
        setDiagStat(els.diagMic, 'mic', 'capturing (' + capMethod + ')', 'good');
      } catch (e) {
        diag.error('ScriptProcessor fallback failed: ' + (e && e.message));
        setDiagStat(els.diagMic, 'mic', 'failed', 'bad');
      }
    }, 1500);
  }
  async function startServerCapture() {
    if (capturing || !serverStt) return;
    capBytesSent = 0; capMethod = ''; capFramesRecv = 0;
    setDiagStat(els.diagMic, 'mic', 'requesting…', '');
    try {
      capStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      diag.add('getUserMedia: OK (mic granted)');
    } catch (e) {
      diag.error('getUserMedia DENIED/failed: ' + (e && e.message));
      setDiagStat(els.diagMic, 'mic', 'denied', 'bad');
      toast('mic permission failed: ' + (e && e.message));
      return;
    }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      capCtx = new AC();
      try { if (capCtx.state !== 'running' && capCtx.resume) await capCtx.resume(); } catch (e) {}
      diag.add('capture ctx: ' + capCtx.state + ' @ ' + capCtx.sampleRate + 'Hz');
      capSource = capCtx.createMediaStreamSource(capStream);
      var useWorklet = !!(capCtx.audioWorklet && capCtx.audioWorklet.addModule && typeof AudioWorkletNode !== 'undefined');
      if (useWorklet) {
        try {
          await capCtx.audioWorklet.addModule('/lib/capture-worklet.js');
          capNode = new AudioWorkletNode(capCtx, 'ceo-capture');
          capNode.port.onmessage = function (e) { onCapFrame(e.data); };
          capSource.connect(capNode); capNode.connect(capCtx.destination);
          capMethod = 'AudioWorklet';
        } catch (e) { diag.add('AudioWorklet failed (' + (e && e.message) + ') - using ScriptProcessor'); useWorklet = false; }
      }
      if (!useWorklet) startScriptProcessor();
      diag.add('mic capture started via ' + capMethod);
      setDiagStat(els.diagMic, 'mic', 'capturing (' + capMethod + ')', 'good');
      capturing = true; refreshMicUi();
      if (capMethod === 'AudioWorklet') armWorkletWatchdog();
      localSay('Listening.');
    } catch (e) {
      diag.error('mic capture setup failed: ' + (e && e.message));
      setDiagStat(els.diagMic, 'mic', 'failed', 'bad');
      toast('mic capture failed: ' + (e && e.message));
      stopServerCapture(false);
    }
  }
  function stopServerCapture(transcribe) {
    if (capturing) {
      diag.add('mic ' + (transcribe ? 'stop -> transcribe' : 'cancel') + ' (' + capBytesSent + ' PCM bytes streamed via ' + (capMethod || '?') + ', ' + capFramesRecv + ' frames captured)');
      if (transcribe && capBytesSent === 0) {
        if (capFramesRecv > 0) { diag.add('mic captured ' + capFramesRecv + ' frames but all were suppressed by half-duplex (first mate was speaking) - no failure'); }
        else { diag.error('mic streamed 0 bytes - no audio reached the server'); setDiagStat(els.diagMic, 'mic', 'no audio', 'bad'); }
      }
      sendJson({ type: transcribe ? 'stt-end' : 'stt-cancel' });
    }
    capturing = false;
    if (capWatchdog) { clearTimeout(capWatchdog); capWatchdog = null; }
    try { if (capNode) { capNode.port.onmessage = null; capNode.disconnect(); } } catch (e) {}
    try { if (capProc) { capProc.onaudioprocess = null; capProc.disconnect(); } } catch (e) {}
    try { if (capSource) capSource.disconnect(); } catch (e) {}
    try { if (capStream) capStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (capCtx) capCtx.close(); } catch (e) {}
    capNode = capProc = capSource = capStream = capCtx = null;
    refreshMicUi();
  }

  // ---- tools sheet ----
  function toggleTools(open) {
    var show = open == null ? els.tools.classList.contains('hidden') : open;
    els.tools.classList.toggle('hidden', !show);
    els.toolsToggle.setAttribute('aria-expanded', show ? 'true' : 'false');
  }
  els.toolsToggle.addEventListener('click', function () { toggleTools(); });
  els.toolsClose.addEventListener('click', function () { toggleTools(false); });
  els.toolsCloseStrip.addEventListener('click', function () { toggleTools(false); });

  // ---- Wake Lock (keep the screen alive through long thinks) ----
  async function acquireWakeLock() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; }); } } catch (e) {}
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }

  // ---- Call mode: raise-to-ear (heuristic) + manual toggle + cheek-proof overlay ----
  // HARD LIMIT: iOS Safari web cannot read the proximity sensor or power the display
  // off - only a native/CallKit wrapper can. This dims to black and ignores touches
  // so it FEELS like a call; the backlight stays on.
  var callModeOn = false, motionGranted = false;
  els.callmodeToggle.addEventListener('click', async function () {
    if (!callModeOn) { await enableMotion(); enterCallMode(); toggleTools(false); }
    else { exitCallMode(true); }
  });
  els.cmExit.addEventListener('click', function (e) { e.stopPropagation(); exitCallMode(true); });
  els.callmodeOverlay.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
  els.callmodeOverlay.addEventListener('touchstart', function (e) { if (e.target === els.callmodeOverlay || e.target.classList.contains('cm-inner')) e.preventDefault(); }, { passive: false });

  async function enableMotion() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        var res = await DeviceMotionEvent.requestPermission();
        motionGranted = res === 'granted';
      } else { motionGranted = ('DeviceOrientationEvent' in window); }
      if (motionGranted) window.addEventListener('deviceorientation', onOrient);
    } catch (e) { motionGranted = false; }
  }
  function onOrient(e) {
    if (!callModeOn) return;
    var beta = e.beta == null ? 0 : e.beta;
    els.callmodeOverlay.classList.toggle('dim', Math.abs(beta) > 60);
  }
  function enterCallMode() {
    callModeOn = true;
    els.callmodeOverlay.classList.remove('hidden');
    els.callmodeOverlay.setAttribute('aria-hidden', 'false');
    els.callmodeToggle.setAttribute('aria-pressed', 'true');
    acquireWakeLock();
  }
  function exitCallMode(manual) {
    void manual;
    callModeOn = false;
    els.callmodeOverlay.classList.add('hidden');
    els.callmodeOverlay.classList.remove('dim');
    els.callmodeOverlay.setAttribute('aria-hidden', 'true');
    els.callmodeToggle.setAttribute('aria-pressed', 'false');
    if (motionGranted) window.removeEventListener('deviceorientation', onOrient);
  }

  function setControls(on) { els.send.disabled = !on; els.input.disabled = !on; els.voiceStart.disabled = !on; els.callMe.disabled = !on; }

  setControls(false); refreshStatus(); connect();
})();
