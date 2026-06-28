// app.js — ceo-chat browser client (ES module). A hands-free phone CALL to firstmate.
//
// The mobile fixes the captain asked for, wired from the shared /lib modules
// (the SAME logic `npm run validate` asserts):
//   - AudioPlayer  : unlock the AudioContext on the first tap, then AUTO-SPEAK every
//                    reply (queued, gapless) — the core read-aloud, hands-free.
//   - SpeechController : robust Web Speech STT (iOS restart-on-end, half-duplex mute
//                    while first mate talks). Server-side whisper is the fallback.
//   - guardUtterance : a misheard phrase can't approve a consequential action (§3.5).
//   - Call mode    : raise-to-ear (DeviceMotion) → cheek-proof black overlay, audio
//                    still running, Wake Lock held; manual toggle fallback.
//
// The WS is a RELATIVE same-origin upgrade, so this runs unchanged on localhost and
// behind the Cloudflare tunnel (wss://…/ws).

import { AudioPlayer } from '/lib/audio-player.js';
import { SpeechController } from '/lib/speech.js';
import { guardUtterance } from '/lib/confirm.js';
import { bytesToBase64, float32ToPcmS16le, downsampleFloat32 } from '/lib/pcm.js';
import { Diagnostics } from '/lib/diagnostics.js';
import { STT_SAMPLE_RATE } from '/lib/protocol-consts.js';

