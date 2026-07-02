// secrets.ts — load ceo-chat secrets from a gitignored location OUTSIDE the repo.
//
// Secrets live at ~/.config/ceo-chat/secrets.env (KEY=value, one per line). They
// are NEVER committed and NEVER hardcoded. The broker loads them here. Recognized
// names: MINIMAX_API_KEY, MINIMAX_GROUP_ID, MINIMAX_VOICE_ID, ANTHROPIC_API_KEY,
// GEMINI_API_KEY. MINIMAX_VOICE_ID is the captain's CLONED voice id (created by
// `npm run clone-voice`); when set the live MiniMax client speaks in that voice
// instead of the default system voice — see src/tts/minimax.ts + src/tts/voice-clone.ts.
//
// Call Mode (Twilio phone leg - see docs/call-mode.md) adds:
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN - the Twilio account credentials.
//   TWILIO_PHONE_NUMBER   - the purchased US local number calls come from.
//   CEOCHAT_ALLOWED_CALLER - the captain's mobile (caller-ID allowlist; also the
//                            number the outbound "Call me" button rings).
//   CEOCHAT_PHONE_PIN     - 4-6 digit PIN required (keypad/DTMF entry only) before
//                            the first injection on ANY call, inbound or outbound.
//
// A blank/absent key does NOT throw — callers decide whether to run the real
// credentialed call or gracefully fall back to the mock path. This is what lets
// `npm run validate` run fully green with no creds and flip to live cleanly.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Secrets = Record<string, string>;

export const SECRETS_PATH =
  process.env.CEOCHAT_SECRETS || join(homedir(), '.config', 'ceo-chat', 'secrets.env');

// Parse a dotenv-style file. Tolerant: ignores blank lines and `#` comments,
// trims whitespace, strips surrounding single/double quotes from values.
export function loadSecrets(path: string = SECRETS_PATH): Secrets {
  const out: Secrets = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// True only when a key is present AND non-empty.
export function has(secrets: Secrets, key: string): boolean {
  return typeof secrets[key] === 'string' && secrets[key]!.length > 0;
}

// Are the MiniMax live-TTS credentials available? (API key is the gate; GroupId is
// recommended but empirically not strictly required for WS auth — plan §6.1.)
export function hasMinimaxCreds(secrets: Secrets): boolean {
  return has(secrets, 'MINIMAX_API_KEY');
}

// The captain's CLONED MiniMax voice id, or undefined when none is configured. When
// present, the live MiniMax client speaks in this voice instead of DEFAULT_VOICE_ID.
export function minimaxVoiceId(secrets: Secrets): string | undefined {
  return has(secrets, 'MINIMAX_VOICE_ID') ? secrets.MINIMAX_VOICE_ID : undefined;
}

// Is the Google Gemini speakability key available? It gates the PREFERRED streaming
// rewriter on hub (fast, free-tier, no Anthropic key needed) — see the 'gemini'
// backend in src/speakability/speakability.ts.
export function hasGeminiCreds(secrets: Secrets): boolean {
  return has(secrets, 'GEMINI_API_KEY');
}

// ── Call Mode (Twilio phone leg) ───────────────────────────────────────────────

// Everything the phone transport reads from secrets, in one shape. Absent values
// are undefined - the phone leg degrades feature-by-feature (see phoneCapabilities).
export interface PhoneSecrets {
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  allowedCaller?: string;
  pin?: string;
}

export function phoneSecrets(secrets: Secrets): PhoneSecrets {
  const get = (k: string): string | undefined => (has(secrets, k) ? secrets[k] : undefined);
  return {
    accountSid: get('TWILIO_ACCOUNT_SID'),
    authToken: get('TWILIO_AUTH_TOKEN'),
    phoneNumber: get('TWILIO_PHONE_NUMBER'),
    allowedCaller: get('CEOCHAT_ALLOWED_CALLER'),
    pin: get('CEOCHAT_PHONE_PIN'),
  };
}

// What the configured secrets actually enable. The media bridge itself (TwiML +
// WS + PIN gate) only needs the allowlist + PIN - that is what the mock validation
// leg exercises with NO Twilio account. The outbound "Call me" REST trigger
// additionally needs the account creds + a purchased number.
export function phoneCapabilities(p: PhoneSecrets): { inbound: boolean; outbound: boolean } {
  const inbound = !!(p.allowedCaller && p.pin);
  const outbound = inbound && !!(p.accountSid && p.authToken && p.phoneNumber);
  return { inbound, outbound };
}
