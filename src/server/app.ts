// app.ts — the ceo-chat web transport: one HTTP server that serves the single-page
// browser UI and brokers the pipeline over a same-origin WebSocket.
//
// It is deliberately decoupled from tmux/claude: it talks to a Driver (driver.ts).
// The product passes a BrokerDriver (real session); `npm run validate` passes an
// in-memory driver over the same runPipeline. So this file — the static serving, the
// WS contract, status indicators, terminal streaming, turn serialization — is
// asserted end-to-end with NO creds and NO agent session.
//
// Tunnel-ready: plain HTTP on localhost (Cloudflare terminates TLS at the named
// tunnel), and the browser upgrades to a RELATIVE same-origin ws(s):// — so the same
// build works on http://127.0.0.1:<port> and through wss://ceo-chat.acb-apps.com.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { WS_PATH, AUDIO_FORMAT, STT_SAMPLE_RATE, type ServerMessage, type ClientMessage, type UiStatus } from './protocol.ts';
import type { Driver } from './driver.ts';
import type { PipelineStage } from '../broker/pipeline.ts';

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
  log?: (msg: string) => void;
}

export interface WebApp {
  httpServer: Server;
  wss: WebSocketServer;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

// Stage -> status mapping. synth = audio is being produced (speaking); the rest of
// the work (inject/read/rewrite) reads to the captain as "thinking".
function statusForStage(stage: PipelineStage): UiStatus | null {
  switch (stage) {
    case 'inject':
    case 'reply':
    case 'speak':
      return 'thinking';
    case 'synth':
      return 'speaking';
    case 'done':
      return null; // resolved after the turn (idle vs awaiting-confirmation)
  }
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

  await driver.start();

  const httpServer = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  // Per-connection server-side STT capture buffers (mic PCM streamed before stt-end).
  const sttBuffers = new Map<WebSocket, { chunks: Buffer[]; sampleRate: number; bytes: number }>();
  const STT_MAX_BYTES = 10 * 1024 * 1024;
  let turn = 0;
  let busy = false;
  let lastTerminal = '';
  // Cancellation for the in-flight turn (explicit barge-in / hangup via `stop`).
  let currentSignal: { aborted: boolean } | null = null;
  // Last completed turn's state, so a client that refreshes mid/post-turn is re-synced
  // instead of left blank (the captain's "nothing after refresh" dead-end).
  let lastTurnState:
    | { turn: number; reply: string; narration: string; backend: string; pcm: string; sampleRate: number; ttfbMs: number | null; bytes: number }
    | null = null;

  const ship = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
  };
  const broadcastStatus = (state: UiStatus): void => broadcast({ type: 'status', state });

  const pushTerminal = (force = false): void => {
    if (clients.size === 0 && !force) return;
    let snap = '';
    try { snap = driver.terminalSnapshot(); } catch { snap = ''; }
    if (!snap) return;
    if (snap === lastTerminal && !force) return;
    lastTerminal = snap;
    broadcast({ type: 'terminal', data: snap });
  };

  async function runTurn(ws: WebSocket, text: string): Promise<void> {
    if (busy) {
      ship(ws, { type: 'error', message: 'a turn is already in progress — one at a time' });
      return;
    }
    busy = true;
    const myTurn = ++turn;
    const signal = { aborted: false };
    currentSignal = signal;
    let chunks = 0;
    try {
      const result = await driver.send(text, myTurn, {
        onStage: (stage) => {
          const st = statusForStage(stage);
          if (st) broadcastStatus(st);
          if (stage === 'reply' || stage === 'synth') pushTerminal();
        },
        // Progressive: broadcast each speakable unit's narration + audio AS it is ready,
        // so the captain hears the first sentence ~1s in. The client queues audio frames
        // gaplessly. Aborted turns emit nothing further.
        onChunk: (c) => {
          if (signal.aborted) return;
          chunks++;
          broadcast({ type: 'narration', turn: myTurn, text: c.narration, backend: c.speakBackend, index: c.index });
          broadcast({ type: 'audio', turn: myTurn, pcm: c.pcm.toString('base64'), sampleRate: c.sampleRate, format: AUDIO_FORMAT, index: c.index });
        },
        onNotice: (message) => broadcast({ type: 'notice', message }),
        signal,
      });
      if (signal.aborted) { broadcastStatus('idle'); return; }
      // The full raw reply (transcript column) lands at the end.
      broadcast({ type: 'reply', turn: myTurn, text: result.reply });
      // Legacy/in-memory drivers don't stream chunks — fall back to the aggregate frames
      // so the page still gets one narration + audio (and tests stay valid).
      if ((result.chunks ?? chunks) === 0) {
        broadcast({ type: 'narration', turn: myTurn, text: result.narration, backend: result.speakBackend });
        broadcast({ type: 'audio', turn: myTurn, pcm: result.audio.pcm.toString('base64'), sampleRate: result.audio.sampleRate, format: AUDIO_FORMAT });
      }
      broadcast({ type: 'turn-done', turn: myTurn, ttfbMs: result.audio.ttfbMs, bytes: result.audio.bytes });
      lastTurnState = {
        turn: myTurn, reply: result.reply, narration: result.narration, backend: result.speakBackend,
        pcm: result.audio.pcm.toString('base64'), sampleRate: result.audio.sampleRate,
        ttfbMs: result.audio.ttfbMs, bytes: result.audio.bytes,
      };
      broadcastStatus(/\?/.test(result.narration) ? 'awaiting-confirmation' : 'idle');
      pushTerminal();
    } catch (e) {
      broadcast({ type: 'error', message: (e as Error).message });
      broadcastStatus('idle');
    } finally {
      busy = false;
      currentSignal = null;
    }
  }

