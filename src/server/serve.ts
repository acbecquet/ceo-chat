#!/usr/bin/env node
// serve.ts — the ceo-chat WEB SERVER entrypoint (npm run serve).
//
// Opens a browser front-end to the SAME end-to-end pipeline the CLI driver uses:
// the captain points a browser at the URL, sees the live terminal view of a
// dedicated `ceo-chat` agent session, types (or speaks, via the browser's built-in
// STT) a message to firstmate, watches the speakability narration appear, and hears
// the TTS audio play back in the page.
//
//   npm run serve                 # bind 127.0.0.1:8420 (mock TTS unless creds present)
//   CEOCHAT_PORT=9000 npm run serve
//   CEOCHAT_HOST=0.0.0.0 npm run serve   # bind all interfaces (prefer the tunnel)
//   npm run serve -- --mock       # force the fully-offline path (mock TTS + speak)
//
// Creds-free by default: the broker stands up the in-process mock MiniMax server so
// audio plays in the browser with NO key. Drop MINIMAX_API_KEY (+ GROUP_ID) into
// ~/.config/ceo-chat/secrets.env and the SAME server flips to live MiniMax.
//
// EXPOSURE: serve plain HTTP on localhost; firstmate fronts it with a Cloudflare
// NAMED TUNNEL at https://ceo-chat.acb-apps.com (Cloudflare terminates TLS and the
// page upgrades to a same-origin wss://, so nothing here assumes a public host).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Broker } from '../broker/broker.ts';
import { BrokerDriver } from './driver.ts';
import { createWebApp, type WebApp } from './app.ts';
import { makeWhisperTranscriber } from './stt.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'out');

const argv = process.argv.slice(2);
const forceMock = argv.includes('--mock') || process.env.CEOCHAT_MOCK === '1';

const log = (m: string): void => console.log('  ·', m);

const broker = new Broker({ outDir: OUT_DIR, log, mock: forceMock });
const driver = new BrokerDriver(broker);
// Optional server-side STT fallback (local whisper.cpp). null if not installed —
// the browser's own Web Speech is the primary path either way.
const transcriber = forceMock ? null : makeWhisperTranscriber({ log });

const attached = broker.isAttached();

const ttsLine =
  broker.ttsMode === 'local' ? `LOCAL piper (${broker.ttsVoiceLabel()}) — real offline speech`
  : broker.ttsMode === 'minimax' ? `MINIMAX premium cloud voice — ${broker.ttsVoiceLabel()}`
  : 'MOCK tone (no voice installed — run `npm run voice` for real speech)';

console.log('ceo-chat — web interface to firstmate');
console.log(`TTS: ${ttsLine}`);
console.log(`STT fallback: ${transcriber ? transcriber.label + ' (server-side)' : 'browser Web Speech only'}`);
console.log(`speakability backend: ${broker.speakBackendHint()}`);
console.log(`target: ${broker.targetLabel()}`);
console.log(attached
  ? 'attaching to your running first mate…'
  : 'spawning dedicated ceo-chat session (this takes a few seconds)…  '
    + '[set CEOCHAT_TARGET=session:window to attach to a REAL first mate instead]');

let app: WebApp;
try {
  app = await createWebApp({
    driver,
    log,
    transcribe: transcriber ? (pcm, sr) => transcriber.transcribe(pcm, sr) : undefined,
    sttLabel: transcriber ? transcriber.label : '',
  });
} catch (e) {
  console.error('  ✗ startup failed:', (e as Error)?.message ?? e);
  if (!attached) console.error('  tearing down the dedicated ceo-chat session…');
  try { await driver.stop(); } catch { /* ignore */ }
  process.exit(1);
}

console.log('');
console.log(`  ▸ open ${app.url}`);
console.log(`  ▸ via Cloudflare named tunnel: https://ceo-chat.acb-apps.com`);
console.log(attached
  ? '  ▸ Ctrl-C to stop (DETACHES — your first mate keeps running)'
  : '  ▸ Ctrl-C to stop (tears down the dedicated ceo-chat session)');
console.log('');

let stopping = false;
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    console.log(attached
      ? '\nShutting down — detaching (your first mate keeps running)…'
      : '\nShutting down — tearing down the dedicated ceo-chat session…');
    try { await app.close(); } catch { /* ignore */ }
    try { await driver.stop(); } catch { /* ignore */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
