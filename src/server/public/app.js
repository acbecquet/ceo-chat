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
  };
  function byId(id) { return document.getElementById(id); }

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
  var lastTurn = null;            // {pcm, sampleRate} for Replay
  var awaitingConfirmation = false;
  var serverState = 'idle';       // last status from the broker
  var micState = 'idle';          // SpeechController state
  var wakeLock = null;

  // ---- audio: auto-speak ----
  var audio = new AudioPlayer({
    createContext: function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      return new AC();
    },
    onSpeakingChange: function (speaking) {
      if (speaking) { speech.pause(); }            // half-duplex: mute mic while talking
      else if (inCall && micWanted) { speech.resume(); }
      refreshStatus();
    },
    log: function (m) { console.debug('[audio]', m); },
  });

  // ---- speech (Web Speech STT) ----
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micWanted = false;          // captain wants the mic on
  var speech = new SpeechController({
    createRecognition: function () {
      if (!SR) throw new Error('no SpeechRecognition');
      return new SR();
    },
    onState: function (s) { micState = s; refreshStatus(); refreshMicUi(); },
    onResult: function (text, meta) { onSpoken(text, meta.isFinal); },
    onError: function (err) {
      console.debug('[speech]', err);
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
        lastTurn = { pcm: msg.pcm, sampleRate: msg.sampleRate || sampleRate };
        audio.enqueue(msg.pcm, msg.sampleRate || sampleRate); // AUTO-SPEAK
        break;
      case 'transcript': onSpoken(msg.text || '', true); break; // server STT result -> same guard path
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
    if (inCall && (micState === 'listening')) return 'listening';
    return inCall ? 'listening' : 'idle';
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
    await audio.unlock();              // THE unlock — must be in this tap handler
    await acquireWakeLock();
    micWanted = true;
    startListening();
    els.start.classList.add('hidden'); els.hangup.classList.remove('hidden'); els.toggles.classList.remove('hidden');
    refreshStatus(); refreshMicUi();
    localSay('Call started.');
  }
  function hangup() {
    inCall = false; micWanted = false;
    speech.stop(); stopServerCapture(); audio.stop();
    releaseWakeLock(); exitCallMode(true);
    els.start.classList.remove('hidden'); els.hangup.classList.add('hidden'); els.toggles.classList.add('hidden');
    serverState = 'idle'; awaitingConfirmation = false; refreshStatus();
  }
  els.start.addEventListener('click', function () { void startCall(); });
  els.hangup.addEventListener('click', hangup);
  els.replay.addEventListener('click', function () { if (lastTurn) audio.enqueue(lastTurn.pcm, lastTurn.sampleRate); });

  function startListening() {
    if (webSpeechOk) { speech.start(); }
    else if (serverStt) { /* tap-to-talk via mic button */ }
  }

  // ---- mic button + server STT (tap-to-talk fallback) ----
  els.micToggle.addEventListener('click', function () {
    micWanted = !micWanted;
    if (micWanted) { if (webSpeechOk) speech.start(); } else { speech.pause(); stopServerCapture(); }
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

  // server STT capture: getUserMedia -> AudioWorklet -> downsample 16k -> stream.
  var capturing = false, capCtx = null, capStream = null, capNode = null, capSource = null;
  async function startServerCapture() {
    if (capturing || !serverStt) return;
    try {
      capStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      var AC = window.AudioContext || window.webkitAudioContext;
      capCtx = new AC();
      await capCtx.audioWorklet.addModule('/lib/capture-worklet.js');
      capSource = capCtx.createMediaStreamSource(capStream);
      capNode = new AudioWorkletNode(capCtx, 'ceo-capture');
      capNode.port.onmessage = function (e) {
        var f32 = e.data;                                   // Float32 at capCtx.sampleRate
        var down = downsampleFloat32(f32, capCtx.sampleRate, STT_SAMPLE_RATE);
        sendJson({ type: 'stt-audio', pcm: bytesToBase64(float32ToPcmS16le(down)), sampleRate: STT_SAMPLE_RATE });
      };
      capSource.connect(capNode); capNode.connect(capCtx.destination);
      capturing = true; refreshMicUi();
      localSay('Listening.');
    } catch (e) { toast('mic capture failed: ' + e.message); }
  }
  function stopServerCapture(transcribe) {
    if (capturing) sendJson({ type: transcribe ? 'stt-end' : 'stt-cancel' });
    capturing = false;
    try { if (capNode) capNode.disconnect(); } catch (e) {}
    try { if (capSource) capSource.disconnect(); } catch (e) {}
    try { if (capStream) capStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (capCtx) capCtx.close(); } catch (e) {}
    capNode = capSource = capStream = capCtx = null;
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
