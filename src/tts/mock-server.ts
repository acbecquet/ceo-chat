// mock-server.ts — an in-process MiniMax T2A server that speaks the REAL protocol.
//
// A first-class product component used in two places: `npm run validate` asserts the
// audio path against it, AND the broker stands it up as the creds-free TTS backend so
// the captain gets real WAV output before the live key is added. It mirrors the live
// service exactly: same WebSocket handshake (Authorization: Bearer, GroupId in the
// URL query), same event sequence (task_start -> task_started -> task_continue audio
// frames -> final), same HEX-encoded PCM payloads. It returns synthetic sine-wave PCM
// so audio-path assertions are real bytes, not stubs.
//
// It also records exactly what the client sent (auth header, GroupId, event order,
// text chunks) so the harness can assert the client honoured the protocol, and it
// can be configured to reproduce the bugs we regression-guard:
//   - audioOnStarted: ride the first audio frame on the task_started ack
//     (the "task_started audio-drop" scenario), and
//   - failWith: emit a base_resp error (e.g. 1004 auth / 1008 balance) like live.

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MockObserved {
  authHeader: string | undefined;
  groupId: string | null;
  path: string;
  clientEvents: string[];
  textChunks: string[];
  /** voice_id seen in the task_start voice_setting (proves the cloned voice flows through). */
  voiceId: string | null;
}

export interface MockMinimaxOptions {
  /** Put the FIRST audio frame on the task_started ack (regression scenario). */
  audioOnStarted?: boolean;
  /** Emit a `connected_success` frame before task_started (some real deployments do). */
  emitConnectedSuccess?: boolean;
  /** Emit a base_resp error instead of audio (simulate live 1004/1008). */
  failWith?: { status_code: number; status_msg: string };
  /** Bytes of synthetic PCM per task_continue text chunk. */
  pcmBytesPerChunk?: number;
  sampleRate?: number;
}

export interface MockMinimax {
  endpoint: string;
  port: number;
  observed: MockObserved;
  close: () => Promise<void>;
}

// 16-bit little-endian mono sine wave — synthetic but valid PCM, so the WAV the
// pipeline writes is actually audible.
function sinePcm(bytes: number, sampleRate: number, freq = 330): Buffer {
  const samples = Math.max(2, Math.floor(bytes / 2));
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

export function startMockMinimax(opts: MockMinimaxOptions = {}): Promise<MockMinimax> {
  const {
    audioOnStarted = false,
    emitConnectedSuccess = false,
    failWith,
    pcmBytesPerChunk = 4096,
    sampleRate = 32000,
  } = opts;

  const observed: MockObserved = {
    authHeader: undefined,
    groupId: null,
    path: '',
    clientEvents: [],
    textChunks: [],
    voiceId: null,
  };

  return new Promise<MockMinimax>((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        endpoint: `ws://127.0.0.1:${port}/ws/v1/t2a_v2`,
        port,
        observed,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } }
            wss.close(() => res());
          }),
      });
    });

    wss.on('connection', (sock: WebSocket, req: IncomingMessage) => {
      observed.authHeader = req.headers['authorization'] as string | undefined;
      const url = new URL(req.url || '/', 'http://localhost');
      observed.groupId = url.searchParams.get('GroupId');
      observed.path = url.pathname;

      const send = (obj: unknown): void => sock.send(JSON.stringify(obj));
      const audioFrame = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        event: 'task_continue',
        data: { audio: sinePcm(pcmBytesPerChunk, sampleRate).toString('hex') }, // HEX, not base64
        ...extra,
      });

      sock.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let m: { event?: string; text?: string; voice_setting?: { voice_id?: string } };
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (m.event) observed.clientEvents.push(m.event);

        if (m.event === 'task_start') {
          if (m.voice_setting && typeof m.voice_setting.voice_id === 'string') {
            observed.voiceId = m.voice_setting.voice_id;
          }
          if (failWith) {
            send({ event: 'task_failed', base_resp: { status_code: failWith.status_code, status_msg: failWith.status_msg } });
            return;
          }
          if (emitConnectedSuccess) send({ event: 'connected_success', base_resp: { status_code: 0, status_msg: 'success' } });
          // The ack — optionally carrying the first audio frame (regression case).
          if (audioOnStarted) {
            send({ event: 'task_started', base_resp: { status_code: 0, status_msg: 'success' }, data: { audio: sinePcm(pcmBytesPerChunk, sampleRate).toString('hex') } });
          } else {
            send({ event: 'task_started', base_resp: { status_code: 0, status_msg: 'success' } });
          }
          return;
        }

        if (m.event === 'task_continue') {
          observed.textChunks.push(m.text ?? '');
          if (!failWith) send(audioFrame());
          return;
        }

        if (m.event === 'task_finish') {
          if (failWith) return;
          send({
            event: 'task_finished',
            is_final: true,
            base_resp: { status_code: 0, status_msg: 'success' },
            extra_info: {
              audio_length: observed.textChunks.join('').length * 60,
              usage_characters: observed.textChunks.join('').length,
            },
          });
        }
      });
    });
  });
}

