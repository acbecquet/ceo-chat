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
import { DEFAULT_SAMPLE_RATE } from '../tts/minimax.ts';
import { BrokerDriver } from './driver.ts';
import { createWebApp, type WebApp } from './app.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'out');

const argv = process.argv.slice(2);
const forceMock = argv.includes('--mock') || process.env.CEOCHAT_MOCK === '1';

const log = (m: string): void => console.log('  ·', m);

const broker = new Broker({ outDir: OUT_DIR, log, mock: forceMock });
const driver = new BrokerDriver(broker, DEFAULT_SAMPLE_RATE);

console.log('ceo-chat — web interface to firstmate');
console.log(`TTS mode: ${broker.ttsMode.toUpperCase()}${broker.ttsMode === 'mock' ? '  (add MiniMax creds to go live)' : ''}`);
console.log(`speakability backend: ${broker.speakBackendHint()}`);
console.log('spawning dedicated ceo-chat session (this takes a few seconds)…');

let app: WebApp;
try {
  app = await createWebApp({ driver, log });
} catch (e) {
  console.error('  ✗ startup failed:', (e as Error)?.message ?? e);
  console.error('  tearing down the dedicated ceo-chat session…');
  try { await driver.stop(); } catch { /* ignore */ }
  process.exit(1);
}

console.log('');
console.log(`  ▸ open ${app.url}`);
console.log(`  ▸ via Cloudflare named tunnel: https://ceo-chat.acb-apps.com`);
console.log('  ▸ Ctrl-C to stop (tears down the ceo-chat session)');
console.log('');

let stopping = false;
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    console.log('\nShutting down — tearing down the dedicated ceo-chat session…');
    try { await app.close(); } catch { /* ignore */ }
    try { await driver.stop(); } catch { /* ignore */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