(function () {
  'use strict';

  var STATUS = {
    idle: { words: 'Idle', sub: 'Tap “Start call” to begin.', icon: '●' },
    listening: { words: 'Listening…', sub: 'Speak now — I’m hearing you.', icon: '🎙' },
    thinking: { words: 'Thinking…', sub: 'first mate is working on it.', icon: '…' },
    speaking: { words: 'Speaking…', sub: 'Reading first mate’s reply aloud.', icon: '🔊' },
    'awaiting-confirmation': { words: 'Your answer?', sub: 'Say “confirm” or “cancel”.', icon: '⚠' },
  };

  var els = {
    connDot: byId('conn-dot'), status: byId('status-pill'), tts: byId('tts-pill'),
    ring: byId('status-ring'), icon: byId('status-icon'),
    words: byId('status-words'), sub: byId('status-sub'),
    start: byId('start'), hangup: byId('hangup'), toggles: byId('call-toggles'),
    micToggle: byId('mic-toggle'), callmodeToggle: byId('callmode-toggle'), replay: byId('replay'),
    log: byId('log'), input: byId('input'), send: byId('send'), mic: byId('mic'), hint: byId('hint'),
    termDetails: byId('term-details'),
    overlay: byId('callmode-overlay'), cmStatus: byId('cm-status'), cmExit: byId('cm-exit'),
    diagDetails: byId('diag-details'), diagLog: byId('diag-log'), diagCtx: byId('diag-ctx'),
    diagKeepAlive: byId('diag-keepalive'), diagMic: byId('diag-mic'),
    diagCopy: byId('diag-copy'), diagClear: byId('diag-clear'),
  };
  function byId(id) { return document.getElementById(id); }

  // ---- diagnostics panel (sighted device testing) ----
  var diag = new Diagnostics({
    onAdd: function (rec) { renderDiagLine(rec); },
    onError: function () { try { if (els.diagDetails) els.diagDetails.open = true; } catch (e) {} },
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
  if (els.diagCopy) els.diagCopy.addEventListener('click', function () {
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
      } catch (e2) { toast('copy failed — select the log manually'); }
    }
  });
  if (els.diagClear) els.diagClear.addEventListener('click', function () { diag.clear(); if (els.diagLog) els.diagLog.textContent = ''; });

  // ---- terminal (xterm.js) ----
  var term = new window.Terminal({
    cols: 80, rows: 24, convertEol: true, cursorBlink: false, fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: { background: '#000000' },
  });
  term.open(byId('terminal'));
  term.write('\x1b[90mwaiting for the ceo-chat session…\x1b[0m');
  function renderTerminal(data) { term.write('\x1b[2J\x1b[H' + data); }

  // ---- shared state ----
  var inCall = false;
  var serverStt = false, sttLabel = '';
  var lastNarration = '';
  var lastTurn = null;            // {turn, chunks:[{pcm, sampleRate}]} — the WHOLE turn for Replay
  var awaitingConfirmation = false;
  var serverState = 'idle';       // last status from the broker
  var micState = 'idle';          // SpeechController state
  var wakeLock = null;

  // ---- audio: auto-speak ----
  var lastCtxState = '';
  var audio = new AudioPlayer({
    createContext: function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      return new AC();
    },
    // HTMLAudioElement fallback: persistent <audio> fed a WAV Blob per reply when the
    // AudioContext won't stay 'running' (the iOS idle-suspend bug).
    createAudioElement: function () { return new Audio(); },
    makeObjectUrl: function (bytes) { return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); },
    revokeObjectUrl: function (url) { try { URL.revokeObjectURL(url); } catch (e) {} },
    onSpeakingChange: function (speaking) {
      if (speaking) { speech.pause(); }            // half-duplex: mute mic while talking
      else if (inCall && micWanted) { speech.resume(); }
      refreshStatus();
    },
    onDiag: function (rec) {
      if (rec.t === 'ctx') {
        diag.add('AudioContext → ' + rec.state + (rec.reason ? ' (' + rec.reason + ')' : '') + (rec.keepAlive ? ' [keep-alive on]' : ''));
        refreshAudioStats();
      } else if (rec.t === 'keepalive') {
        diag.add('keep-alive ' + (rec.active ? 'STARTED' : 'stopped')); refreshAudioStats();
      } else if (rec.t === 'element') {
        diag.add('HTMLAudio element armed (fallback ready)');
      } else if (rec.t === 'play') {
        diag.add('reply audio: ' + rec.bytes + ' bytes → ' + (rec.via === 'webaudio' ? 'Web Audio' : rec.via === 'element' ? 'HTMLAudio fallback' : 'BUFFERED (ctx ' + (rec.ctxState || '?') + ')'));
      } else if (rec.t === 'playerr') {
        diag.error('play error (' + rec.via + '): ' + (rec.error || 'unknown'));
      }
    },
    log: function (m) { console.debug('[audio]', m); },
  });
  // Poll the AudioContext state while in a call so iOS auto-suspends (which fire no
  // event) still show up live in the panel.
  setInterval(function () {
    var s = audio.ctxState;
    if (s !== lastCtxState) { lastCtxState = s; refreshAudioStats(); if (inCall && s === 'suspended') diag.add('AudioContext idle-suspended (poll) — keep-alive ' + (audio.keepAliveActive ? 'on' : 'OFF')); }
  }, 1000);
  function refreshAudioStats() {
    var s = audio.ctxState;
    setDiagStat(els.diagCtx, 'ctx', s, s === 'running' ? 'good' : s === 'suspended' || s === 'interrupted' ? 'bad' : '');
    setDiagStat(els.diagKeepAlive, 'keep-alive', audio.keepAliveActive ? 'on' : 'off', audio.keepAliveActive ? 'good' : '');
  }

  // ---- speech (Web Speech STT) ----
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micWanted = false;          // captain wants the mic on
  var speech = new SpeechController({
    createRecognition: function () {
      if (!SR) throw new Error('no SpeechRecognition');
      return new SR();
    },
    onState: function (s) { micState = s; if (webSpeechOk) setDiagStat(els.diagMic, 'mic', 'WebSpeech ' + s, s === 'listening' ? 'good' : ''); refreshStatus(); refreshMicUi(); },
    onResult: function (text, meta) { if (webSpeechOk && meta.isFinal) diag.add('WebSpeech → "' + text + '"'); onSpoken(text, meta.isFinal); },
    onError: function (err) {
      console.debug('[speech]', err);
      diag.error('WebSpeech error: ' + err.kind);
      if (err.kind === 'permission' || err.kind === 'unsupported') {
        // Web Speech unavailable — fall back to server-side STT (tap-to-talk) if we have it.
        webSpeechOk = false;
        refreshMicUi();
        if (serverStt) toast('Mic uses on-server transcription — tap 🎙 to talk.');
        else toast('Speech recognition unavailable here — type instead.');
      }
    },
    log: function (m) { console.debug('[speech]', m); },
  });
  var webSpeechOk = !!SR;

  // ---- websocket ----
  var ws = null, sampleRate = 22050;
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws'; }
  function connect() {
    ws = new WebSocket(wsUrl());
    ws.onopen = function () { els.connDot.classList.add('up'); setControls(true); };
    ws.onclose = function () { els.connDot.classList.remove('up'); setControls(false); serverState = 'idle'; refreshStatus(); setTimeout(connect, 1500); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } handle(m); };
  }
  function sendJson(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        sampleRate = msg.sampleRate || 22050;
        serverStt = !!msg.serverStt; sttLabel = msg.sttLabel || '';
        els.tts.textContent = 'voice ' + (msg.ttsVoice || msg.ttsMode || '—');
        refreshMicUi();
        break;
      case 'status': serverState = msg.state; awaitingConfirmation = msg.state === 'awaiting-confirmation'; refreshStatus(); break;
      case 'terminal': renderTerminal(msg.data); break;
      case 'reply': addTurn('spoken', { who: 'firstmate (full reply)', raw: msg.text }); break;
      case 'narration':
        lastNarration = msg.text || '';
        addTurn('spoken', { who: 'spoken (' + msg.backend + ')', spoken: msg.text });
        break;
      case 'audio':
        var sr = msg.sampleRate || sampleRate;
        if (msg.replay) {
          // Reconnect aggregate: the whole turn arrives in one frame. Arm Replay but do
          // NOT auto-play it (the captain didn't just ask).
          lastTurn = { turn: msg.turn, chunks: [{ pcm: msg.pcm, sampleRate: sr }] };
        } else {
          // Live progressive chunk: accumulate per turn so Replay covers the ENTIRE turn,
          // not just the final sentence. Live audio auto-speaks, queued gaplessly.
          if (!lastTurn || lastTurn.turn !== msg.turn) lastTurn = { turn: msg.turn, chunks: [] };
          lastTurn.chunks.push({ pcm: msg.pcm, sampleRate: sr });
          audio.enqueue(msg.pcm, sr);
        }
        break;
      case 'notice':
        diag.add('notice: ' + msg.message);
        toast(msg.message);
        break;
      case 'transcript':
        // Server STT result. Make empty/failed results VISIBLE rather than silent.
        if (msg.empty || !(msg.text || '').trim()) {
          var why = msg.reason || 'no words recognized';
          diag.error('server STT empty: ' + why + (msg.bytes != null ? ' (' + msg.bytes + ' bytes)' : ''));
          setDiagStat(els.diagMic, 'mic', 'heard nothing', 'bad');
          toast('Heard nothing — ' + why);
          break;
        }
        diag.add('server STT → "' + msg.text + '"' + (msg.bytes != null ? ' (' + msg.bytes + ' bytes)' : ''));
        setDiagStat(els.diagMic, 'mic', 'transcribed', 'good');
        onSpoken(msg.text || '', true); // -> same confirmation guard path
        break;
      case 'turn-done':
        addTurn('', { who: 'turn ' + msg.turn, meta: msg.bytes + ' audio bytes · ttfa ' + (msg.ttfbMs == null ? 'n/a' : msg.ttfbMs + 'ms') });
        break;
      case 'error': addTurn('err', { who: 'error', raw: msg.message }); break;
    }
  }

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
    var info = STATUS[s] || STATUS.idle;
    els.status.dataset.state = s; els.status.textContent = info.words;
    els.ring.dataset.state = s; els.icon.textContent = info.icon;
    els.words.textContent = info.words; els.sub.textContent = info.sub;
    els.cmStatus.textContent = info.words;
  }

  // ---- conversation log ----
  function addTurn(kind, opts) {
    var div = document.createElement('div');
    div.className = 'turn ' + kind + (opts.interim ? ' interim' : '');
    div.appendChild(mk('who', opts.who));
    if (opts.spoken) div.appendChild(mk('spoken-text', opts.spoken));
    if (opts.raw) div.appendChild(mk('raw', opts.raw));
    if (opts.meta) div.appendChild(mk('meta', opts.meta));
    if (opts.interim) div.dataset.interim = '1';
    els.log.appendChild(div); els.log.scrollTop = els.log.scrollHeight;
    return div;
  }
  function mk(cls, text) { var d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }
  function clearInterim() { var n = els.log.querySelector('[data-interim="1"]'); if (n) n.remove(); }
  function toast(text) { addTurn('', { who: 'note', meta: text }); }

  // ---- sending / confirmation guard ----
  function onSpoken(text, isFinal) {
    text = (text || '').trim();
    if (!text) return;
    if (!isFinal) { clearInterim(); addTurn('you', { who: 'hearing…', spoken: text, interim: true }); return; }
    clearInterim();
    var decision = guardUtterance({ source: 'voice', text: text, awaitingConfirmation: awaitingConfirmation, lastNarration: lastNarration });
    if (decision.action === 'reprompt') {
      addTurn('', { who: 'safety', meta: decision.reason + ' — held back: “' + text + '”' });
      localSay(decision.speak);
      return;
    }
    submit(text, 'voice');
  }
  function submit(text, source) {
    text = (text || '').trim(); if (!text) return;
    audio.unlock(); // a typed send is also a gesture — keep audio armed
    addTurn('you', { who: source === 'voice' ? 'you (spoken)' : 'you', spoken: text });
    sendJson({ type: 'send', text: text });
  }
  els.send.addEventListener('click', function () { var t = els.input.value.trim(); if (t) { submit(t, 'text'); els.input.value = ''; } });
  els.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var t = els.input.value.trim(); if (t) { submit(t, 'text'); els.input.value = ''; } } });

  // A short LOCAL spoken cue (re-prompts / earcons) via the browser's own TTS — does
  // not need the server and is fine for one-liners. Best-effort.
  function localSay(text) {
    if (!text) return;
    try { var u = new SpeechSynthesisUtterance(text); window.speechSynthesis.speak(u); } catch (e) {}
  }

  // ---- call lifecycle ----
  async function startCall() {
    inCall = true;
    diag.add('Start call tapped — unlocking audio');
    var running = await audio.unlock();              // THE unlock — must be in this tap handler
    diag.add('after unlock: ctx ' + audio.ctxState + ', keep-alive ' + (audio.keepAliveActive ? 'on' : 'off') + (running ? ' (Web Audio running)' : ' (will use fallback if needed)'));
    refreshAudioStats();
    await acquireWakeLock();
    micWanted = true;
    startListening();
    els.start.classList.add('hidden'); els.hangup.classList.remove('hidden'); els.toggles.classList.remove('hidden');
    refreshStatus(); refreshMicUi();
    localSay('Call started.');
  }
  function hangup() {
    sendJson({ type: 'stop' }); // cancel any in-flight turn server-side (stop synthesis)
    inCall = false; micWanted = false;
    speech.stop(); stopServerCapture(); audio.stop();
    releaseWakeLock(); exitCallMode(true);
    els.start.classList.remove('hidden'); els.hangup.classList.add('hidden'); els.toggles.classList.add('hidden');
    serverState = 'idle'; awaitingConfirmation = false; refreshStatus();
  }
  els.start.addEventListener('click', function () { void startCall(); });
  els.hangup.addEventListener('click', hangup);
  els.replay.addEventListener('click', function () {
    if (!lastTurn || !lastTurn.chunks.length) return;
    lastTurn.chunks.forEach(function (c) { audio.enqueue(c.pcm, c.sampleRate); });
  });

  function startListening() {
    if (webSpeechOk) { speech.start(); }
    else if (serverStt) { /* tap-to-talk via mic button */ }
  }

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
  });
  function refreshMicUi() {
    var on = webSpeechOk ? (micWanted && micState !== 'idle') : capturing;
    els.mic.classList.toggle('recording', !!on || micState === 'listening');
    els.micToggle.setAttribute('aria-pressed', micWanted ? 'true' : 'false');
    els.micToggle.textContent = micWanted ? '🎙 Mic on' : '🎙 Mic off';
    if (!webSpeechOk && serverStt) els.hint.innerHTML = 'Web Speech is unavailable here — tap <b>🎙</b> to talk; audio is transcribed on the server (' + (sttLabel || 'whisper') + ').';
  }

  // server STT capture: getUserMedia -> AudioWorklet (or ScriptProcessor fallback)
  // -> downsample 16k -> stream. Hardened for iOS: the capture AudioContext is resumed
  // INSIDE the mic tap and kept running; if AudioWorklet is unavailable (throws) OR
  // silent (a 1.5s watchdog sees 0 frames) we fall back to a ScriptProcessorNode so
  // iOS still streams PCM.
  var capturing = false, capCtx = null, capStream = null, capNode = null, capSource = null, capProc = null;
  var capBytesSent = 0, capMethod = '', capFramesRecv = 0, capWatchdog = null;
  function onCapFrame(f32) {
    capFramesRecv++;                                      // counts even when half-duplex suppresses sending
    if (audio.speaking) return;                           // half-duplex: skip first mate's reply
    var down = downsampleFloat32(f32, capCtx.sampleRate, STT_SAMPLE_RATE);
    var pcm = float32ToPcmS16le(down);
    capBytesSent += pcm.length;
    sendJson({ type: 'stt-audio', pcm: bytesToBase64(pcm), sampleRate: STT_SAMPLE_RATE });
  }
  function startScriptProcessor() {
    // ScriptProcessor fallback (deprecated but works on older iOS Safari / silent worklet).
    var spn = capCtx.createScriptProcessor ? capCtx.createScriptProcessor(4096, 1, 1) : capCtx.createJavaScriptNode(4096, 1, 1);
    capProc = spn;
    spn.onaudioprocess = function (ev) { onCapFrame(ev.inputBuffer.getChannelData(0)); };
    capSource.connect(spn); spn.connect(capCtx.destination);
    capMethod = 'ScriptProcessor';
  }
  // iOS Safari sometimes loads + constructs an AudioWorklet whose port never fires
  // (a "silent worklet"). If no frames arrive shortly after start, swap to ScriptProcessor.
  function armWorkletWatchdog() {
    if (capWatchdog) clearTimeout(capWatchdog);
    capWatchdog = setTimeout(function () {
      capWatchdog = null;
      if (!capturing || capMethod !== 'AudioWorklet' || capFramesRecv > 0) return;
      diag.error('AudioWorklet silent (0 frames in 1.5s) — switching to ScriptProcessor');
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
      // iOS starts capture contexts suspended too — resume in this tap gesture.
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
        } catch (e) { diag.add('AudioWorklet failed (' + (e && e.message) + ') — using ScriptProcessor'); useWorklet = false; }
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
      diag.add('mic ' + (transcribe ? 'stop → transcribe' : 'cancel') + ' (' + capBytesSent + ' PCM bytes streamed via ' + (capMethod || '?') + ', ' + capFramesRecv + ' frames captured)');
      if (transcribe && capBytesSent === 0) {
        if (capFramesRecv > 0) { diag.add('mic captured ' + capFramesRecv + ' frames but all were suppressed by half-duplex (first mate was speaking) — no failure'); }
        else { diag.error('mic streamed 0 bytes — no audio reached the server'); setDiagStat(els.diagMic, 'mic', 'no audio', 'bad'); }
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

  // ---- Wake Lock (keep the screen alive through long thinks) ----
  async function acquireWakeLock() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; }); } } catch (e) {}
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && inCall && !wakeLock) acquireWakeLock(); });

  // ---- Call mode: raise-to-ear (heuristic) + manual toggle + cheek-proof overlay ----
  // HARD LIMIT: iOS Safari web cannot read the proximity sensor or power the display
  // off — only a native/CallKit wrapper can. This dims to black and ignores touches
  // so it FEELS like a call; the backlight stays on. A future native wrapper can hook
  // the same enter/exitCallMode() seam.
  var callModeOn = false, motionGranted = false;
  els.callmodeToggle.addEventListener('click', async function () {
    if (!callModeOn) { await enableMotion(); enterCallMode(); }
    else { exitCallMode(true); }
  });
  els.cmExit.addEventListener('click', function (e) { e.stopPropagation(); exitCallMode(true); });
  // Swallow cheek taps on the black area while armed (don't fall through to the UI).
  els.overlay.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
  els.overlay.addEventListener('touchstart', function (e) { if (e.target === els.overlay || e.target.classList.contains('cm-inner')) e.preventDefault(); }, { passive: false });

  async function enableMotion() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        var res = await DeviceMotionEvent.requestPermission();
        motionGranted = res === 'granted';
      } else { motionGranted = ('DeviceOrientationEvent' in window); }
      if (motionGranted) window.addEventListener('deviceorientation', onOrient);
    } catch (e) { motionGranted = false; }
  }
  // Raise-to-ear heuristic: phone roughly vertical (|beta| high). Lower it -> wake.
  var lastRaise = 0;
  function onOrient(e) {
    if (!callModeOn) return;
    var beta = e.beta == null ? 0 : e.beta;     // front-back tilt: ~90 = upright
    var raised = Math.abs(beta) > 60;
    els.overlay.classList.toggle('dim', raised);
    if (raised) lastRaise = Date.now();
  }
  els.callmodeToggle.setAttribute('aria-pressed', 'false');
  function enterCallMode() {
    callModeOn = true;
    els.overlay.classList.remove('hidden'); els.overlay.classList.add('armed');
    els.overlay.setAttribute('aria-hidden', 'false');
    els.callmodeToggle.setAttribute('aria-pressed', 'true');
    acquireWakeLock();
  }
  function exitCallMode(manual) {
    if (!callModeOn && manual) { /* allow exit even if entered oddly */ }
    callModeOn = false;
    els.overlay.classList.add('hidden'); els.overlay.classList.remove('armed', 'dim');
    els.overlay.setAttribute('aria-hidden', 'true');
    els.callmodeToggle.setAttribute('aria-pressed', 'false');
    if (motionGranted) window.removeEventListener('deviceorientation', onOrient);
  }

  function setControls(on) { els.send.disabled = !on; els.input.disabled = !on; els.start.disabled = !on; }

  setControls(false); refreshStatus(); connect();
})();
