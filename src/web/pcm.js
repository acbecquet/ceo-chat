// pcm.js — portable PCM/byte helpers shared by the browser client AND the Node
// validation harness. DOM-free and environment-agnostic on purpose: base64 is
// decoded/encoded by hand (NOT atob/btoa or Buffer) so the SAME function runs
// identically in iOS Safari and in `npm run validate`, and the harness can assert
// the exact bytes the player will feed to Web Audio.
//
// Audio over the wire is base64 PCM s16le mono (protocol.AUDIO_FORMAT). Web Audio
// wants Float32 samples in [-1, 1). For the (optional) server-side STT fallback we
// also downsample mic audio to 16 kHz s16le here.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const inv = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) inv[B64.charCodeAt(i)] = i;
  return inv;
})();

/** Decode a base64 string to a Uint8Array (no atob — identical in browser & Node). */
export function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const len = s.length;
  const pad = len > 0 && s.length % 4 !== 0 ? 0 : 0; // tolerated below
  void pad;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_INV[s.charCodeAt(i)] | 0;
    const c1 = B64_INV[s.charCodeAt(i + 1)] | 0;
    const c2 = i + 2 < len ? B64_INV[s.charCodeAt(i + 2)] | 0 : -1;
    const c3 = i + 3 < len ? B64_INV[s.charCodeAt(i + 3)] | 0 : -1;
    const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (c2 >= 0 && o < outLen) out[o++] = (n >> 8) & 0xff;
    if (c3 >= 0 && o < outLen) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

/** Encode a Uint8Array to base64 (no btoa — for the STT mic upload path). */
export function bytesToBase64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Reinterpret raw s16le bytes as Float32 samples in [-1, 1) for Web Audio. */
export function pcmS16leToFloat32(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const frames = b.length >> 1;
  const out = new Float32Array(frames);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < frames; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Float32 samples in [-1, 1] -> raw s16le bytes (for the STT mic upload path). */
export function float32ToPcmS16le(float32) {
  const n = float32.length;
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    let s = float32[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(i * 2, Math.round(s * 32767), true);
  }
  return out;
}

/**
 * Linear-resample Float32 audio from srcRate to dstRate (default 16 kHz). Good
 * enough for ASR; the mic typically delivers 44.1/48 kHz and Whisper-class models
 * want 16 kHz mono. Returns the source unchanged when rates already match.
 */
export function downsampleFloat32(float32, srcRate, dstRate = 16000) {
  if (!srcRate || srcRate === dstRate) return float32;
  if (dstRate > srcRate) return float32; // never upsample — caller passes real mic rate
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(float32.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let cnt = 0;
    for (let j = start; j < end; j++) { sum += float32[j]; cnt++; }
    out[i] = cnt ? sum / cnt : float32[start] || 0;
  }
  return out;
}
