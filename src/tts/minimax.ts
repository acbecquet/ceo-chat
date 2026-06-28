// minimax.ts — MiniMax streaming TTS client (INTERNATIONAL platform).
//
// Plan §6 gotchas, all baked in here so the broker inherits them:
//   1. INTERNATIONAL host:  wss://api.minimax.io/ws/v1/t2a_v2  (NOT minimaxi.com).
//   2. Auth:  Authorization: Bearer <MINIMAX_API_KEY>  header.
//   3. GroupId is a URL QUERY param  (?GroupId=...)  — NOT a header/body field.
//   4. Audio chunks are HEX-encoded (Buffer.from(hex,'hex')) — NOT base64.
//   5. Model enum: "speech-2.8-turbo" is the latency pick. If task_start rejects the
//      model, fall back to "speech-2.6-turbo" (we surface the server error verbatim).
//   6. format:"pcm" -> raw little-endian 16-bit mono; we wrap it in a WAV header.
//
// Protocol (WebSocket): task_start -> task_continue (stream text) -> task_finish.
//   client task_start    {event, model, voice_setting, audio_setting}
//   server task_started   (ack; ready for text)
//   client task_continue  {event, text}                  (one or many)
//   server task_continue  {data:{audio:"<hex>"}, ...}    (0+ audio frames)
//   client task_finish    {event}
//   server ... is_final:true  (+ extra_info: usage = billing signal)
//
// BUG-FIX (regression-guarded): audio frames can ride on the SAME message as the
// `task_started` ack OR on later events. We therefore harvest `m.data.audio` on
// EVERY frame, not only inside the task_continue branch — otherwise the first audio
// chunk is silently DROPPED ("task_started audio-drop" bug). See test/legs.
//
// TIME-TO-FIRST-AUDIO is measured from the first task_continue ("text submitted")
// to the first non-empty decoded audio frame — the figure plan §3.3 cares about.

export const INTL_WS = 'wss://api.minimax.io/ws/v1/t2a_v2';

// Reasonable default international system voice. Cheap to swap (plan §13.6).
export const DEFAULT_VOICE_ID = 'male-qn-qingse';
export const DEFAULT_MODEL = 'speech-2.8-turbo';
export const DEFAULT_SAMPLE_RATE = 32000;

export interface SynthResult {
  pcm: Buffer;
  ttfbMs: number | null;
  sampleRate: number;
  billing: Record<string, unknown> | null;
  frames: number;
  events: Array<{ event?: string; base_resp?: unknown; is_final?: boolean }>;
}

export interface SynthOptions {
  apiKey: string;
  groupId?: string;
  textChunks: string[] | string;
  model?: string;
  voiceId?: string;
  sampleRate?: number;
  timeoutMs?: number;
  /** Override the WS endpoint — the harness points this at the in-process mock. */
  endpoint?: string;
  log?: (msg: string) => void;
}

// A MiniMax server frame (only the fields we read are typed).
interface MinimaxFrame {
  event?: string;
  base_resp?: { status_code?: number; status_msg?: string };
  data?: { audio?: string };
  extra_info?: Record<string, unknown>;
  is_final?: boolean;
}

// Minimal canonical 44-byte WAV header for 16-bit PCM mono.
export function wavHeader(
  dataLen: number,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
  channels = 1,
): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM fmt chunk size
  h.writeUInt16LE(1, 20); // audio format = PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

// Convenience: assemble a complete, double-clickable WAV from a SynthResult.
export function toWav(result: Pick<SynthResult, 'pcm' | 'sampleRate'>): Buffer {
  return Buffer.concat([wavHeader(result.pcm.length, result.sampleRate), result.pcm]);
}

export interface ParsedWav {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

// Parse a 16-bit PCM WAV (the shape piper / our own toWav emit) into raw samples.
// Walks the RIFF chunk list rather than assuming a fixed 44-byte header, so it
// tolerates extra chunks (LIST/fact) some encoders insert before `data`. Throws on
// a non-PCM / non-16-bit file (we only ever feed it our own + piper output).
export function parseWav(buf: Buffer): ParsedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let pcm: Buffer | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      pcm = buf.subarray(body, Math.min(buf.length, body + size));
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error(`unsupported WAV (format=${audioFormat}, bits=${bitsPerSample}); expected 16-bit PCM`);
  }
  if (!pcm) throw new Error('WAV has no data chunk');
  return { pcm, sampleRate, channels, bitsPerSample };
}

