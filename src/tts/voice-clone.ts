#!/usr/bin/env node
// voice-clone.ts — register the captain's OWN voice as a MiniMax cloned voice.
//
//   npm run clone-voice -- <reference-audio> <voice_id>
//
// This is the ONE captain-run step that turns a recording into a usable voice. The
// rest of ceo-chat already knows how to speak in a custom voice_id (broker reads
// MINIMAX_VOICE_ID from secrets -> src/tts/minimax.ts voice_setting); this script
// produces that voice_id. Two REST calls against the MiniMax INTERNATIONAL host:
//
//   1. POST https://api.minimax.io/v1/files/upload?GroupId=...   (multipart)
//      fields: file=<audio>, purpose=voice_clone                 -> file.file_id
//   2. POST https://api.minimax.io/v1/voice_clone?GroupId=...    (JSON)
//      body:  { file_id, voice_id }                              -> voice_id
//
// Gotchas (same family as the WS T2A client, src/tts/minimax.ts):
//   - INTERNATIONAL host api.minimax.io (NOT minimaxi.com / minimaxi.chat).
//   - Auth: Authorization: Bearer <MINIMAX_API_KEY> header.
//   - GroupId is a URL QUERY param (?GroupId=...), never a header/body field.
//   - voice_id MUST start with a letter, be >=8 chars, alphanumeric (e.g. CaptainVoice1).
//   - We deliberately DO NOT send the optional { text, model } preview fields: a
//     preview synthesizes audio and would burn credits. The clone is registered
//     without a preview; first real audio happens later through the normal pipeline.
//   - speech-2.8-turbo (the broker's DEFAULT_MODEL) supports cloned voice_ids, so once
//     MINIMAX_VOICE_ID is set the existing live path speaks in the cloned voice — no
//     other change. (speech-2.8-hd is the higher-fidelity, higher-latency sibling.)
//
// Audio guidance (MiniMax voice-clone, confirmed against live docs 2026-06): a clean
// SINGLE-speaker recording, mp3 / m4a / wav, roughly 10s–5min, <=20 MB. See
// docs/voice-clone.md for the read-aloud script and where to drop the file.

import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSecrets, has, type Secrets } from '../config/secrets.ts';

export const INTL_REST_BASE = 'https://api.minimax.io';
export const ACCEPTED_EXTENSIONS = ['.mp3', '.m4a', '.wav'] as const;

// MiniMax voice_id rule: start with a letter, >=8 chars, letters+digits only.
export const VOICE_ID_RE = /^[A-Za-z][A-Za-z0-9]{7,}$/;

export function isValidVoiceId(voiceId: string): boolean {
  return VOICE_ID_RE.test(voiceId);
}

// A minimal fetch surface (DI'd so the harness can drive the in-process REST mock or
// a fully synthetic fetch). Matches the global `fetch` shape we use.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData | string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface CloneClientOptions {
  apiKey: string;
  groupId?: string;
  /** Override the REST host — the harness points this at startMockMinimaxRest(). */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}

interface BaseResp { status_code?: number; status_msg?: string }

// Surface a MiniMax base_resp error the same way the WS client does: a non-zero
// status_code is an error (1004 auth/GroupId, 1008 balance, etc).
function assertOk(resp: { base_resp?: BaseResp } | undefined, where: string): void {
  const code = resp?.base_resp?.status_code;
  if (code && code !== 0) {
    throw new Error(`MiniMax ${where} error ${code}: ${resp?.base_resp?.status_msg ?? ''} ` +
      `— if it mentions auth/GroupId, fix MINIMAX_API_KEY / MINIMAX_GROUP_ID in secrets.env`);
  }
}

function qs(baseUrl: string, path: string, groupId: string | undefined): string {
  return `${baseUrl}${path}?GroupId=${encodeURIComponent(groupId || '')}`; // GroupId-in-query gotcha
}

/**
 * Upload a reference audio file for cloning. Returns the MiniMax file_id.
 * `fileBytes` + `fileName` let callers (and tests) supply audio without touching disk.
 */
