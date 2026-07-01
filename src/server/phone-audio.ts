// phone-audio.ts - pure audio transcode helpers for the Twilio phone leg.
//
// Twilio Media Streams speak ONE wire format in BOTH directions: 8000 Hz, 8-bit
// mono G.711 mu-law, base64 in `media.payload`, with NO header bytes (plan §1).
// Everything below the transport seam is 16-bit s16le PCM at the TTS backend's
// native rate (MiniMax 32k / piper 22.05k), so the phone shell needs exactly one
// transcode step each way:
//
//   outbound: PipelineChunk pcm s16le@sr -> downsample 8k -> mu-law -> base64
//   inbound:  base64 -> mu-law decode -> s16le@8k -> (upsample 16k) -> whisper
//
// The resampler for the DOWN direction is the SAME shared helper the browser mic
// path uses (src/web/pcm.js#downsampleFloat32 - one resampler, harness-asserted).
// That helper deliberately never UPsamples, and whisper.cpp requires 16 kHz - so
// the up direction (8k phone audio -> 16k) gets a small linear-interp upsampler
// here, asserted by the phone validation leg.
//
// All functions are pure (no I/O, no globals) so `npm run validate` proves the
// exact bytes that ride the Twilio wire with no Twilio account.

import {
  pcmS16leToFloat32, float32ToPcmS16le, downsampleFloat32,
} from '../web/pcm.js';

/** The Twilio Media Streams wire rate (both directions). */
export const PHONE_SAMPLE_RATE = 8000;
/** One Twilio media frame is 20ms of audio = 160 mu-law bytes at 8 kHz. */
export const PHONE_FRAME_BYTES = 160;

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

/** Encode one linear s16 sample to a G.711 mu-law byte. */
export function linearToMulawSample(sample: number): number {
  let s = sample | 0;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one G.711 mu-law byte to a linear s16 sample. */
export function mulawToLinearSample(mulaw: number): number {
  const u = ~mulaw & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  if (sign) sample = -sample;
  return sample;
}

/** Encode s16le PCM bytes -> mu-law bytes (half the size, no header). */
export function pcmS16leToMulaw(pcm: Uint8Array): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = pcm.byteLength >> 1;
  const out = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) out[i] = linearToMulawSample(view.getInt16(i * 2, true));
  return out;
}

/** Decode mu-law bytes -> s16le PCM bytes (twice the size). */
export function mulawToPcmS16le(mulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(mulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mulaw.length; i++) view.setInt16(i * 2, mulawToLinearSample(mulaw[i]!), true);
  return out;
}

/**
 * Linear-interpolation UPsample (e.g. 8 kHz phone audio -> the 16 kHz whisper
 * needs). The shared downsampleFloat32 deliberately refuses to upsample, so the
 * phone leg owns this one small counterpart. Returns the input unchanged when the
 * rates already match.
 */
export function upsampleFloat32(float32: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (!srcRate || srcRate === dstRate) return float32;
  if (dstRate < srcRate) return float32; // this helper only goes UP - use downsampleFloat32
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(float32.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = (float32[i0] ?? 0) * (1 - frac) + (float32[i1] ?? 0) * frac;
  }
  return out;
}

/**
 * Outbound transcode: one pipeline chunk of s16le PCM at `sampleRate` -> 8 kHz
 * mu-law bytes ready to base64 into Twilio `media.payload` (no header bytes).
 */
export function pcmChunkToPhoneMulaw(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const f32 = pcmS16leToFloat32(pcm);
  const down = downsampleFloat32(f32, sampleRate, PHONE_SAMPLE_RATE);
  return pcmS16leToMulaw(float32ToPcmS16le(down));
}

/**
 * Inbound transcode: Twilio mu-law bytes -> s16le PCM at 16 kHz, the rate the
 * whisper Transcriber requires (its own resampler never upsamples, so we hand it
 * audio already at 16 kHz and tag it as such).
 */
export function phoneMulawToWhisperPcm(mulaw: Uint8Array): { pcm: Uint8Array; sampleRate: number } {
  const pcm8k = mulawToPcmS16le(mulaw);
  const f32 = pcmS16leToFloat32(pcm8k);
  const up = upsampleFloat32(f32, PHONE_SAMPLE_RATE, 16000);
  return { pcm: float32ToPcmS16le(up), sampleRate: 16000 };
}

/** RMS of one s16 frame - the energy measure the utterance detector gates on. */
export function frameRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/** Reinterpret s16le bytes as an Int16Array view (no copy). */
export function s16leView(bytes: Uint8Array): Int16Array {
  const frames = bytes.byteLength >> 1;
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, frames);
  // unaligned - copy once
  const copy = new Uint8Array(bytes);
  return new Int16Array(copy.buffer, 0, frames);
}

