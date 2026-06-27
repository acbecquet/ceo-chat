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
import type { IncomingMessage } from 'node:http';

export interface MockObserved {
  authHeader: string | undefined;
  groupId: string | null;
  path: string;
  clientEvents: string[];
  textChunks: string[];
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
        let m: { event?: string; text?: string };
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (m.event) observed.clientEvents.push(m.event);

        if (m.event === 'task_start') {
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