export async function uploadReferenceAudio(
  args: { fileBytes: Uint8Array; fileName: string; purpose?: string } & CloneClientOptions,
): Promise<string> {
  const { apiKey, groupId, baseUrl = INTL_REST_BASE, fileBytes, fileName } = args;
  const purpose = args.purpose ?? 'voice_clone';
  const log = args.log ?? (() => {});
  const doFetch = (args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');

  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed Blob so a Buffer view never leaks its pool.
  form.append('file', new Blob([new Uint8Array(fileBytes)]), fileName);
  form.append('purpose', purpose);

  log(`uploading ${fileName} (${fileBytes.length} bytes, purpose=${purpose})…`);
  const res = await doFetch(qs(baseUrl, '/v1/files/upload', groupId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` }, // FormData sets its own content-type boundary
    body: form,
  });
  if (!res.ok) throw new Error(`files/upload HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { file?: { file_id?: string | number }; base_resp?: BaseResp };
  assertOk(data, 'files/upload');
  const fileId = data.file?.file_id;
  if (fileId === undefined || fileId === null || `${fileId}`.length === 0) {
    throw new Error('files/upload returned no file_id: ' + JSON.stringify(data).slice(0, 300));
  }
  return `${fileId}`;
}

/**
 * Register a cloned voice from an uploaded file_id under the captain-chosen voice_id.
 * Returns the registered voice_id (echoed by MiniMax). Does NOT request a preview.
 */
export async function registerVoiceClone(
  args: { fileId: string; voiceId: string } & CloneClientOptions,
): Promise<string> {
  const { apiKey, groupId, baseUrl = INTL_REST_BASE, fileId, voiceId } = args;
  const log = args.log ?? (() => {});
  const doFetch = (args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');
  if (!isValidVoiceId(voiceId)) {
    throw new Error(`invalid voice_id "${voiceId}" — must start with a letter, be >=8 chars, letters+digits only (e.g. CaptainVoice1)`);
  }

  log(`registering clone voice_id=${voiceId} from file_id=${fileId}…`);
  const res = await doFetch(qs(baseUrl, '/v1/voice_clone', groupId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
  });
  if (!res.ok) throw new Error(`voice_clone HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { voice_id?: string; base_resp?: BaseResp };
  assertOk(data, 'voice_clone');
  return data.voice_id || voiceId;
}

/** Upload + register in one call (the full clone flow). Returns the cloned voice_id. */
export async function cloneVoice(
  args: { fileBytes: Uint8Array; fileName: string; voiceId: string } & CloneClientOptions,
): Promise<string> {
  const fileId = await uploadReferenceAudio(args);
  return registerVoiceClone({ ...args, fileId });
}

// ─────────────────────────────── CLI ───────────────────────────────────────
async function main(argv: string[]): Promise<number> {
  const positionals = argv.filter((a) => !a.startsWith('-'));
  const [filePath, voiceId] = positionals;
  if (!filePath || !voiceId) {
    console.error('usage: npm run clone-voice -- <reference-audio.(mp3|m4a|wav)> <voice_id>');
    console.error('  voice_id must start with a letter, be >=8 chars, letters+digits only (e.g. CaptainVoice1)');
    console.error('  see docs/voice-clone.md for the recording guide.');
    return 2;
  }
  if (!isValidVoiceId(voiceId)) {
    console.error(`✗ invalid voice_id "${voiceId}" — start with a letter, >=8 chars, letters+digits only (e.g. CaptainVoice1)`);
    return 2;
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    console.error(`✗ unsupported audio format "${ext}" — use one of ${ACCEPTED_EXTENSIONS.join(', ')}`);
    return 2;
  }

  const secrets: Secrets = loadSecrets();
  if (!has(secrets, 'MINIMAX_API_KEY')) {
    console.error('✗ MINIMAX_API_KEY missing from ~/.config/ceo-chat/secrets.env');
    return 1;
  }
  if (!has(secrets, 'MINIMAX_GROUP_ID')) {
    console.error('! MINIMAX_GROUP_ID not set — cloning needs a valid GroupId; attempting anyway.');
  }

  let fileBytes: Buffer;
  try {
    fileBytes = readFileSync(filePath);
  } catch (e) {
    console.error(`✗ cannot read ${filePath}: ${(e as Error).message}`);
    return 1;
  }
  // Length guard: MiniMax wants ~10s–5min; we can't decode duration here, but a tiny
  // or huge file is almost certainly wrong. Warn, don't block (let the API be truth).
  if (fileBytes.length < 16 * 1024) console.error('! reference audio is very small (<16 KB) — MiniMax wants ~10s+ of clean speech.');
  if (fileBytes.length > 20 * 1024 * 1024) {
    console.error('✗ reference audio exceeds 20 MB (MiniMax limit) — trim it and retry.');
    return 1;
  }

  const log = (m: string): void => console.log('  ·', m);
  try {
    const cloned = await cloneVoice({
      apiKey: secrets.MINIMAX_API_KEY!,
      groupId: secrets.MINIMAX_GROUP_ID || '',
      fileBytes: new Uint8Array(fileBytes),
      fileName: basename(filePath),
      voiceId,
      log,
    });
    console.log('');
    console.log(`✓ cloned voice registered: ${cloned}`);
    console.log('');
    console.log('Next: make it ceo-chat\'s voice by adding this line to ~/.config/ceo-chat/secrets.env:');
    console.log(`    MINIMAX_VOICE_ID=${cloned}`);
    console.log('Then restart the broker (npm run serve / npm run dev) — it will speak in your voice.');
    return 0;
  } catch (e) {
    console.error(`✗ clone failed: ${(e as Error).message}`);
    return 1;
  }
}

// Run only when invoked directly (node src/tts/voice-clone.ts ...), not on import.
const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
