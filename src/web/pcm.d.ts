// Types for pcm.js — the portable PCM/byte helpers (browser + Node harness).
export function base64ToBytes(b64: string): Uint8Array;
export function bytesToBase64(bytes: Uint8Array | ArrayLike<number>): string;
export function pcmS16leToFloat32(bytes: Uint8Array): Float32Array;
export function float32ToPcmS16le(float32: Float32Array | number[]): Uint8Array;
export function wavBytesFromPcm(
  pcmBytes: Uint8Array | ArrayLike<number>,
  sampleRate?: number,
  channels?: number,
  bitsPerSample?: number,
): Uint8Array;
export function downsampleFloat32(
  float32: Float32Array,
  srcRate: number,
  dstRate?: number,
): Float32Array;