// ── utterance endpointing (frame-count based, deterministic) ──────────────────
//
// Inbound phone audio arrives as 20ms frames. The detector is pure state over
// frame counts (no wall clock), so the validation harness drives it exactly:
// N consecutive speech-energy frames open an utterance, M consecutive silence
// frames close it, and a sustained-speech callback fires DURING playback for
// barge-in. A short pre-roll ring keeps the syllable that tripped the gate.

export interface VadConfig {
  /** RMS at/above which a frame counts as speech. */
  speechRms: number;
  /** consecutive speech frames to OPEN an utterance. */
  startFrames: number;
  /** consecutive silence frames to CLOSE an utterance (25 x 20ms = 500ms). */
  endFrames: number;
  /** utterances shorter than this many speech frames are dropped (noise blips). */
  minSpeechFrames: number;
  /** hard cap on utterance length in frames (1500 x 20ms = 30s). */
  maxFrames: number;
  /** sustained speech frames DURING playback that trigger barge-in. */
  bargeInFrames: number;
  /** pre-roll frames kept before the first speech frame. */
  prerollFrames: number;
}

export const DEFAULT_VAD: VadConfig = {
  speechRms: 900,
  startFrames: 3,
  endFrames: 25,
  minSpeechFrames: 5,
  maxFrames: 1500,
  bargeInFrames: 10,
  prerollFrames: 8,
};

export interface UtteranceEvents {
  /** A complete utterance (s16le mono PCM at the fed rate) ended on silence. */
  onUtterance: (pcm: Uint8Array) => void;
  /** Sustained speech while `playing` was true - the barge-in signal. */
  onBargeIn?: () => void;
}

export class UtteranceDetector {
  private readonly cfg: VadConfig;
  private readonly ev: UtteranceEvents;
  private collecting = false;
  private speechRun = 0;
  private silenceRun = 0;
  private speechFrames = 0;
  private frames: Uint8Array[] = [];
  private preroll: Uint8Array[] = [];
  private bargeRun = 0;
  private bargedThisPlayback = false;
  /** While true (first mate audio is playing), speech triggers onBargeIn instead. */
  playing = false;

  constructor(ev: UtteranceEvents, cfg: Partial<VadConfig> = {}) {
    this.ev = ev;
    this.cfg = { ...DEFAULT_VAD, ...cfg };
  }

  /** Feed one inbound frame of s16le PCM bytes (any frame size). */
  feed(frame: Uint8Array): void {
    const rms = frameRms(s16leView(frame));
    const speech = rms >= this.cfg.speechRms;

    if (this.playing) {
      // Half-duplex with barge-in: don't collect while first mate talks, but a
      // SUSTAINED run of speech interrupts (handset echo cancellation keeps the
      // bot's own voice out; the run-length requirement guards speakerphone bleed).
      this.bargeRun = speech ? this.bargeRun + 1 : 0;
      if (speech && this.bargeRun >= this.cfg.bargeInFrames && !this.bargedThisPlayback) {
        this.bargedThisPlayback = true;
        this.ev.onBargeIn?.();
      }
      return;
    }
    this.bargeRun = 0;
    this.bargedThisPlayback = false;

    if (!this.collecting) {
      this.preroll.push(frame);
      if (this.preroll.length > this.cfg.prerollFrames) this.preroll.shift();
      this.speechRun = speech ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.cfg.startFrames) {
        this.collecting = true;
        this.frames = [...this.preroll];
        this.preroll = [];
        this.speechFrames = this.speechRun;
        this.silenceRun = 0;
      }
      return;
    }

    this.frames.push(frame);
    if (speech) {
      this.speechFrames++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
    }
    if (this.silenceRun >= this.cfg.endFrames || this.frames.length >= this.cfg.maxFrames) {
      this.finish();
    }
  }

  /** Force-close any in-flight utterance (call teardown). Drops it silently. */
  reset(): void {
    this.collecting = false;
    this.frames = [];
    this.preroll = [];
    this.speechRun = 0;
    this.silenceRun = 0;
    this.speechFrames = 0;
    this.bargeRun = 0;
  }

  private finish(): void {
    const frames = this.frames;
    const hadSpeech = this.speechFrames >= this.cfg.minSpeechFrames;
    this.reset();
    if (!hadSpeech) return; // a noise blip, not an utterance
    let total = 0;
    for (const f of frames) total += f.length;
    const pcm = new Uint8Array(total);
    let o = 0;
    for (const f of frames) { pcm.set(f, o); o += f.length; }
    this.ev.onUtterance(pcm);
  }
}
