// app.ts - the ceo-chat web transport: one HTTP server that serves the single-page
// browser UI and brokers the pipeline over a same-origin WebSocket.
//
// It is deliberately decoupled from tmux/claude: it talks to a Driver (driver.ts)
// through the shared TurnRunner (turns.ts). The product passes a BrokerDriver (real
// session); `npm run validate` passes an in-memory driver over the same runPipeline.
// So this file - the static serving, the WS contract, status indicators, terminal
// streaming, turn serialization, reconnect replay - is asserted end-to-end with NO
// creds and NO agent session.
//
// Call Mode: when a PhoneApp (src/server/phone.ts) is wired in, this server ALSO
// answers the Twilio voice webhook (POST /phone/twiml) and the Media Streams WS
// upgrade (/phone) on the SAME port, so one Cloudflare tunnel fronts both the
// browser UI and the phone bridge. Text Mode rides it the same way: a wired-in
// TextApp (src/server/text.ts) answers the Twilio messaging webhook
// (POST /text/webhook) and the /text/notify trigger here too. Turns started from
// the phone or an SMS stream into every connected browser (the web app is the
// companion transcript) because all transports share ONE TurnRunner.
//
// Tunnel-ready: plain HTTP on localhost (Cloudflare terminates TLS at the named
// tunnel), and the browser upgrades to a RELATIVE same-origin ws(s):// - so the same
// build works on http://127.0.0.1:<port> and through wss://ceo-chat.acb-apps.com.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { WS_PATH, AUDIO_FORMAT, STT_SAMPLE_RATE, type ServerMessage, type ClientMessage } from './protocol.ts';
import type { Driver } from './driver.ts';
import { TurnRunner } from './turns.ts';
import type { VerbatimTap } from './verbatim.ts';
import type { PhoneApp } from './phone.ts';
import type { TextApp } from './text.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const REPO_ROOT = join(HERE, '..', '..');
const XTERM_DIR = join(REPO_ROOT, 'node_modules', '@xterm', 'xterm');
// Shared browser modules (pcm/audio/speech/confirm/worklet) live in src/web so the
// SAME files the page loads at /lib/… are unit-asserted by `npm run validate`.
const WEB_LIB_DIR = join(REPO_ROOT, 'src', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export interface WebAppOptions {
  driver: Driver;
  host?: string;
  port?: number;
  /** Terminal poll interval (ms). 0 disables the periodic loop (tests). */
  terminalPollMs?: number;
  /**
   * Optional SERVER-SIDE STT: transcribe captured mic PCM (s16le mono) to text.
   * When provided, the browser may stream mic audio over the WS as a fallback to
   * its own Web Speech; the text is handed BACK to the client (not auto-run) so the
   * confirmation guard applies before it reaches firstmate. Undefined -> disabled.
   */
  transcribe?: (pcm: Buffer, sampleRate: number) => Promise<string>;
  /** Human label for the STT backend (advertised in `hello`). */
  sttLabel?: string;
  /** Live 1:1 verbatim transcript source (the transcript tap). Optional. */
  verbatim?: VerbatimTap;
  /**
   * A pre-built shared TurnRunner. The phone transport needs the runner BEFORE this
   * server exists (createPhoneApp takes it), so the product builds one, hands it to
   * both, and passes it here. Absent -> one is built from driver/verbatim/historyMax.
   */
  runner?: TurnRunner;
  /** Call Mode: the Twilio phone transport to mount on this server. Optional. */
  phone?: PhoneApp;
  /** Text Mode: the Twilio SMS/MMS transport to mount on this server. Optional. */
  text?: TextApp;
  /** How many finished turns to keep for reconnect replay. */
  historyMax?: number;
  log?: (msg: string) => void;
}

export interface WebApp {
  httpServer: Server;
  wss: WebSocketServer;
  host: string;
  port: number;
  url: string;
  /** The shared turn engine (exposed for the phone transport + tests). */
  runner: TurnRunner;
  close: () => Promise<void>;
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = (req.url || '/').split('?')[0]!;
  let filePath: string;
  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = join(PUBLIC_DIR, 'index.html');
  } else if (urlPath === '/vendor/xterm.js') {
    filePath = join(XTERM_DIR, 'lib', 'xterm.js');
  } else if (urlPath === '/vendor/xterm.js.map') {
    filePath = join(XTERM_DIR, 'lib', 'xterm.js.map');
  } else if (urlPath === '/vendor/xterm.css') {
    filePath = join(XTERM_DIR, 'css', 'xterm.css');
  } else if (urlPath.startsWith('/lib/') && /^\/lib\/[\w.-]+\.js$/.test(urlPath)) {
    // Shared browser modules served straight from src/web (no build step).
    filePath = join(WEB_LIB_DIR, urlPath.slice('/lib/'.length));
    if (!filePath.startsWith(WEB_LIB_DIR) || !existsSync(filePath)) { res.writeHead(404).end('not found'); return; }
  } else {
    // Confine everything else to PUBLIC_DIR (no path traversal).
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    filePath = join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

export async function createWebApp(opts: WebAppOptions): Promise<WebApp> {
  const host = opts.host ?? process.env.CEOCHAT_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.CEOCHAT_PORT ?? 8420);
  const terminalPollMs = opts.terminalPollMs ?? 600;
  const log = opts.log ?? (() => {});
  const driver = opts.driver;
  const transcribe = opts.transcribe;
  const sttLabel = opts.sttLabel ?? '';
  const phone = opts.phone ?? null;
  const text = opts.text ?? null;

  await driver.start();

  // ONE turn engine shared by every transport: this web WS and (when wired) the
  // Twilio phone bridge. It owns the busy lock, the history, and the verbatim tap.
  const runner = opts.runner ?? new TurnRunner({
    driver,
    verbatim: opts.verbatim,
    historyMax: opts.historyMax,
    log,
  });

  const httpServer = createServer((req, res) => {
    // Call Mode: the Twilio voice webhook rides the same server/tunnel.
    if (phone && phone.handleHttp(req, res)) return;
    // Text Mode: the Twilio messaging webhook + the notify trigger ride it too.
    if (text && text.handleHttp(req, res)) return;
    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  // Per-connection server-side STT capture buffers (mic PCM streamed before stt-end).
  const sttBuffers = new Map<WebSocket, { chunks: Buffer[]; sampleRate: number; bytes: number }>();
  const STT_MAX_BYTES = 10 * 1024 * 1024;
  let lastTerminal = '';

  const ship = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
  };

  const pushTerminal = (force = false): void => {
    if (clients.size === 0 && !force) return;
    let snap = '';
    try { snap = driver.terminalSnapshot(); } catch { snap = ''; }
    if (!snap) return;
    if (snap === lastTerminal && !force) return;
    lastTerminal = snap;
    broadcast({ type: 'terminal', data: snap });
  };

  // Every turn event - whichever transport started the turn - broadcasts to every
  // connected browser, so the web transcript IS the in-call companion screen.
  const unsubRunner = runner.on((ev) => {
    switch (ev.type) {
      case 'status':
        broadcast({ type: 'status', state: ev.state });
        if (ev.state === 'thinking' || ev.state === 'speaking') pushTerminal();
        break;
      case 'sent':
        broadcast({ type: 'sent', turn: ev.turn, text: ev.text, source: ev.source, ts: ev.ts });
        break;
      case 'verbatim':
        broadcast({ type: 'verbatim', turn: ev.turn, text: ev.text, final: ev.final, ts: ev.ts });
        break;
      case 'narration':
        broadcast({ type: 'narration', turn: ev.turn, text: ev.text, backend: ev.backend, index: ev.index });
        break;
      case 'audio':
        broadcast({ type: 'audio', turn: ev.turn, pcm: ev.pcm.toString('base64'), sampleRate: ev.sampleRate, format: AUDIO_FORMAT, index: ev.index });
        break;
      case 'reply':
        broadcast({ type: 'reply', turn: ev.turn, text: ev.text });
        break;
      case 'notice':
        broadcast({ type: 'notice', message: ev.message });
        break;
      case 'turn-done':
        broadcast({ type: 'turn-done', turn: ev.turn, ttfbMs: ev.ttfbMs, bytes: ev.bytes });
        pushTerminal();
        break;
      case 'error':
        broadcast({ type: 'error', message: ev.message });
        break;
    }
  });

  const unsubPhone = phone
    ? phone.onState((state, detail) => broadcast({ type: 'phone', state, detail }))
    : null;

  // Re-sync a freshly-connected (refreshed) client with the conversation history so
  // it is never left blank - app-switching, screen lock, or a cellular dead zone
  // reconnects into the SAME transcript. Replayed frames carry `replay: true` so the
  // client shows them (deduped by turn) without auto-playing audio or re-running
  // anything. Audio is replayed for the newest turn only (arms the Replay button).
  function replayHistory(ws: WebSocket): void {
    const last = runner.lastTurn;
    for (const rec of runner.history) {
      ship(ws, { type: 'sent', turn: rec.turn, text: rec.sentText, source: rec.source, ts: rec.ts, replay: true });
      ship(ws, { type: 'reply', turn: rec.turn, text: rec.reply, replay: true });
      ship(ws, { type: 'verbatim', turn: rec.turn, text: rec.verbatim, final: true, ts: rec.doneTs, replay: true });
      if (rec.narration) ship(ws, { type: 'narration', turn: rec.turn, text: rec.narration, backend: rec.backend, replay: true });
    }
    if (last) {
      if (last.bytes > 0 && last.pcm.length > 0) {
        ship(ws, { type: 'audio', turn: last.turn, pcm: last.pcm.toString('base64'), sampleRate: last.sampleRate, format: AUDIO_FORMAT, replay: true });
      }
      ship(ws, { type: 'turn-done', turn: last.turn, ttfbMs: last.ttfbMs, bytes: last.bytes, replay: true });
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    const meta = driver.meta();
    ship(ws, {
      type: 'hello',
      ttsMode: meta.ttsMode,
      ttsVoice: meta.ttsVoice,
      speakBackend: meta.speakBackend,
      sampleRate: meta.sampleRate,
      audioFormat: AUDIO_FORMAT,
      serverStt: !!transcribe,
      sttLabel,
      phone: !!phone && phone.capabilities.outbound,
    });
    // Preserve awaiting-confirmation across a refresh so the §3.5 voice guard still
    // applies (a misheard "yeah" can't approve a merge just because the page reloaded).
    ship(ws, { type: 'status', state: runner.idleStatus() });
    if (lastTerminal) ship(ws, { type: 'terminal', data: lastTerminal });
    else pushTerminal(true);
    replayHistory(ws);

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }
      if (msg.type === 'send') {
        const text = (msg.text || '').trim();
        if (text) void runner.run(text, 'web');
      } else if (msg.type === 'listening') {
        broadcast({ type: 'status', state: msg.on ? 'listening' : runner.idleStatus() });
      } else if (msg.type === 'call-me') {
        if (!phone) { ship(ws, { type: 'phone', state: 'unavailable', detail: 'phone transport not configured' }); return; }
        void phone.callMe();
      } else if (msg.type === 'stt-audio') {
        if (!transcribe) return;
        let buf = sttBuffers.get(ws);
        if (!buf) { buf = { chunks: [], sampleRate: STT_SAMPLE_RATE, bytes: 0 }; sttBuffers.set(ws, buf); }
        try {
          const chunk = Buffer.from(msg.pcm || '', 'base64');
          if (buf.bytes + chunk.length > STT_MAX_BYTES) {
            sttBuffers.delete(ws);
            ship(ws, { type: 'error', message: 'capture too long - dropped; send stt-end to transcribe' });
          } else {
            buf.chunks.push(chunk);
            buf.bytes += chunk.length;
          }
        } catch { /* skip bad chunk */ }
        if (typeof msg.sampleRate === 'number' && msg.sampleRate > 0) buf.sampleRate = msg.sampleRate;
      } else if (msg.type === 'stop') {
        runner.cancel('client stop (barge-in/hangup)');
      } else if (msg.type === 'stt-cancel') {
        sttBuffers.delete(ws);
      } else if (msg.type === 'stt-end') {
        const buf = sttBuffers.get(ws);
        sttBuffers.delete(ws);
        if (!transcribe) { ship(ws, { type: 'error', message: 'server-side STT not configured - use Web Speech or type' }); return; }
        if (!buf || buf.chunks.length === 0) {
          log('stt: stt-end with 0 captured bytes (no mic frames streamed)');
          ship(ws, { type: 'transcript', text: '', final: true, empty: true, bytes: 0, reason: 'no audio captured (mic streamed 0 bytes)' });
          return;
        }
        const pcm = Buffer.concat(buf.chunks);
        const rate = buf.sampleRate;
        log(`stt: transcribing ${pcm.length} bytes @ ${rate}Hz`);
        void transcribe(pcm, rate)
          .then((text) => {
            const t = (text || '').trim();
            // ALWAYS return a transcript frame - even empty - so the client can SHOW
            // "heard nothing" rather than the mic silently swallowing the utterance.
            if (!t) {
              log(`stt: whisper returned empty for ${pcm.length} bytes`);
              ship(ws, { type: 'transcript', text: '', final: true, empty: true, bytes: pcm.length, reason: 'transcriber returned no words' });
            } else {
              log(`stt: whisper -> "${t}" (${pcm.length} bytes)`);
              ship(ws, { type: 'transcript', text: t, final: true, bytes: pcm.length });
            }
          })
          .catch((e) => {
            const m = (e as Error).message;
            log('stt: transcription FAILED: ' + m);
            ship(ws, { type: 'transcript', text: '', final: true, empty: true, bytes: pcm.length, reason: 'transcription failed: ' + m });
          });
      } else if (msg.type === 'ping') {
        ship(ws, { type: 'pong' });
      }
    });
    // NOTE: we deliberately do NOT cancel the in-flight turn when a client disconnects.
    // A page refresh mid-turn drops this socket and immediately opens a new one; the new
    // connection joins the broadcast and receives the REMAINING chunks (then a replay of
    // the finished state), so the turn is never wedged. Cancel is explicit only (`stop`).
    const onGone = (): void => { clients.delete(ws); sttBuffers.delete(ws); };
    ws.on('close', onGone);
    ws.on('error', onGone);
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url || '/').split('?')[0];
    if (path === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (phone && phone.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });

  const terminalTimer =
    terminalPollMs > 0 ? setInterval(() => pushTerminal(), terminalPollMs) : null;
  if (terminalTimer) terminalTimer.unref?.();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      if (terminalTimer) clearInterval(terminalTimer);
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}/`;
  log(`ceo-chat web server listening on ${url}`);

  return {
    httpServer,
    wss,
    host,
    port: boundPort,
    url,
    runner,
    close: () =>
      new Promise<void>((resolve) => {
        if (terminalTimer) clearInterval(terminalTimer);
        unsubRunner();
        if (unsubPhone) unsubPhone();
        if (phone) phone.close();
        for (const c of clients) { try { c.terminate(); } catch { /* ignore */ } }
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}
