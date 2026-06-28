// local-tts.ts — REAL offline neural voice via piper (rhasspy/piper).
//
// The default offline read-aloud backend: first mate's replies are spoken as
// intelligible English with NO external key and NO sudo. piper is a self-contained
// prebuilt binary (bundles onnxruntime + espeak-ng); `bin/setup-local-voice.sh`
// downloads it + a voice model into $CEOCHAT_VOICE_DIR (default
// ~/.local/share/ceo-chat), OUTSIDE the repo. This module probes for that install
// and synthesizes raw s16le PCM by piping text through `piper --output_raw`, so the
// broker can return the SAME SynthResult shape MiniMax produces — the rest of the
// pipeline (and the browser player) is backend-agnostic.
//
// TTS backend precedence (broker): MiniMax (premium, creds present) -> local piper
// (default offline voice) -> mock (synthetic tone, unit tests / no voice installed).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SynthResult } from './minimax.ts';

export const DEFAULT_VOICE_NAME = 'en_US-lessac-medium';

export interface LocalVoice {
  /** piper executable. */
  bin: string;
  /** voice .onnx model (its sibling .onnx.json must exist). */
  model: string;
  /** espeak-ng-data dir bundled next to the binary (passed explicitly to be safe). */
  espeakData?: string;
  /** the voice's native sample rate (read from the model json; 22050 for *-medium). */
  sampleRate: number;
  /** human label for logs / the UI. */
  name: string;
}

/** Where the offline voice stack lives (outside the repo, persists across worktrees). */
export function voiceDir(): string {
  return process.env.CEOCHAT_VOICE_DIR || join(homedir(), '.local', 'share', 'ceo-chat');
}

/**
 * Locate an installed piper voice, or null if the offline stack isn't set up.
 * Honors overrides: CEOCHAT_PIPER_BIN / CEOCHAT_PIPER_MODEL / CEOCHAT_PIPER_VOICE.
 */
export function findPiper(dir: string = voiceDir()): LocalVoice | null {
  const bin = process.env.CEOCHAT_PIPER_BIN || join(dir, 'piper', 'piper');
  const voice = process.env.CEOCHAT_PIPER_VOICE || DEFAULT_VOICE_NAME;
  const model = process.env.CEOCHAT_PIPER_MODEL || join(dir, 'voices', voice + '.onnx');
  if (!existsSync(bin) || !existsSync(model)) return null;
  let sampleRate = 22050;
  try {
    const cfg = JSON.parse(readFileSync(model + '.json', 'utf8')) as { audio?: { sample_rate?: number } };
    if (cfg.audio && typeof cfg.audio.sample_rate === 'number') sampleRate = cfg.audio.sample_rate;
  } catch { /* keep default */ }
  const espeakData = join(dir, 'piper', 'espeak-ng-data');
  return {
    bin, model, sampleRate, name: voice,
    espeakData: existsSync(espeakData) ? espeakData : undefined,
  };
}

export interface LocalSynthOptions {
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/**
 * Synthesize text to raw PCM with piper. Returns the SynthResult shape the pipeline
 * expects (pcm + native sampleRate + a measured time-to-first-audio).
 */
export function synthLocal(
  voice: LocalVoice,
  textChunks: string[] | string,
  opts: LocalSynthOptions = {},
): Promise<SynthResult> {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 30000;
  const text = (Array.isArray(textChunks) ? textChunks.join(' ') : String(textChunks)).replace(/\s+/g, ' ').trim();
  if (!text) return Promise.resolve({ pcm: Buffer.alloc(0), ttfbMs: null, sampleRate: voice.sampleRate, billing: null, frames: 0, events: [] });

  const args = ['--model', voice.model, '--output_raw'];
  if (voice.espeakData) args.push('--espeak_data', voice.espeakData);

  return new Promise<SynthResult>((resolve, reject) => {
    const t0 = performance.now();
    const p = spawn(voice.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const parts: Buffer[] = [];
    let firstAudioAt: number | null = null;
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`piper timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    p.stdout.on('data', (d: Buffer) => {
      if (firstAudioAt == null && d.length) { firstAudioAt = performance.now(); log(`piper first audio (${d.length} bytes)`); }
      parts.push(d);
    });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error('piper spawn failed: ' + e.message));
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(`piper exited ${code}: ${err.slice(0, 300)}`));
      const pcm = Buffer.concat(parts);
      if (!pcm.length) return reject(new Error('piper produced no audio'));
      resolve({
        pcm,
        ttfbMs: firstAudioAt != null ? Math.round(firstAudioAt - t0) : null,
        sampleRate: voice.sampleRate,
        billing: null,
        frames: 1,
        events: [],
      });
    });

    p.stdin.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('piper stdin write failed: ' + e.message));
    });
    p.stdin.write(text + '\n');
    p.stdin.end();
  });
}
