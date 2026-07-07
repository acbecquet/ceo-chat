// stt.ts — LOCAL, offline speech-to-text via whisper.cpp.
//
// Powers two things from ONE transcriber:
//   1. the optional SERVER-SIDE STT fallback for the browser (when iOS Safari's
//      built-in Web Speech is flaky, the page streams mic PCM to the broker, which
//      transcribes here and hands the text back for the captain to confirm/send), and
//   2. the round-trip audio e2e gate (`npm run validate`): piper TTS -> this STT,
//      proving the voice loop with REAL generated audio, headless, no creds.
//
// `bin/setup-local-voice.sh` builds whisper-cli + downloads ggml-tiny.en into
// $CEOCHAT_VOICE_DIR. whisper.cpp requires 16 kHz mono WAV, so we resample with the
// SAME pure helper the browser uses (src/web/pcm.js#downsampleFloat32) — one
// resampler, asserted by the harness — then wrap the result in a WAV header.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wavHeader } from '../tts/minimax.ts';
import { voiceDir } from '../tts/local-tts.ts';
import { pcmS16leToFloat32, downsampleFloat32, float32ToPcmS16le } from '../web/pcm.js';

export const WHISPER_SAMPLE_RATE = 16000;

export interface Transcriber {
  /** Transcribe s16le mono PCM at `sampleRate` into text (best-effort, may be ''). */
  transcribe(pcm: Buffer, sampleRate: number): Promise<string>;
  /** Human label for logs / the UI (e.g. "whisper.cpp tiny.en"). */
  readonly label: string;
}

export interface WhisperPaths {
  bin: string;
  model: string;
  /** Short model name for the label/UI, e.g. "base.en" (from the resolved .bin). */
  modelName: string;
}

/** Short model name from a ggml path: ".../ggml-base.en.bin" -> "base.en". */
function modelLabel(modelPath: string): string {
  const base = modelPath.replace(/^.*[\\/]/, '').replace(/^ggml-/, '').replace(/\.bin$/, '');
  return base || 'model';
}

/**
 * Locate a built whisper-cli + model, honoring CEOCHAT_WHISPER_BIN/_MODEL. The default
 * model is `base.en` (decision D1 - materially fewer telephony misreads than the old
 * tiny.en at ~2s/utterance), but an existing install that only has tiny.en still works:
 * we fall back to it so a stale voice dir is not silently STT-less until `npm run voice`.
 */
export function findWhisper(dir: string = voiceDir()): WhisperPaths | null {
  const bin = process.env.CEOCHAT_WHISPER_BIN || join(dir, 'whisper', 'whisper-cli');
  if (!existsSync(bin)) return null;
  const candidates = process.env.CEOCHAT_WHISPER_MODEL
    ? [process.env.CEOCHAT_WHISPER_MODEL]
    : [join(dir, 'whisper', 'ggml-base.en.bin'), join(dir, 'whisper', 'ggml-tiny.en.bin')];
  const model = candidates.find((p) => existsSync(p));
  if (!model) return null;
  return { bin, model, modelName: modelLabel(model) };
}

// whisper.cpp prints one line per audio segment to stdout (with -nt = no timestamps).
// Strip the bracketed/parenthetical non-speech markers it emits, e.g. "[BLANK_AUDIO]".
function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WhisperOptions {
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/** A whisper.cpp-backed Transcriber, or null if the local stack isn't installed. */
export function makeWhisperTranscriber(opts: WhisperOptions = {}): Transcriber | null {
  const paths = findWhisper();
  if (!paths) return null;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 60000;
  return {
    label: 'whisper.cpp ' + paths.modelName,
    transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
      // Resample to 16 kHz mono (whisper's required rate) with the shared pure helper.
      const f32 = pcmS16leToFloat32(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      const down = downsampleFloat32(f32, sampleRate, WHISPER_SAMPLE_RATE);
      const pcm16k = Buffer.from(float32ToPcmS16le(down));
      const wav = Buffer.concat([wavHeader(pcm16k.length, WHISPER_SAMPLE_RATE), pcm16k]);

      const dir = mkdtempSync(join(tmpdir(), 'ceochat-stt-'));
      const wavPath = join(dir, 'in.wav');
      writeFileSync(wavPath, wav);

      // Modest thread count so STT never starves the broker.
      const threads = Math.max(1, Math.min(4, Number(process.env.CEOCHAT_WHISPER_THREADS) || 3));
      return new Promise<string>((resolve, reject) => {
        const args = ['-m', paths.model, '-f', wavPath, '-nt', '-np', '-l', 'en', '-t', String(threads)];
        const p = spawn(paths.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
          fn();
        };
        const timer = setTimeout(() => {
          try { p.kill('SIGKILL'); } catch { /* ignore */ }
          finish(() => reject(new Error(`whisper timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        p.on('error', (e) => { clearTimeout(timer); finish(() => reject(new Error('whisper spawn failed: ' + e.message))); });
        p.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) return finish(() => reject(new Error(`whisper exited ${code}: ${err.slice(0, 300)}`)));
          const text = cleanTranscript(out);
          log(`whisper -> "${text}"`);
          finish(() => resolve(text));
        });
      });
    },
  };
}
