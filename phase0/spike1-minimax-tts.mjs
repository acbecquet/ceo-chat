#!/usr/bin/env node
// spike1-minimax-tts.mjs — MiniMax streaming TTS round-trip from hub.
//
// PROVES: we can open the INTERNATIONAL WebSocket endpoint, stream text in,
// hex-decode the PCM frames, write playable audio on hub, and measure the REAL
// time-to-first-audio-byte (the figure plan §3.3's latency budget depends on),
// plus capture whatever billing/usage signal MiniMax returns.
//
// RUN:   node phase0/spike1-minimax-tts.mjs ["text to speak"]
// CREDS: needs MINIMAX_API_KEY + MINIMAX_GROUP_ID in ~/.config/ceo-chat/secrets.env.
//        If blank, the spike prints exactly how to run it and exits 0 (pending creds).
// OUT:   phase0/out/spike1.wav  (+ spike1.pcm raw)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets, has } from './lib/secrets.mjs';
import {
  synthStreaming, wavHeader, DEFAULT_MODEL, DEFAULT_VOICE_ID, DEFAULT_SAMPLE_RATE,
} from './lib/minimax.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

const text =
  process.argv[2] ||
  'Hi captain. The tests just passed and the pull request is open on your screen. Want me to merge it?';

const secrets = loadSecrets();

// We attempt the LIVE round-trip whenever the API KEY is present — even if the
// GroupId is blank — precisely so we can empirically learn whether GroupId is
// actually required by the endpoint (plan §6.1 says it is; this proves it). Only
// a missing API key is a hard "pending creds" skip.
if (!has(secrets, 'MINIMAX_API_KEY')) {
  console.log('⏳ PENDING CREDS — no MINIMAX_API_KEY, MiniMax spike implemented but not run.');
  console.log('   Add MINIMAX_API_KEY (and ideally MINIMAX_GROUP_ID) to ~/.config/ceo-chat/secrets.env, then:');
  console.log('     node phase0/spike1-minimax-tts.mjs');
  console.log('   It opens wss://api.minimax.io/ws/v1/t2a_v2?GroupId=…, streams text, hex-decodes');
  console.log('   PCM, writes phase0/out/spike1.wav, and prints time-to-first-audio.');
  process.exit(0);
}

if (!has(secrets, 'MINIMAX_GROUP_ID')) {
  console.log('⚠ MINIMAX_GROUP_ID is BLANK — running anyway to test whether the endpoint requires it.');
}

console.log(`MiniMax streaming TTS — model=${DEFAULT_MODEL} voice=${DEFAULT_VOICE_ID} fmt=pcm@${DEFAULT_SAMPLE_RATE}`);
console.log(`text: "${text}"`);

// Split into sentences so we exercise the incremental task_continue path the
// broker will use (speakability streams sentence-by-sentence).
const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];

try {
  const t0 = performance.now();
  const { pcm, ttfbMs, sampleRate, billing, frames } = await synthStreaming({
    apiKey: secrets.MINIMAX_API_KEY,
    groupId: secrets.MINIMAX_GROUP_ID,
    textChunks: chunks,
    log: (m) => console.log('  ·', m),
  });
  const totalMs = Math.round(performance.now() - t0);

  mkdirSync(OUT_DIR, { recursive: true });
  const wavPath = join(OUT_DIR, 'spike1.wav');
  const pcmPath = join(OUT_DIR, 'spike1.pcm');
  writeFileSync(pcmPath, pcm);
  writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));

  console.log('\n✅ MiniMax round-trip OK');
  console.log(`   time-to-first-audio: ${ttfbMs != null ? ttfbMs + ' ms' : 'n/a'} (from first task_continue)`);
  console.log(`   total round-trip:    ${totalMs} ms`);
  console.log(`   audio frames:        ${frames}`);
  console.log(`   PCM bytes:           ${pcm.length}  (~${(pcm.length / (sampleRate * 2)).toFixed(2)} s @ ${sampleRate}Hz mono16)`);
  console.log(`   billing/usage:       ${billing ? JSON.stringify(billing) : '(none returned)'}`);
  console.log(`   wrote:               ${wavPath}`);
} catch (e) {
  console.error('\n❌ MiniMax spike failed:', e.message);
  process.exit(1);
}