// ─────────────────────────── voice-clone REST mock ─────────────────────────
// The cloning pipeline (src/tts/voice-clone.ts) uses the MiniMax REST API, not the
// WS T2A protocol: it uploads a reference file then registers a clone. This is a
// REAL in-process HTTP server speaking those two endpoints exactly as live does
// (POST /v1/files/upload multipart -> {file:{file_id}}; POST /v1/voice_clone JSON
// {file_id,voice_id} -> {voice_id}), with the SAME auth (Authorization: Bearer) and
// GroupId-in-query convention. It records what the client sent so the harness can
// assert the client honoured the protocol — and can be made to fail like live
// (1004 auth / bad GroupId) via failWith. No multipart library: we scan the raw
// body for the form fields, which is enough to prove the client serialized them.

export interface MockRestObserved {
  upload: {
    authHeader: string | undefined;
    groupId: string | null;
    path: string;
    method: string;
    contentType: string | undefined;
    /** purpose form field value the client sent (e.g. "voice_clone"). */
    purpose: string | null;
    /** true if a `file` form part was present in the multipart body. */
    hasFilePart: boolean;
    fileName: string | null;
    /** raw multipart body byte length (the reference audio rode through). */
    bodyBytes: number;
  } | null;
  clone: {
    authHeader: string | undefined;
    groupId: string | null;
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  } | null;
}

export interface MockRestOptions {
  /** Emit a base_resp error from both endpoints (simulate 1004 auth / bad GroupId). */
  failWith?: { status_code: number; status_msg: string };
  /** file_id the upload endpoint returns. */
  fileId?: string;
}

export interface MockRest {
  baseUrl: string;
  port: number;
  observed: MockRestObserved;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });
}

// Pull a value out of a multipart/form-data body without a parser: find the part
// whose Content-Disposition names `field` and return the text after the blank line.
function multipartField(body: string, field: string): string | null {
  const re = new RegExp(`name="${field}"\\r\\n\\r\\n([^\\r]*)`);
  const m = body.match(re);
  return m && m[1] != null ? m[1] : null;
}
function multipartFileName(body: string): string | null {
  const m = body.match(/name="file"[^\r\n]*filename="([^"]*)"/);
  return m && m[1] != null ? m[1] : null;
}

export function startMockMinimaxRest(opts: MockRestOptions = {}): Promise<MockRest> {
  const { failWith, fileId = 'mock-file-0001' } = opts;
  const observed: MockRestObserved = { upload: null, clone: null };

  return new Promise<MockRest>((resolve) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const groupId = url.searchParams.get('GroupId');
      const auth = req.headers['authorization'] as string | undefined;
      const json = (obj: unknown): void => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      void (async () => {
        const raw = await readBody(req);
        if (url.pathname === '/v1/files/upload' && req.method === 'POST') {
          const body = raw.toString('latin1');
          observed.upload = {
            authHeader: auth,
            groupId,
            path: url.pathname,
            method: req.method || '',
            contentType: req.headers['content-type'] as string | undefined,
            purpose: multipartField(body, 'purpose'),
            hasFilePart: /name="file"/.test(body),
            fileName: multipartFileName(body),
            bodyBytes: raw.length,
          };
          if (failWith) return json({ base_resp: failWith });
          return json({ file: { file_id: fileId }, base_resp: { status_code: 0, status_msg: 'success' } });
        }
        if (url.pathname === '/v1/voice_clone' && req.method === 'POST') {
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
          observed.clone = {
            authHeader: auth,
            groupId,
            path: url.pathname,
            method: req.method || '',
            body: parsed,
          };
          if (failWith) return json({ base_resp: failWith });
          const voiceId = parsed && typeof parsed.voice_id === 'string' ? parsed.voice_id : '';
          return json({ voice_id: voiceId, base_resp: { status_code: 0, status_msg: 'success' } });
        }
        res.statusCode = 404;
        json({ base_resp: { status_code: 1004, status_msg: 'unknown endpoint' } });
      })();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        observed,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