  // Re-sync a freshly-connected (refreshed) client with the last completed turn so it is
  // never left blank. Replayed frames carry `replay: true` so the client SHOWS them and
  // arms Replay without auto-playing audio or re-running anything.
  function replayLastTurn(ws: WebSocket): void {
    const s = lastTurnState;
    if (!s) return;
    ship(ws, { type: 'reply', turn: s.turn, text: s.reply, replay: true });
    if (s.narration) ship(ws, { type: 'narration', turn: s.turn, text: s.narration, backend: s.backend, replay: true });
    if (s.bytes > 0) ship(ws, { type: 'audio', turn: s.turn, pcm: s.pcm, sampleRate: s.sampleRate, format: AUDIO_FORMAT, replay: true });
    ship(ws, { type: 'turn-done', turn: s.turn, ttfbMs: s.ttfbMs, bytes: s.bytes, replay: true });
  }

  function cancelCurrentTurn(reason: string): void {
    if (currentSignal && !currentSignal.aborted) {
      currentSignal.aborted = true;
      log('turn cancelled: ' + reason);
      broadcastStatus('idle');
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
    });
    // Preserve awaiting-confirmation across a refresh so the §3.5 voice guard still
    // applies (a misheard "yeah" can't approve a merge just because the page reloaded).
    const idleState: UiStatus =
      lastTurnState && /\?/.test(lastTurnState.narration) ? 'awaiting-confirmation' : 'idle';
    ship(ws, { type: 'status', state: busy ? 'thinking' : idleState });
    if (lastTerminal) ship(ws, { type: 'terminal', data: lastTerminal });
    else pushTerminal(true);
    // Re-sync a refreshed client with the last turn so it is never left blank.
    replayLastTurn(ws);

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }
      if (msg.type === 'send') {
        const text = (msg.text || '').trim();
        if (text) void runTurn(ws, text);
      } else if (msg.type === 'listening') {
        broadcastStatus(msg.on ? 'listening' : (busy ? 'thinking' : 'idle'));
      } else if (msg.type === 'stt-audio') {
        if (!transcribe) return;
        let buf = sttBuffers.get(ws);
        if (!buf) { buf = { chunks: [], sampleRate: STT_SAMPLE_RATE, bytes: 0 }; sttBuffers.set(ws, buf); }
        try {
          const chunk = Buffer.from(msg.pcm || '', 'base64');
          if (buf.bytes + chunk.length > STT_MAX_BYTES) {
            sttBuffers.delete(ws);
            ship(ws, { type: 'error', message: 'capture too long — dropped; send stt-end to transcribe' });
          } else {
            buf.chunks.push(chunk);
            buf.bytes += chunk.length;
          }
        } catch { /* skip bad chunk */ }
        if (typeof msg.sampleRate === 'number' && msg.sampleRate > 0) buf.sampleRate = msg.sampleRate;
      } else if (msg.type === 'stop') {
        cancelCurrentTurn('client stop (barge-in/hangup)');
      } else if (msg.type === 'stt-cancel') {
        sttBuffers.delete(ws);
      } else if (msg.type === 'stt-end') {
        const buf = sttBuffers.get(ws);
        sttBuffers.delete(ws);
        if (!transcribe) { ship(ws, { type: 'error', message: 'server-side STT not configured — use Web Speech or type' }); return; }
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
            // ALWAYS return a transcript frame — even empty — so the client can SHOW
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
    if (path !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
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
    close: () =>
      new Promise<void>((resolve) => {
        if (terminalTimer) clearInterval(terminalTimer);
        for (const c of clients) { try { c.terminate(); } catch { /* ignore */ } }
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}