// The global undici WebSocket accepts a Node-only `{ headers }` option that the
// WHATWG type omits — narrow it here rather than scatter `any` casts.
type WsCtor = new (url: string, opts?: { headers?: Record<string, string> }) => WsLike;
interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', cb: (ev: { message?: string; error?: { message?: string } }) => void): void;
  addEventListener(type: 'close', cb: () => void): void;
}

// Stream text -> MiniMax -> assembled PCM buffer.
// Throws on auth/protocol error (caller decides how to report).
export function synthStreaming(opts: SynthOptions): Promise<SynthResult> {
  const {
    apiKey,
    groupId,
    textChunks,
    model = DEFAULT_MODEL,
    voiceId = DEFAULT_VOICE_ID,
    sampleRate = DEFAULT_SAMPLE_RATE,
    timeoutMs = 30000,
    endpoint = INTL_WS,
    log = () => {},
  } = opts;

  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');
  // We intentionally do NOT hard-require groupId — a caller may probe with a blank
  // GroupId to learn empirically whether it is required (it is not, for WS auth —
  // plan §6.1). The query param is still sent (possibly empty).
  const url = `${endpoint}?GroupId=${encodeURIComponent(groupId || '')}`; // gotcha #3
  const chunks = Array.isArray(textChunks) ? textChunks : [String(textChunks)];

  return new Promise<SynthResult>((resolve, reject) => {
    const WS = WebSocket as unknown as WsCtor;
    const ws = new WS(url, { headers: { Authorization: `Bearer ${apiKey}` } }); // gotcha #2

    const pcmParts: Buffer[] = [];
    const events: SynthResult['events'] = [];
    let frames = 0;
    let started = false;
    let firstAudioAt: number | null = null;
    let continueSentAt: number | null = null;
    let billing: Record<string, unknown> | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      fail(new Error(`MiniMax timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function fail(e: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      reject(e instanceof Error ? e : new Error(String(e)));
    }

    function done(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      const pcm = Buffer.concat(pcmParts);
      const ttfbMs =
        firstAudioAt != null && continueSentAt != null
          ? Math.round(firstAudioAt - continueSentAt)
          : null;
      resolve({ pcm, ttfbMs, sampleRate, billing, frames, events });
    }

    ws.addEventListener('open', () => {
      log('ws open -> task_start');
      ws.send(JSON.stringify({
        event: 'task_start',
        model,
        voice_setting: { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0 },
        audio_setting: { sample_rate: sampleRate, bitrate: 128000, format: 'pcm', channel: 1 },
      }));
    });

    ws.addEventListener('message', (msg: { data: unknown }) => {
      let m: MinimaxFrame;
      try {
        const raw = typeof msg.data === 'string' ? msg.data : String(msg.data);
        m = JSON.parse(raw) as MinimaxFrame;
      } catch (e) {
        return fail(new Error('non-JSON frame from MiniMax: ' + (e as Error).message));
      }
      events.push({ event: m.event, base_resp: m.base_resp, is_final: m.is_final });

      // Surface MiniMax-level errors (bad model, bad auth, bad group, no balance).
      if (m.base_resp && m.base_resp.status_code && m.base_resp.status_code !== 0) {
        return fail(new Error(
          `MiniMax error ${m.base_resp.status_code}: ${m.base_resp.status_msg} ` +
          `(event=${m.event}) — if status mentions the model, try speech-2.6-turbo`,
        ));
      }

      if (m.event === 'connected_success') return; // some deployments emit this first

      if (m.event === 'task_started' && !started) {
        started = true;
        log('task_started -> streaming text');
        continueSentAt = performance.now();
        for (const t of chunks) ws.send(JSON.stringify({ event: 'task_continue', text: t }));
        ws.send(JSON.stringify({ event: 'task_finish' }));
      }

      // BUG-FIX: harvest audio on EVERY frame (it can ride on task_started).
      const hex = m.data && m.data.audio;
      if (hex) {
        const buf = Buffer.from(hex, 'hex'); // gotcha #4 (hex, not base64)
        if (buf.length) {
          if (firstAudioAt == null) {
            firstAudioAt = performance.now();
            log(`first audio frame (${buf.length} bytes)`);
          }
          pcmParts.push(buf);
          frames++;
        }
      }

      if (m.extra_info) billing = m.extra_info; // usage = billing signal
      if (m.is_final) done();
    });

    ws.addEventListener('error', (e: { message?: string; error?: { message?: string } }) =>
      fail(new Error('ws error: ' + (e.error?.message || e.message || 'connection failed before any frame'))));
    ws.addEventListener('close', () => {
      if (settled) { clearTimeout(timer); return; }
      if (frames > 0) done();
      else fail(new Error('MiniMax closed before completing the task'));
    });
  });
}
