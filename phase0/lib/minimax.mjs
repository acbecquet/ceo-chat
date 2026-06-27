// minimax.mjs — MiniMax streaming TTS client (INTERNATIONAL platform).
//
// Plan §6 gotchas, all baked in here so the broker inherits them:
//   1. INTERNATIONAL host:  wss://api.minimax.io/ws/v1/t2a_v2  (NOT minimaxi.com).
//   2. Auth:  Authorization: Bearer <MINIMAX_API_KEY>  header.
//   3. GroupId is a URL QUERY param  (?GroupId=...)  — NOT a header/body field.
//      This is the classic first-integration 401/400 cause.
//   4. Audio chunks are HEX-encoded (Buffer.from(hex,'hex')) — NOT base64.
//   5. Model enum: "speech-2.8-turbo" is the latency pick. "speech-2.5" appears
//      to be marketing-only; if task_start rejects the model, that's the signal
//      to fall back to "speech-2.6-turbo" (we surface the server error verbatim).
//   6. format:"pcm" → raw little-endian 16-bit mono; we wrap it in a WAV header
//      ourselves so the output is double-clickable on hub.
//
// Protocol (WebSocket): task_start -> task_continue (stream text) -> task_finish.
//   client task_start   {event, model, voice_setting, audio_setting}
//   server task_started  (ack; ready for text)
//   client task_continue {event, text}            (one or many; stream as it comes)
//   server task_continue {data:{audio:"<hex>"}, ...}   (0+ audio frames)
//   client task_finish   {event}
//   server ... is_final:true  (+ extra_info: usage characters / audio length = billing signal)
//
// TIME-TO-FIRST-AUDIO is measured from the moment we send the first task_continue
// (i.e. "text submitted") to the first non-empty decoded audio frame — the figure
// the latency budget in plan §3.3 cares about, isolated from STT/agent time.

const INTL_WS = 'wss://api.minimax.io/ws/v1/t2a_v2';

// Reasonable default voice for firstmate (a §13.6 captain decision later; cheap
// to swap). "male-qn-qingse" is a stock international system voice id.
export const DEFAULT_VOICE_ID = 'male-qn-qingse';
export const DEFAULT_MODEL = 'speech-2.8-turbo';
export const DEFAULT_SAMPLE_RATE = 32000;

// Minimal canonical 44-byte WAV header for 16-bit PCM mono.
export function wavHeader(dataLen, sampleRate = DEFAULT_SAMPLE_RATE, channels = 1) {
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

// Stream text -> MiniMax -> assembled PCM buffer.
// `textChunks`: array of strings sent as successive task_continue frames (the
//   broker will feed speakability sentences here as they stream).
// Resolves: { pcm:Buffer, ttfbMs:number|null, sampleRate, billing:object|null,
//             frames:number, events:[...] }.
// Throws on auth/protocol error (caller decides how to report).
export function synthStreaming({
  apiKey,
  groupId,
  textChunks,
  model = DEFAULT_MODEL,
  voiceId = DEFAULT_VOICE_ID,
  sampleRate = DEFAULT_SAMPLE_RATE,
  timeoutMs = 30000,
  log = () => {},
}) {
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');
  // NOTE: we intentionally do NOT hard-require groupId here — a caller may probe
  // the endpoint with a blank GroupId to learn empirically whether it is required
  // (it is, per plan §6.1). With a blank value the query param is still sent (empty).
  const url = `${INTL_WS}?GroupId=${encodeURIComponent(groupId || '')}`; // gotcha #3
  const chunks = Array.isArray(textChunks) ? textChunks : [String(textChunks)];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` }, // gotcha #2
    });

    const pcmParts = [];
    const events = [];
    let frames = 0;
    let started = false;
    let firstAudioAt = null;
    let continueSentAt = null;
    let billing = null;

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`MiniMax timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const fail = (e) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    ws.addEventListener('open', () => {
      log('ws open → task_start');
      ws.send(JSON.stringify({
        event: 'task_start',
        model,
        voice_setting: { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0 },
        audio_setting: {
          sample_rate: sampleRate,
          bitrate: 128000,
          format: 'pcm', // gotcha #6
          channel: 1,
        },
      }));
    });

    ws.addEventListener('message', (msg) => {
      let m;
      try {
        m = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString());
      } catch (e) {
        return fail(new Error('non-JSON frame from MiniMax: ' + e.message));
      }
      events.push({ event: m.event, base_resp: m.base_resp, is_final: m.is_final });

      // Surface MiniMax-level errors (bad model, bad auth, bad group, etc.).
      if (m.base_resp && m.base_resp.status_code && m.base_resp.status_code !== 0) {
        return fail(new Error(
          `MiniMax error ${m.base_resp.status_code}: ${m.base_resp.status_msg} ` +
          `(event=${m.event}) — if status mentions the model, try speech-2.6-turbo`,
        ));
      }

      if (m.event === 'connected_success') {
        // Some deployments emit this before task_started; nothing to do.
        return;
      }

      if (m.event === 'task_started' && !started) {
        started = true;
        log('task_started → streaming text');
        continueSentAt = performance.now();
        for (const t of chunks) {
          ws.send(JSON.stringify({ event: 'task_continue', text: t }));
        }
        ws.send(JSON.stringify({ event: 'task_finish' }));
      }

      // Audio frames can ride on task_started or task_continue events.
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

      // extra_info carries the billing/usage signal (characters, audio length).
      if (m.extra_info) billing = m.extra_info;

      if (m.is_final) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        const pcm = Buffer.concat(pcmParts);
        const ttfbMs =
          firstAudioAt != null && continueSentAt != null
            ? Math.round(firstAudioAt - continueSentAt)
            : null;
        resolve({ pcm, ttfbMs, sampleRate, billing, frames, events });
      }
    });

    ws.addEventListener('error', (e) => fail(new Error('ws error: ' + (e.message || 'unknown'))));
    ws.addEventListener('close', () => clearTimeout(timer));
  });
}
