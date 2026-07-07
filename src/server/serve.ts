#!/usr/bin/env node
// serve.ts - the ceo-chat WEB SERVER entrypoint (npm run serve).
//
// Opens a browser front-end to the SAME end-to-end pipeline the CLI driver uses:
// the captain points a browser at the URL, sees the live 1:1 verbatim transcript of
// a firstmate session, types (or speaks) a message, watches the exact reply stream
// in, and hears the spoken TTS summary.
//
//   npm run serve                 # bind 127.0.0.1:8420 (mock TTS unless creds present)
//   CEOCHAT_PORT=9000 npm run serve
//   CEOCHAT_HOST=0.0.0.0 npm run serve   # bind all interfaces (prefer the tunnel)
//   npm run serve -- --mock       # force the fully-offline path (mock TTS + speak)
//
// CALL MODE (docs/call-mode.md): when the Twilio secrets are paired in
// ~/.config/ceo-chat/secrets.env, this same server also answers the Twilio voice
// webhook (POST /phone/twiml) and bridges the call's Media Streams WS (/phone)
// into the same pipeline - first mate as a real phone call, with the browser as
// the in-call verbatim transcript. The "Call me" button rings the captain.
//
// TEXT MODE (docs/text-mode.md): with the auth token + allowlist paired, the same
// server also answers the Twilio Messaging webhook (POST /text/webhook) - SMS/MMS
// to first mate on the SAME number - and the proactive /text/notify trigger
// (bin/text-captain.sh), replying by Twilio REST after the turn.
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
import { TurnRunner } from './turns.ts';
import { createPhoneApp, type PhoneApp } from './phone.ts';
import { createTextApp, type TextApp } from './text.ts';
import { makeTranscriptVerbatim, resolveBrokerProjectDir } from './verbatim.ts';
import { makeTranscriptActivity } from './activity.ts';
import {
  loadSecrets, hasMinimaxCreds, minimaxVoiceId, phoneSecrets, phoneCapabilities,
  textCapabilities, textNotifyEnabled, cleanupConfig, sttEngine,
} from '../config/secrets.ts';
import { makePromptCleaner } from '../stt/cleanup.ts';
import { synthStreaming, INTL_WS } from '../tts/minimax.ts';
import { findPiper, synthLocal } from '../tts/local-tts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'out');

const argv = process.argv.slice(2);
const forceMock = argv.includes('--mock') || process.env.CEOCHAT_MOCK === '1';

const log = (m: string): void => console.log('  ·', m);

const secrets = loadSecrets();
const broker = new Broker({ outDir: OUT_DIR, log, mock: forceMock });
const driver = new BrokerDriver(broker);
// Optional server-side STT fallback (local whisper.cpp). null if not installed -
// the browser's own Web Speech is the primary path either way. The phone leg uses
// the SAME transcriber for the captain's call audio.
const transcriber = forceMock ? null : makeWhisperTranscriber({ log });

// STT/cleanup config reads secrets.env AND the process env (env wins) - one merged
// map so CEOCHAT_* set in either place is honored consistently.
const configEnv = { ...secrets, ...process.env };

// A reserved config name for future pluggable engines (decision D1). Only whisper-local
// is wired today; a request for another engine is honored as a no-op with a clear note.
const engine = sttEngine(configEnv);
if (engine !== 'whisper-local') {
  log(`CEOCHAT_STT_ENGINE=${engine} is reserved but not yet available - using whisper-local`);
}

// Dictation cleanup (report ceochat-stt-w4 §4): raw ASR transcript -> cleaned prompt via
// one fast LLM call, with a HARD raw fallback so it can never block. Gemini is the
// default backend, MiniMax is configurable; null when disabled (mode off, or auto with
// no cleanup key = today's raw behavior). Shared by the phone leg and the web STT path.
const cleanupCfg = cleanupConfig(configEnv);
const cleaner = makePromptCleaner({
  mode: cleanupCfg.mode,
  backendPref: cleanupCfg.backendPref,
  forceMock,
  geminiApiKey: secrets.GEMINI_API_KEY,
  minimaxApiKey: secrets.MINIMAX_API_KEY,
  minimaxGroupId: secrets.MINIMAX_GROUP_ID,
  timeoutMs: cleanupCfg.timeoutMs,
  log,
});
const cleanPrompt = cleaner ? cleaner.clean : undefined;

const attached = broker.isAttached();

// Canned phone phrases (PIN prompt / greeting / re-asks) reuse the same TTS stack
// the pipeline speaks through - cloned MiniMax voice first, then the local piper
// voice. A short synthetic beep is the last-resort placeholder so a PIN prompt is
// never pure silence even with no voice installed.
function makePromptSynth(): (text: string) => Promise<{ pcm: Buffer; sampleRate: number }> {
  if (!forceMock && hasMinimaxCreds(secrets)) {
    return async (text) => {
      const r = await synthStreaming({
        apiKey: secrets.MINIMAX_API_KEY!,
        groupId: secrets.MINIMAX_GROUP_ID || '',
        textChunks: [text],
        voiceId: minimaxVoiceId(secrets),
        endpoint: INTL_WS,
        log,
      });
      return { pcm: r.pcm, sampleRate: r.sampleRate };
    };
  }
  const voice = forceMock ? null : findPiper();
  if (voice) {
    return async (text) => {
      const r = await synthLocal(voice, [text], { log });
      return { pcm: r.pcm, sampleRate: r.sampleRate };
    };
  }
  return async () => {
    // 400ms 440Hz beep at 8 kHz - a placeholder cue, not speech.
    const rate = 8000;
    const frames = Math.floor(rate * 0.4);
    const pcm = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
    }
    return { pcm, sampleRate: rate };
  };
}

