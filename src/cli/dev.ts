#!/usr/bin/env node
// dev.ts — the runnable ceo-chat product entrypoint (npm run dev / npm start).
//
// An interactive CLI driver: you type a message, it goes through firstmate exactly
// as a voice line would (fm-send -> agent -> transcript tap), gets rewritten for the
// ear (speakability), and is spoken via MiniMax TTS — written to a WAV you can play —
// while the visual terminal view is printed alongside. This is the end-to-end core
// the captain tests manually before the phone PWA / WebRTC phases.
//
//   npm run dev                 # interactive: type lines, Ctrl-D / "exit" to quit
//   npm run dev -- "one line"   # one-shot: drive a single line and exit
//   npm run dev -- --mock ...   # force the fully-offline path (mock TTS + speak)
//
// Creds-free by default: TTS uses the in-process mock MiniMax server (real WAV from
// synthetic PCM). Add MINIMAX_API_KEY (+ GROUP_ID) to ~/.config/ceo-chat/secrets.env
// and the SAME run flips to live MiniMax — no code change. Pass --mock (or set
// CEOCHAT_MOCK=1) to force the offline path even when creds are present.

import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from '../broker/broker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'out');

const argv = process.argv.slice(2);
const forceMock = argv.includes('--mock') || process.env.CEOCHAT_MOCK === '1';
const oneShot = argv.filter((a) => !a.startsWith('-')).join(' ').trim();

const log = (m: string): void => console.log('  ·', m);
const indent = (s: string): string => (s || '').split('\n').map((l) => '     ' + l).join('\n');

const broker = new Broker({ outDir: OUT_DIR, log, mock: forceMock });
let turn = 0;
let stopping = false;

async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    console.log('\nTearing down dedicated ceo-chat session…');
    await broker.stop();
  }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

async function drive(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  turn++;
  console.log(`\n──────── turn ${turn} ────────`);
  console.log('you (typed):', text);
  try {
    const r = await broker.send(text, turn);
    console.log('\nagent (raw reply):');
    console.log(indent(r.reply));
    console.log(`\nnarration (spoken, ${r.speakBackend}):`);
    console.log(indent(r.narration));
    console.log(`\n🔊 audio: ${r.audio.bytes} PCM bytes · time-to-first-audio ${r.audio.ttfbMs ?? 'n/a'}ms · ${r.wavPath}`);
    if (r.audio.billing) console.log('   billing:', JSON.stringify(r.audio.billing));
    if (r.terminal) {
      console.log('\nterminal view (capture-pane):');
      console.log(indent(r.terminal.split('\n').slice(-12).join('\n')));
    }
  } catch (e) {
    console.error('  ✗ turn failed:', (e as Error).message);
  }
}

console.log('ceo-chat — voice interface to firstmate (CLI driver)');
console.log(`TTS mode: ${broker.ttsMode.toUpperCase()}${broker.ttsMode === 'mock' ? '  (add MiniMax creds to go live)' : ''}`);
console.log(`speakability backend: ${broker.speakBackendHint()}`);

await broker.start();

if (oneShot) {
  await drive(oneShot);
  await shutdown(0);
} else {
  console.log('\nType a message for firstmate and press Enter. Ctrl-D or "exit" to quit.\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'ceo-chat> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const t = line.trim();
    if (t === 'exit' || t === 'quit') { rl.close(); return; }
    rl.pause();
    void drive(line).then(() => { rl.resume(); rl.prompt(); });
  });
  rl.on('close', () => { void shutdown(0); });
}
