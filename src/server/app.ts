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

import { WS_PATH, AUDIO_FORMAT, type ServerMessage, type ClientMessage, type UiStatus } from './protocol.ts';
import type { Driver } from './driver.ts';
import type { PipelineStage } from '../broker/pipeline.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const REPO_ROOT = join(HERE, '..', '..');
const XTERM_DIR = join(REPO_ROOT, 'node_modules', '@xterm', 'xterm');

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

  await driver.start();

  const httpServer = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let turn = 0;
  let busy = false;
  let lastTerminal = '';

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
    try {
      const result = await driver.send(text, myTurn, {
        onStage: (stage) => {
          const st = statusForStage(stage);
          if (st) broadcastStatus(st);
          if (stage === 'reply' || stage === 'synth') pushTerminal();
        },
      });
      broadcast({ type: 'reply', turn: myTurn, text: result.reply });
      broadcast({ type: 'narration', turn: myTurn, text: result.narration, backend: result.speakBackend });
      broadcast({
        type: 'audio',
        turn: myTurn,
        pcm: result.audio.pcm.toString('base64'),
        sampleRate: result.audio.sampleRate,
        format: AUDIO_FORMAT,
      });
      broadcast({ type: 'turn-done', turn: myTurn, ttfbMs: result.audio.ttfbMs, bytes: result.audio.bytes });
      // Speaking happens client-side; once audio is delivered, reflect whether the
      // captain now owes an answer (the narration asks a question) or we are idle.
      broadcastStatus(/\?/.test(result.narration) ? 'awaiting-confirmation' : 'idle');
      pushTerminal();
    } catch (e) {
      broadcast({ type: 'error', message: (e as Error).message });
      broadcastStatus('idle');
    } finally {
      busy = false;
    }
  }

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    const meta = driver.meta();
    ship(ws, {
      type: 'hello',
      ttsMode: meta.ttsMode,
      speakBackend: meta.speakBackend,
      sampleRate: meta.sampleRate,
      audioFormat: AUDIO_FORMAT,
    });
    ship(ws, { type: 'status', state: busy ? 'thinking' : 'idle' });
    if (lastTerminal) ship(ws, { type: 'terminal', data: lastTerminal });
    else pushTerminal(true);

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }
      if (msg.type === 'send') {
        const text = (msg.text || '').trim();
        if (text) void runTurn(ws, text);
      } else if (msg.type === 'listening') {
        broadcastStatus(msg.on ? 'listening' : (busy ? 'thinking' : 'idle'));
      } else if (msg.type === 'ping') {
        ship(ws, { type: 'pong' });
      }
    });
    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url || '/').split('?')[0];
    if (path !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const terminalTimer =
    terminalPollMs > 0 ? setInterval(() => pushTerminal(), terminalPollMs) : null;
  if (terminalTimer) terminalTimer.unref?.();

  await new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()));
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