// The live verbatim transcript tap: reads the SAME session JSONL the spoken path
// anchors to, from the outside, so the web UI shows the exact reply text streaming.
const verbatim = makeTranscriptVerbatim({
  resolveProjectDir: () => resolveBrokerProjectDir(),
  log,
});

// ONE turn engine shared by the web WS and the phone bridge (single busy lock -
// one agent session, one turn at a time, whichever transport started it).
const runner = new TurnRunner({ driver, verbatim, log });

// Call Mode: mounted only when the captain has paired at least the allowlist + PIN.
const phoneCfg = phoneSecrets(secrets);
const phoneCaps = phoneCapabilities(phoneCfg);
const publicUrl = process.env.CEOCHAT_PUBLIC_URL || 'https://ceo-chat.acb-apps.com';
let phone: PhoneApp | null = null;
if (phoneCaps.inbound) {
  // REAL-only mid-turn progress source: taps the SAME session JSONL the spoken path
  // anchors to (from the outside) and surfaces the agent's live tool activity.
  const activity = makeTranscriptActivity({
    resolveProjectDir: () => resolveBrokerProjectDir(),
    log,
  });
  phone = createPhoneApp({
    runner,
    transcribe: transcriber ? (pcm, sr) => transcriber.transcribe(pcm, sr) : undefined,
    cleanPrompt,
    synthPrompt: makePromptSynth(),
    activity,
    secrets: phoneCfg,
    publicUrl,
    log,
  });
}

// Text Mode: SMS/MMS on the SAME number. Mounted only when the mandatory webhook
// authentication is possible (auth token) AND the sender allowlist is set.
const textCaps = textCapabilities(phoneCfg);
let text: TextApp | null = null;
if (textCaps.inbound) {
  text = createTextApp({
    runner,
    secrets: phoneCfg,
    publicUrl,
    notifyEnabled: textNotifyEnabled(secrets),
    log,
  });
}

const ttsLine =
  broker.ttsMode === 'local' ? `LOCAL piper (${broker.ttsVoiceLabel()}) - real offline speech`
  : broker.ttsMode === 'minimax' ? `MINIMAX premium cloud voice - ${broker.ttsVoiceLabel()}`
  : 'MOCK tone (no voice installed - run `npm run voice` for real speech)';

console.log('ceo-chat - web interface to firstmate');
console.log(`TTS: ${ttsLine}`);
console.log(`STT fallback: ${transcriber ? transcriber.label + ' (server-side)' : 'browser Web Speech only'}`);
console.log(`STT cleanup: ${cleaner ? cleaner.backend + ` (${cleanupCfg.mode})` : `off (${cleanupCfg.mode})`}`);
console.log(`speakability backend: ${broker.speakBackendHint()}`);
console.log(`target: ${broker.targetLabel()}`);
console.log(phone
  ? `call mode: ${phoneCaps.outbound ? 'inbound + outbound ("Call me")' : 'inbound only (add TWILIO_* secrets for outbound)'} - webhook ${publicUrl}/phone/twiml`
  : 'call mode: OFF (add CEOCHAT_ALLOWED_CALLER + CEOCHAT_PHONE_PIN - see docs/call-mode.md)');
console.log(text
  ? `text mode: ${textCaps.outbound ? `inbound + replies${text.notifyEnabled ? ' + notify' : ' (notify OFF)'}` : 'inbound only (add TWILIO_ACCOUNT_SID + TWILIO_PHONE_NUMBER for replies)'} - webhook ${publicUrl}/text/webhook`
  : 'text mode: OFF (add TWILIO_AUTH_TOKEN + CEOCHAT_ALLOWED_CALLER - see docs/text-mode.md)');
console.log(attached
  ? 'attaching to your running first mate…'
  : 'spawning dedicated ceo-chat session (this takes a few seconds)…  '
    + '[set CEOCHAT_TARGET=session:window to attach to a REAL first mate instead]');

let app: WebApp;
try {
  app = await createWebApp({
    driver,
    runner,
    phone: phone ?? undefined,
    text: text ?? undefined,
    log,
    transcribe: transcriber ? (pcm, sr) => transcriber.transcribe(pcm, sr) : undefined,
    cleanPrompt,
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
console.log(`  ▸ via Cloudflare named tunnel: ${publicUrl}`);
console.log(attached
  ? '  ▸ Ctrl-C to stop (DETACHES - your first mate keeps running)'
  : '  ▸ Ctrl-C to stop (tears down the dedicated ceo-chat session)');
console.log('');

let stopping = false;
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    console.log(attached
      ? '\nShutting down - detaching (your first mate keeps running)…'
      : '\nShutting down - tearing down the dedicated ceo-chat session…');
    try { await app.close(); } catch { /* ignore */ }
    try { await driver.stop(); } catch { /* ignore */ }
  }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
