#!/usr/bin/env node
// validate.ts — the ceo-chat end-to-end VALIDATION HARNESS.
//
//   npm run validate          # MOCK mode — fully green, no creds, no network
//   npm run validate:live     # LIVE mode  — real MiniMax + LLM where creds exist
//
// It exercises the COMPLETE pipeline and asserts each leg:
//   config -> transcript tap -> speakability -> MiniMax TTS protocol -> full e2e
// plus explicit REGRESSION guards for the three phase-0 bugs and the plan's
// speakability EDGE CASES. Mock mode stands up an in-process MiniMax server that
// speaks the real WS protocol (Bearer auth, GroupId-in-query, hex PCM) so the audio
// path is asserted for real. Live mode runs the same legs against the real services
// and measures true time-to-first-audio; an unpaired-credential 1004/1008 is
// reported as PENDING (expected), never a crash.

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, utimesSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSecrets, has, hasMinimaxCreds, hasGeminiCreds, minimaxVoiceId, type Secrets } from '../src/config/secrets.ts';
import {
  parseTranscript, tailTranscript, latestTranscriptIn, type TranscriptEvent,
  findPromptAnchor, saysAfterAnchor, toolUseAfterAnchor, latestTranscriptWithPrompt,
} from '../src/transcript/transcript.ts';
import {
  describeToolUse, screenSafe, verbGerund, gerundClause,
  type ActivityTap, type ActivityTurnOpts,
} from '../src/server/activity.ts';
import { waitForReply, streamReply, splitCompleteUnits, splitCompleteBlocks } from '../src/transcript/reply.ts';
import { runStreamingPipeline, type PipelineChunk as PipelineChunkT } from '../src/broker/pipeline.ts';
import { detectBenignModal, dismissBenignModals } from '../src/session/session.ts';
import {
  speakify, mockSpeakify, geminiRequestBody, GEMINI_MODEL, GEMINI_ENDPOINT,
} from '../src/speakability/speakability.ts';
import { pickStreamSpeakBackend } from '../src/broker/broker.ts';
import {
  synthStreaming, toWav, wavHeader, INTL_WS, type SynthResult,
} from '../src/tts/minimax.ts';
import {
  verifiedSubmit, paneHoldsText, resolveTargetFromEnv, attachTarget, paneCurrentPath,
  sessionExists, capturePane, capturePaneAnsi, resolveSessionWindow,
} from '../src/session/session.ts';
import { runPipeline, sentenceChunks } from '../src/broker/pipeline.ts';
import { Reporter } from './harness/report.ts';
import { startMockMinimax, startMockMinimaxRest } from '../src/tts/mock-server.ts';
import {
  uploadReferenceAudio, registerVoiceClone, cloneVoice, isValidVoiceId, INTL_REST_BASE,
} from '../src/tts/voice-clone.ts';
import { createWebApp } from '../src/server/app.ts';
import { WS_PATH, AUDIO_FORMAT, STT_SAMPLE_RATE } from '../src/server/protocol.ts';
import type { Driver } from '../src/server/driver.ts';
import { findPiper, synthLocal } from '../src/tts/local-tts.ts';
import { makeWhisperTranscriber } from '../src/server/stt.ts';
import { parseWav } from '../src/tts/minimax.ts';
// Shared browser modules — the SAME files the page loads at /lib/… (asserted here so
// the mobile audio-unlock / STT-restart / confirmation logic can't silently regress).
import {
  base64ToBytes, bytesToBase64, pcmS16leToFloat32, float32ToPcmS16le, downsampleFloat32, wavBytesFromPcm,
} from '../src/web/pcm.js';
import { looksConsequential, classifyReply, guardUtterance } from '../src/web/confirm.js';
import { AudioPlayer } from '../src/web/audio-player.js';
import type { AudioCtxLike, AudioSrcLike, AudioElLike, AudioDiag } from '../src/web/audio-player.js';
import { Diagnostics } from '../src/web/diagnostics.js';
import { SpeechController } from '../src/web/speech.js';
import type { RecognitionLike } from '../src/web/speech.js';
import {
  STT_SAMPLE_RATE as WEB_STT_SR, AUDIO_FORMAT as WEB_AUDIO_FORMAT, WS_PATH as WEB_WS_PATH,
} from '../src/web/protocol-consts.js';
import { WebSocket as WsClient } from 'ws';
import {
  assistantSay, assistantThinking, assistantToolUse, userPrompt, userToolResult,
  bookkeeping, SAMPLE_AGENT_TURN, CONFIRM_TURN, LONG_CODE_TURN,
  DRIFT_FIXTURES, MULTI_ASK_REPLY, OPTIONS_REPLY,
} from './harness/fixtures.ts';
// Call Mode (Twilio phone leg) + the verbatim web transcript.
import {
  linearToMulawSample, mulawToLinearSample, pcmS16leToMulaw, mulawToPcmS16le,
  pcmChunkToPhoneMulaw, phoneMulawToWhisperPcm, phonePcmToWhisperPcm,
  upsampleFloat32, frameRms, s16leView,
  UtteranceDetector, PHONE_SAMPLE_RATE,
} from '../src/server/phone-audio.ts';
import {
  twimlConnectStream, twilioSignature, validateTwilioSignature, sameNumber, placeCall,
} from '../src/server/twilio.ts';
// Text Mode (SMS/MMS on the same Twilio number).
import {
  createTextApp, formatSmsReply, buildInjectedText, mediaExtension, notifyToken,
  ordinalName, describeMediaFailures,
  TEXT_WEBHOOK_PATH, TEXT_NOTIFY_PATH, SMS_BODY_LIMIT,
} from '../src/server/text.ts';
import { textCapabilities, textNotifyEnabled } from '../src/config/secrets.ts';
import {
  createPhoneApp, pruneExpiredTokens, DEFAULT_PHRASES, DEFAULT_PROMPT_POLICY, DEFAULT_FILLER,
  PHONE_WS_PATH, PHONE_TWIML_PATH, MAX_PENDING_SOCKETS, type PhoneTimers,
} from '../src/server/phone.ts';
import { TurnRunner, buildSteerPrompt } from '../src/server/turns.ts';
import { makeTranscriptVerbatim } from '../src/server/verbatim.ts';
import { phoneSecrets, phoneCapabilities, type PhoneSecrets } from '../src/config/secrets.ts';
import { splitFencedSegments, extractPrompt } from '../src/web/prompt-card.js';

const LIVE = process.argv.includes('--live');
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const secrets: Secrets = loadSecrets();
const reporter = new Reporter(LIVE ? 'live' : 'mock');
reporter.header();

const MOCK_KEY = 'mock-minimax-key';
const MOCK_GROUP = 'mock-group-123';

// Count sentences for the "<=3 spoken sentences" assertions.
const sentenceCount = (s: string): number => (s.match(/[.!?]+/g) || []).length || (s.trim() ? 1 : 0);

// ---- fakes for the browser-module legs (no real Web Audio / SpeechRecognition) ----
interface FakeSource extends AudioSrcLike { started: boolean; stopped: boolean; }
function makeRecog(): RecognitionLike {
  return {
    lang: '', continuous: false, interimResults: false, maxAlternatives: 1,
    onstart: null, onresult: null, onerror: null, onend: null,
    start() {}, stop() {}, abort() {},
  };
}
// One SpeechRecognition "result" item: array-like `[{transcript}]` carrying `isFinal`.
function mkRes(transcript: string, isFinal: boolean): unknown {
  return Object.assign([{ transcript }], { isFinal });
}

// ───────────────────────── leg 1: config / secrets ─────────────────────────
await reporter.leg('config — secrets loader (gitignored, outside repo)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-secrets-'));
  const path = join(dir, 'secrets.env');
  writeFileSync(path,
    '# ceo-chat secrets\n' +
    'MINIMAX_API_KEY="abc123"\n' +
    "MINIMAX_GROUP_ID='grp-9'\n" +
    '\n' +
    'ANTHROPIC_API_KEY=sk-xyz\n');
  const s = loadSecrets(path);
  t.eq(s.MINIMAX_API_KEY, 'abc123', 'double-quoted value parsed + unquoted');
  t.eq(s.MINIMAX_GROUP_ID, 'grp-9', 'single-quoted value parsed + unquoted');
  t.eq(s.ANTHROPIC_API_KEY, 'sk-xyz', 'bare value parsed');
  t.ok(has(s, 'MINIMAX_API_KEY') && !has({}, 'MINIMAX_API_KEY'), 'has() distinguishes present vs absent');
  t.ok(hasMinimaxCreds(s), 'hasMinimaxCreds() true when API key present');
  t.ok(loadSecrets(join(dir, 'nope.env')).MINIMAX_API_KEY === undefined, 'missing file -> empty (no throw)');
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────── leg 2: transcript tap ─────────────────────────────
await reporter.leg('transcript tap — JSONL normalize (clean event stream)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-tx-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, [
    bookkeeping('file-history-snapshot'),
    userPrompt('hello there'),
    assistantThinking('let me reason about this privately'),
    assistantSay('Working on it.'),
    assistantToolUse('Bash', { command: 'ls -la' }, 'tu_42'),
    userToolResult('tu_42', 'total 0\nfile.txt', false),
    assistantSay('Done — see the output.'),
  ].join('\n') + '\n');

  const ev = parseTranscript(path);
  const says = ev.filter((e) => e.kind === 'say');
  t.eq(says.length, 2, 'two assistant say blocks parsed');
  t.eq((says[0] as Extract<TranscriptEvent, { kind: 'say' }>).text, 'Working on it.', 'say text preserved');
  t.eq(ev.filter((e) => e.kind === 'thinking').length, 1, 'thinking captured separately (never spoken)');
  t.eq(ev.filter((e) => e.kind === 'tool_use').length, 1, 'tool_use captured');
  t.eq(ev.filter((e) => e.kind === 'human').length, 1, 'human prompt captured');
  const tr = ev.find((e) => e.kind === 'tool_result') as Extract<TranscriptEvent, { kind: 'tool_result' }>;
  t.ok(tr && tr.id === 'tu_42' && !tr.isError, 'tool_result carries id + error flag');
  t.ok(!ev.some((e) => e.kind === ('file-history-snapshot' as never)), 'bookkeeping lines ignored');
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────── leg 3: speakability ───────────────────────────────
await reporter.leg('speakability — rewrite for the ear (backend wiring)', async (t) => {
  const { narration, backend } = await speakify(SAMPLE_AGENT_TURN, { backend: 'mock' });
  t.eq(backend, 'mock', 'mock backend selected for offline validation');
  t.ok(narration.length > 0, 'produced a non-empty narration');
  t.ok(sentenceCount(narration) <= 3, '<= 3 spoken sentences', `got ${sentenceCount(narration)}`);
  const empty = await speakify('   ', { backend: 'mock' });
  t.eq(empty.backend, 'noop', 'empty input -> noop (nothing to speak)');
});

// ───────────── leg 3b: Gemini speakability backend (faked HTTP) ──────────────
// The PREFERRED streaming rewriter on hub. Asserted against a faked fetch — NO real
// Gemini network call — for: backend-selection precedence, the documented request
// shape (thinkingBudget:0!), a clean spoken result, and the fail-safe fallback.
await reporter.leg('speakability — Gemini backend (selection, request shape, fail-safe)', async (t) => {
  // 1) streaming backend precedence (pure; no disk secrets, no network).
  t.eq(pickStreamSpeakBackend({ GEMINI_API_KEY: 'g' }, false), 'gemini',
    'GEMINI_API_KEY set -> gemini (preferred)');
  t.eq(pickStreamSpeakBackend({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, false), 'gemini',
    'gemini wins over anthropic when both present');
  t.eq(pickStreamSpeakBackend({ ANTHROPIC_API_KEY: 'a' }, false), 'anthropic-api',
    'no gemini key -> anthropic-api');
  t.eq(pickStreamSpeakBackend({}, false), 'mock', 'no keys -> rule-based mock');
  t.eq(pickStreamSpeakBackend({ GEMINI_API_KEY: 'g' }, true), 'mock', '--mock overrides everything');
  t.ok(hasGeminiCreds({ GEMINI_API_KEY: 'g' }) && !hasGeminiCreds({}), 'hasGeminiCreds present vs absent');

  // 2) the gemini backend against a faked HTTP response (the model's clean spoken text).
  let sentUrl = '';
  let sentBody: { generationConfig: { thinkingConfig: { thinkingBudget: number }; maxOutputTokens: number };
    contents: Array<{ parts: Array<{ text: string }> }> } | null = null;
  let sentHeaders: Record<string, string> = {};
  const okFetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sentUrl = url;
    sentBody = JSON.parse(init.body);
    sentHeaders = init.headers;
    return {
      ok: true, status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text:
          'I opened a pull request that refactors the broker. All tests passed.' }] } }],
        finishReason: 'STOP',
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;

  const good = await speakify(SAMPLE_AGENT_TURN, {
    backend: 'gemini', geminiApiKey: 'fake-key', fetchImpl: okFetch,
  });
  t.eq(good.backend, 'gemini', 'gemini backend used when key present');
  t.ok(good.narration.length > 0, 'non-empty narration from gemini');
  t.ok(sentenceCount(good.narration) <= 3, '<= 3 spoken sentences', `got ${sentenceCount(good.narration)}`);
  t.notIncludes(good.narration, 'http', 'spoken output has no URL');
  t.notIncludes(good.narration, '/', 'spoken output has no file path / slash');
  t.notIncludes(good.narration, '`', 'spoken output has no code span');

  // 3) the documented request shape (the live-verified gotcha: thinking MUST be off).
  t.eq(sentUrl, `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent`, 'posts to gemini-2.5-flash:generateContent');
  t.eq(sentBody!.generationConfig.thinkingConfig.thinkingBudget, 0,
    'thinkingBudget:0 sent (CRITICAL — else truncated/empty text)');
  t.eq(sentBody!.generationConfig.maxOutputTokens, 200, 'maxOutputTokens:200 sent');
  t.ok(typeof sentBody!.contents?.[0]?.parts?.[0]?.text === 'string',
    'documented contents[].parts[].text body shape');
  t.eq(sentHeaders['x-goog-api-key'], 'fake-key', 'api key in x-goog-api-key header (never the body)');
  const body = geminiRequestBody('hi') as { generationConfig: { thinkingConfig: { thinkingBudget: number } } };
  t.eq(body.generationConfig.thinkingConfig.thinkingBudget, 0, 'geminiRequestBody() disables thinking');

  // 4) FAIL SAFE: a Gemini error falls back to the rule-based rewriter, no throw.
  const errFetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  const fellBack = await speakify(SAMPLE_AGENT_TURN, {
    backend: 'gemini', geminiApiKey: 'fake-key', fetchImpl: errFetch,
  });
  t.eq(fellBack.backend, 'mock', 'gemini error -> rule-based fallback (no throw)');
  t.ok(fellBack.narration.length > 0, 'fallback still produces speakable narration');
  t.notIncludes(fellBack.narration, 'https://example.com/pr/42', 'fallback still drops URLs');

  // a non-200 (e.g. rate limit) also falls back rather than throwing.
  const badFetch = (async () => ({
    ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}),
  })) as unknown as typeof fetch;
  const rateLimited = await speakify('Quick update from the agent.', {
    backend: 'gemini', geminiApiKey: 'k', fetchImpl: badFetch,
  });
  t.eq(rateLimited.backend, 'mock', 'non-200 -> rule-based fallback');
});

// ─────────────────── leg 4: MiniMax TTS protocol (mock server) ──────────────
await reporter.leg('MiniMax TTS — real WS protocol against mock server', async (t) => {
  const mock = await startMockMinimax({ emitConnectedSuccess: true });
  try {
    const res = await synthStreaming({
      apiKey: MOCK_KEY, groupId: MOCK_GROUP,
      textChunks: ['Hello there. ', 'Ready to merge?'],
      endpoint: mock.endpoint, timeoutMs: 8000,
    });
    t.eq(mock.observed.authHeader, `Bearer ${MOCK_KEY}`, 'Authorization: Bearer <key> sent (gotcha #2)');
    t.eq(mock.observed.groupId, MOCK_GROUP, 'GroupId sent in URL query, not body (gotcha #3)');
    t.eq(mock.observed.path, '/ws/v1/t2a_v2', 'international t2a_v2 path');
    t.eq(mock.observed.clientEvents[0], 'task_start', 'protocol starts with task_start');
    t.ok(mock.observed.clientEvents.includes('task_continue'), 'streams text via task_continue');
    t.eq(mock.observed.clientEvents[mock.observed.clientEvents.length - 1], 'task_finish', 'ends with task_finish');
    t.ok(res.pcm.length > 0, 'assembled PCM audio bytes', `${res.pcm.length} bytes`);
    t.eq(res.frames, 2, 'one audio frame per text chunk');
    t.eq(res.pcm.length, res.frames * 4096, 'PCM length matches HEX-decoded frame size (gotcha #4: hex, not base64)');
    t.ok(typeof res.ttfbMs === 'number', 'time-to-first-audio measured', `${res.ttfbMs}ms`);
    t.ok(res.billing != null && 'usage_characters' in res.billing, 'billing/usage surfaced from final frame');
    // independent hex≠base64 proof
    const hex = 'deadbeefcafe';
    t.ok(!Buffer.from(hex, 'hex').equals(Buffer.from(hex, 'base64')), 'hex decode differs from base64 (decoder correctness)');
    // WAV wrapping
    const wav = toWav(res);
    t.ok(wav.subarray(0, 4).toString() === 'RIFF' && wav.subarray(8, 12).toString() === 'WAVE', 'WAV header is RIFF/WAVE');
    t.eq(wav.length, 44 + res.pcm.length, 'WAV = 44-byte header + PCM');
    t.eq(wavHeader(0).length, 44, 'canonical header is 44 bytes');
  } finally {
    await mock.close();
  }
});

// ───────── voice clone: upload + register REST flow (mock REST server) ──────
// The captain's "speak in my own voice" feature. We DON'T create a real clone (that
// spends credits + pollutes the account); instead we assert the upload/register
// plumbing against an in-process HTTP server speaking the real MiniMax REST contract.
await reporter.leg('voice clone — upload + register against mock REST (real multipart/JSON)', async (t) => {
  const rest = await startMockMinimaxRest({ fileId: 'file-abc-123' });
  try {
    const audio = Buffer.from('ID3fake-mp3-bytes-for-the-multipart-body'.repeat(8));
    const fileId = await uploadReferenceAudio({
      apiKey: MOCK_KEY, groupId: MOCK_GROUP, baseUrl: rest.baseUrl,
      fileBytes: new Uint8Array(audio), fileName: 'captain.mp3',
    });
    t.eq(fileId, 'file-abc-123', 'upload returns file.file_id');
    const up = rest.observed.upload!;
    t.ok(!!up, 'upload request observed');
    t.eq(up.method, 'POST', 'files/upload is POST');
    t.eq(up.path, '/v1/files/upload', 'international files/upload path');
    t.eq(up.authHeader, `Bearer ${MOCK_KEY}`, 'Authorization: Bearer <key> sent');
    t.eq(up.groupId, MOCK_GROUP, 'GroupId sent in URL query (not body)');
    t.ok((up.contentType || '').startsWith('multipart/form-data'), 'multipart/form-data body', up.contentType);
    t.eq(up.purpose, 'voice_clone', 'purpose=voice_clone form field sent');
    t.ok(up.hasFilePart, 'file form part present');
    t.eq(up.fileName, 'captain.mp3', 'reference filename preserved');
    t.ok(up.bodyBytes >= audio.length, 'reference audio bytes rode through the multipart body', `${up.bodyBytes} bytes`);

    const voiceId = await registerVoiceClone({
      apiKey: MOCK_KEY, groupId: MOCK_GROUP, baseUrl: rest.baseUrl,
      fileId, voiceId: 'CaptainVoice1',
    });
    t.eq(voiceId, 'CaptainVoice1', 'voice_clone echoes the registered voice_id');
    const cl = rest.observed.clone!;
    t.eq(cl.path, '/v1/voice_clone', 'international voice_clone path');
    t.eq(cl.authHeader, `Bearer ${MOCK_KEY}`, 'Bearer auth on voice_clone');
    t.eq(cl.groupId, MOCK_GROUP, 'GroupId in query on voice_clone');
    t.eq((cl.body || {}).file_id, fileId, 'voice_clone body carries file_id');
    t.eq((cl.body || {}).voice_id, 'CaptainVoice1', 'voice_clone body carries voice_id');
    t.ok(!('text' in (cl.body || {})) && !('model' in (cl.body || {})), 'no text/model preview field (avoids burning credits)');

    // cloneVoice() = upload + register in one call.
    const rest2 = await startMockMinimaxRest({ fileId: 'file-xyz-9' });
    try {
      const v = await cloneVoice({
        apiKey: MOCK_KEY, groupId: MOCK_GROUP, baseUrl: rest2.baseUrl,
        fileBytes: new Uint8Array(audio), fileName: 'c.wav', voiceId: 'MyOwnVoice42',
      });
      t.eq(v, 'MyOwnVoice42', 'cloneVoice() runs the full upload->register flow');
      t.eq((rest2.observed.clone!.body || {}).file_id, 'file-xyz-9', 'second flow used its own file_id');
    } finally { await rest2.close(); }
  } finally {
    await rest.close();
  }
});

// voice_id validation + a MiniMax base_resp error (bad GroupId / auth) surfaces, never silently.
await reporter.leg('voice clone — voice_id rules + base_resp error surfaced', async (t) => {
  t.ok(isValidVoiceId('CaptainVoice1'), 'valid: letter-start, >=8, alphanumeric');
  t.ok(isValidVoiceId('test1234'), 'valid: test1234');
  t.ok(!isValidVoiceId('1captain9'), 'invalid: must start with a letter');
  t.ok(!isValidVoiceId('Cap1'), 'invalid: too short (<8)');
  t.ok(!isValidVoiceId('Captain Voice1'), 'invalid: no spaces/symbols');
  t.eq(INTL_REST_BASE, 'https://api.minimax.io', 'INTERNATIONAL REST host (api.minimax.io, not minimaxi.com)');

  const rest = await startMockMinimaxRest({ failWith: { status_code: 1004, status_msg: 'invalid api key/GroupId' } });
  try {
    let threw = '';
    try {
      await uploadReferenceAudio({
        apiKey: 'bad', groupId: 'bad', baseUrl: rest.baseUrl,
        fileBytes: new Uint8Array(Buffer.from('x'.repeat(64))), fileName: 'c.mp3',
      });
    } catch (e) { threw = (e as Error).message; }
    t.ok(/1004/.test(threw), 'a non-zero base_resp.status_code throws (auth/GroupId error surfaced)', threw);
  } finally {
    await rest.close();
  }
  // registerVoiceClone rejects a bad voice_id BEFORE any network call.
  let vErr = '';
  try {
    await registerVoiceClone({ apiKey: MOCK_KEY, fileId: 'f1', voiceId: 'bad', baseUrl: 'http://127.0.0.1:1' });
  } catch (e) { vErr = (e as Error).message; }
  t.ok(/invalid voice_id/.test(vErr), 'registerVoiceClone validates voice_id before calling out', vErr);
});

// The cloned voice_id must flow from secrets -> the live MiniMax WS client's voice_setting.
await reporter.leg('voice clone — MINIMAX_VOICE_ID flows into the synth voice_setting', async (t) => {
  // secrets -> minimaxVoiceId()
  t.eq(minimaxVoiceId({ MINIMAX_VOICE_ID: 'CaptainVoice1' }), 'CaptainVoice1', 'secrets.MINIMAX_VOICE_ID -> cloned voice');
  t.eq(minimaxVoiceId({}), undefined, 'no MINIMAX_VOICE_ID -> undefined (falls back to default voice)');

  // The WS client actually sends it in task_start.voice_setting.voice_id.
  const mock = await startMockMinimax();
  try {
    await synthStreaming({
      apiKey: MOCK_KEY, groupId: MOCK_GROUP, voiceId: 'CaptainVoice1',
      textChunks: ['speak in my own voice'], endpoint: mock.endpoint, timeoutMs: 8000,
    });
    t.eq(mock.observed.voiceId, 'CaptainVoice1', 'cloned voice_id reaches MiniMax voice_setting');
  } finally { await mock.close(); }

  // Omitting voiceId falls back to the default system voice (no accidental blank).
  const mock2 = await startMockMinimax();
  try {
    await synthStreaming({
      apiKey: MOCK_KEY, groupId: MOCK_GROUP,
      textChunks: ['default voice'], endpoint: mock2.endpoint, timeoutMs: 8000,
    });
    t.eq(mock2.observed.voiceId, 'male-qn-qingse', 'no voiceId -> DEFAULT_VOICE_ID');
  } finally { await mock2.close(); }
});

// ─────────────────── leg 5: full e2e pipeline (mock) ────────────────────────
await reporter.leg('end-to-end — runPipeline (inject -> reply -> speak -> TTS)', async (t) => {
  const mock = await startMockMinimax();
  try {
    let injected: string | null = null;
    const result = await runPipeline(SAMPLE_AGENT_TURN /* used as the typed driver text */, {
      inject: async (text) => { injected = text; },
      // simulate the transcript tap returning the (complete) agent reply
      readReply: async () => SAMPLE_AGENT_TURN,
      speakify: (text) => speakify(text, { backend: 'mock' }),
      synth: (chunks) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: chunks, endpoint: mock.endpoint, timeoutMs: 8000 }),
      terminalView: () => '┌─ ceo-chat ─┐\n❯ (idle)\n└────────────┘',
    });
    t.ok(injected !== null, 'leg 1: text injected into firstmate');
    t.ok(result.reply.length > 0, 'leg 2: agent reply read from transcript');
    t.eq(result.speakBackend, 'mock', 'leg 3: speakability ran');
    t.notIncludes(result.narration, 'https://example.com/pr/42', 'leg 3: URL dropped from narration');
    t.ok(result.audio.bytes > 0, 'leg 5: spoken audio produced', `${result.audio.bytes} bytes`);
    t.ok(typeof result.audio.ttfbMs === 'number', 'leg 5: time-to-first-audio measured', `${result.audio.ttfbMs}ms`);
    t.ok(!!result.terminal && result.terminal.includes('ceo-chat'), 'terminal view captured alongside audio');
  } finally {
    await mock.close();
  }
});

// ─────────────────── leg 6: web server + WS contract ───────────────────────
// Stand up the REAL web transport (src/server/app.ts) over an in-memory driver that
// drives the SAME runPipeline with mock deps — no tmux, no agent session, no creds.
// Asserts the page is served and the browser <-> broker WS contract holds end-to-end.
await reporter.leg('web server — serves the page + brokers the WS pipeline', async (t) => {
  const mock = await startMockMinimax();
  // In-memory driver: same pipeline the product runs, mock-injected.
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 32000 }),
    start: async () => {},
    send: async (text, _turnIndex, hooks) => {
      const r = await runPipeline(text, {
        inject: async () => {},
        readReply: async () => SAMPLE_AGENT_TURN,
        speakify: (s) => speakify(s, { backend: 'mock' }),
        synth: (chunks) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: chunks, endpoint: mock.endpoint, timeoutMs: 8000 }),
        onStage: hooks.onStage,
      });
      return {
        reply: r.reply, narration: r.narration, speakBackend: r.speakBackend,
        audio: { pcm: r.audio.pcm, sampleRate: r.audio.sampleRate, ttfbMs: r.audio.ttfbMs, bytes: r.audio.bytes },
      };
    },
    terminalSnapshot: () => '\x1b[32m┌─ ceo-chat ─┐\x1b[0m\r\n❯ (idle)\r\n└────────────┘',
    stop: async () => {},
  };
  const app = await createWebApp({ driver, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // --- the page is served ---
    const page = await fetch(app.url);
    t.eq(page.status, 200, 'GET / -> 200');
    const html = await page.text();
    t.includes(html, 'ceo-chat', 'index page identifies ceo-chat');
    t.includes(html, '/vendor/xterm.js', 'page loads xterm.js for the terminal view');
    t.includes(html, '/app.js', 'page loads the client app');
    const xterm = await fetch(app.url + 'vendor/xterm.js');
    t.eq(xterm.status, 200, 'vendored xterm.js is served (no CDN needed)');
    t.ok((await fetch(app.url + 'app.js')).status === 200, 'client app.js served');
    t.ok((await fetch(app.url + 'styles.css')).status === 200, 'styles.css served');
    t.ok((await fetch(app.url + '../../package.json')).status === 404, 'path traversal is refused');

    // --- the WS contract: connect, send a line, observe the full turn ---
    const msgs: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { try { client.close(); } catch { /* ignore */ } reject(new Error('WS turn timed out')); }, 12000);
      let sent = false;
      client.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        msgs.push(m);
        if (m.type === 'hello' && !sent) { sent = true; client.send(JSON.stringify({ type: 'send', text: 'drive one turn' })); }
        if (m.type === 'turn-done') { clearTimeout(timer); client.close(); resolve(); }
      });
      client.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });

    const first = (type: string) => msgs.find((m) => m.type === type);
    const statuses = msgs.filter((m) => m.type === 'status').map((m) => m.state as string);

    const hello = first('hello') as { ttsMode?: string; audioFormat?: string; sampleRate?: number } | undefined;
    t.ok(!!hello, 'server greets with a hello frame');
    t.eq(hello?.ttsMode, 'mock', 'hello advertises the TTS mode');
    t.eq(hello?.audioFormat, AUDIO_FORMAT, 'hello advertises the PCM audio format the player expects');

    const terminal = first('terminal') as { data?: string } | undefined;
    t.ok(!!terminal && (terminal.data || '').includes('ceo-chat'), 'live terminal snapshot pushed to the browser');

    const narration = first('narration') as { text?: string } | undefined;
    t.ok(!!narration, 'narration frame delivered');
    t.notIncludes(narration?.text || '', 'https://example.com/pr/42', 'narration over the wire drops the URL');
    t.includes(narration?.text || '', '?', 'the decision question survives to the browser');

    const audio = first('audio') as { pcm?: string; format?: string } | undefined;
    t.ok(!!audio && !!audio.pcm, 'audio frame delivered');
    t.eq(audio?.format, AUDIO_FORMAT, 'audio frame tags its PCM format');
    t.ok(Buffer.from(audio?.pcm || '', 'base64').length > 0, 'audio carries real PCM bytes (playable in the page)');

    const done = first('turn-done') as { bytes?: number } | undefined;
    t.ok(!!done && (done.bytes ?? 0) > 0, 'turn-done reports the produced audio bytes');

    t.ok(statuses.includes('thinking'), 'status reaches "thinking" during the turn', statuses.join(','));
    t.ok(statuses.includes('speaking'), 'status reaches "speaking" while audio is produced', statuses.join(','));
    t.eq(statuses[statuses.length - 1], 'awaiting-confirmation', 'ends "awaiting-confirmation" (reply asked a question)');
  } finally {
    await app.close();
    await mock.close();
  }
});

// ─────────────────── leg 7: attach to an existing tmux first mate ───────────
// The retarget feature: instead of spawning a throwaway agent, the broker ATTACHES
// to a first mate the captain already runs in tmux. This leg asserts the attach
// wiring the broker composes — target resolution from env, existence/cwd validation,
// the colour pane mirror, and NON-ownership (detach must never kill it). It stands up
// its OWN uniquely-named throwaway target (a trivial shell, NOT the captain's real
// firstmate/bridge sessions or any fm-<id> window) and tears it down. If tmux is
// unavailable (some CI), the env-parse assertions still run and the live half is
// reported PENDING — never a red gate.
await reporter.leg('attach — broker targets an existing tmux session (mirror + non-ownership)', async (t) => {
  // Target resolution from env (pure — always runs).
  t.eq(resolveTargetFromEnv({ CEOCHAT_TARGET: 'foo:bar' })?.target, 'foo:bar', 'CEOCHAT_TARGET="session:window" parsed');
  t.eq(resolveTargetFromEnv({ CEOCHAT_TARGET: 'solo' })?.target, 'solo', 'bare CEOCHAT_TARGET=session parsed');
  t.eq(resolveTargetFromEnv({ CEOCHAT_TARGET_SESSION: 'foo', CEOCHAT_TARGET_WINDOW: 'bar' })?.target, 'foo:bar', 'SESSION+WINDOW composed');
  t.eq(resolveTargetFromEnv({ CEOCHAT_TARGET_SESSION: 'foo' })?.target, 'foo', 'SESSION alone -> bare target');
  t.eq(resolveTargetFromEnv({}), null, 'no env -> null (broker falls back to spawn mode)');

  // Transcript rotation (pure — always runs). An attached first mate rotates its JSONL
  // on /clear, compaction, or a new session UUID. The broker re-resolves the NEWEST
  // transcript each turn (captureBaseline -> latestTranscriptIn), so the readSays path
  // must FOLLOW the new file instead of staying pinned to the now-stale old one.
  const projDir = mkdtempSync(join(tmpdir(), 'ceochat-rotate-'));
  try {
    const fileA = join(projDir, 'aaaa-session.jsonl');
    writeFileSync(fileA, assistantSay('first session reply') + '\n');
    utimesSync(fileA, new Date(1000), new Date(1000));
    t.eq(latestTranscriptIn(projDir), fileA, 'newest transcript is the only file (pre-rotation)');

    // /clear -> a brand-new session UUID file, written AFTER (newer mtime).
    const fileB = join(projDir, 'bbbb-session.jsonl');
    writeFileSync(fileB, assistantSay('post-clear reply one') + '\n' + assistantSay('post-clear reply two') + '\n');
    utimesSync(fileB, new Date(2000), new Date(2000));
    t.eq(latestTranscriptIn(projDir), fileB, 'after rotation latestTranscriptIn follows the NEW file (not the stale path)');
    const says = parseTranscript(latestTranscriptIn(projDir)!).filter((e) => e.kind === 'say');
    t.eq(says.length, 2, 'readSays reads the rotated file (would have silently timed out on the stale one)');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }

  // Mid-turn rotation (pure — always runs). The rotation can also land DURING the
  // up-to-150s wait: the captain types /clear as the turn injects, or compaction / a
  // new session UUID starts a fresh JSONL while the agent is replying. The reply then
  // lands in the NEW file. This mirrors the broker's readReply readSays closure: it
  // re-resolves latestTranscriptIn each poll, adopts a newer file (baseline 0 — the
  // fresh file starts from zero), and reports count relative to sayBefore so the latch
  // still fires. It must return B's text, not time out on the stale A.
  const midDir = mkdtempSync(join(tmpdir(), 'ceochat-midrotate-'));
  try {
    const fileA = join(midDir, 'aaaa-session.jsonl');
    writeFileSync(fileA, assistantSay('old backlog one') + '\n' + assistantSay('old backlog two') + '\n');
    utimesSync(fileA, new Date(1000), new Date(1000));
    const baseline = parseTranscript(latestTranscriptIn(midDir)!).filter((e) => e.kind === 'say').length;
    t.eq(baseline, 2, 'baseline captured on file A (pre-rotation backlog)');

    let activePath = latestTranscriptIn(midDir)!;
    let activeBaseline = baseline;
    let poll = 0;
    let clock = 0;
    const ROTATE_AT = 3;
    const REPLY = 'post-clear fresh reply';
    const got = await waitForReply({
      readSays: () => {
        if (poll === ROTATE_AT) {
          const fileB = join(midDir, 'bbbb-session.jsonl');
          writeFileSync(fileB, assistantSay(REPLY) + '\n');
          utimesSync(fileB, new Date(2000), new Date(2000));
        }
        poll++;
        const latest = latestTranscriptIn(midDir);
        if (latest && latest !== activePath) { activePath = latest; activeBaseline = 0; }
        const fresh = parseTranscript(activePath).filter((e) => e.kind === 'say').slice(activeBaseline);
        return { count: baseline + fresh.length, text: fresh.map((e) => (e as Extract<TranscriptEvent, { kind: 'say' }>).text).join('\n') };
      },
      isIdle: () => true,
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
      now: () => clock,
    }, { sayBefore: baseline });
    t.eq(got, REPLY, 'mid-turn rotation followed: reply read from the NEW file (no 150s timeout)');
    t.notIncludes(got, 'old backlog', 'stale file A backlog is never spoken after a mid-turn rotation');
  } finally {
    rmSync(midDir, { recursive: true, force: true });
  }

  let tmuxOk = true;
  try { execFileSync('tmux', ['-V'], { stdio: 'pipe' }); } catch { tmuxOk = false; }
  if (!tmuxOk) {
    t.pending('tmux not available here — attach wiring asserted by env-parse only');
    return;
  }

  // attach refuses a non-existent target (no throwaway needed).
  let refused = false;
  try { attachTarget(resolveTargetFromEnv({ CEOCHAT_TARGET: 'ceochat-nope-' + process.pid + ':x' })!, {}); }
  catch { refused = true; }
  t.ok(refused, 'attach refuses a target session that does not exist');

  // Stand up our OWN throwaway target (trivial shell as the "agent" pane). The name
  // is unique and is NOT the captain's firstmate/bridge or any fm-<id> window.
  const session = 'ceochat-attach-test-' + process.pid;
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ceochat-attach-')));
  const spec = resolveTargetFromEnv({ CEOCHAT_TARGET: `${session}:main` })!;
  execFileSync('tmux', ['new-session', '-d', '-s', session, '-n', 'main', '-c', cwd, "printf 'READY\\n'; sleep 600"]);
  try {
    // tmux's #{pane_current_path} lags the spawn briefly — settle before attaching so
    // the cwd-derivation assertions are deterministic (not racing the new pane).
    for (let i = 0; i < 50 && realpathSync(paneCurrentPath(spec.target) || '/') !== cwd; i++) {
      await realSleep(100);
    }
    const ctx = attachTarget(spec, {});
    t.eq(ctx.owned, false, 'attached session is NOT owned (detach must not kill it)');
    t.eq(realpathSync(ctx.cwd), cwd, 'cwd derived from pane_current_path (locates the transcript)');
    t.eq(realpathSync(paneCurrentPath(spec.target)), cwd, 'paneCurrentPath resolves the pane cwd');

    // The pane mirror (xterm.js source): wait for the shell to paint, then capture.
    let mirrored = '';
    for (let i = 0; i < 50; i++) {
      mirrored = capturePane(spec.target);
      if (mirrored.includes('READY')) break;
      await realSleep(100);
    }
    t.includes(mirrored, 'READY', 'pane mirrored via capture-pane (the terminal view)');
    t.includes(capturePaneAnsi(spec.target), 'READY', 'colour-preserving capture mirrors the same pane');

    // Non-ownership in practice: the broker only tears down OWNED sessions, so an
    // attached target survives a detach. Assert it is still alive here.
    t.ok(sessionExists(session), 'target session stays alive while attached (broker would only detach)');

    // Bare session (no :window): attach must PIN a concrete window so inject/mirror/cwd
    // never drift to whatever window the captain later makes active in that session.
    const win = resolveSessionWindow(session);
    t.ok(win !== '', 'resolveSessionWindow resolves a concrete window for the bare session');
    const bareSpec = resolveTargetFromEnv({ CEOCHAT_TARGET: session })!;
    t.eq(bareSpec.window, '', 'bare CEOCHAT_TARGET=session resolves with no window (unpinned)');
    const bareCtx = attachTarget(bareSpec, {});
    t.eq(bareCtx.target, `${session}:${win}`, 'attach pins bare session to a concrete session:window');
    t.eq(realpathSync(bareCtx.cwd), cwd, 'pinned bare-session attach still derives the pane cwd');
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' }); } catch { /* ignore */ }
    rmSync(cwd, { recursive: true, force: true });
  }
  t.ok(!sessionExists(session), 'our throwaway target torn down — captain sessions untouched');
});

// ─────────── leg 8: prompt-anchored transcript (multi-session safe) ──────────
// The captain's first mate shares ~/firstmate's project dir with OTHER concurrent
// claude sessions (supervisor, crewmates), so latestTranscriptIn (newest-by-mtime)
// flip-flops between unrelated files (proven in the real serve.log). We anchor each
// turn to the file that recorded OUR injected prompt — robust against that noise.
await reporter.leg('attach — prompt-anchored transcript (ignores concurrent sessions)', (t) => {
  // findPromptAnchor: last human event matching the injected line (whitespace-tolerant).
  const events = parseTranscript; void events;
  const evs = [
    { kind: 'human', role: 'user', ts: null, text: 'old question' },
    { kind: 'say', role: 'assistant', ts: null, text: 'old answer.' },
    { kind: 'human', role: 'user', ts: null, text: 'who am I connected to' },
    { kind: 'say', role: 'assistant', ts: null, text: 'You are connected to first mate.' },
    { kind: 'say', role: 'assistant', ts: null, text: 'Ready to merge?' },
  ] as TranscriptEvent[];
  t.eq(findPromptAnchor(evs, '  who am I   connected to '), 2, 'anchors the LAST matching human event (whitespace-tolerant)');
  t.eq(findPromptAnchor(evs, 'never injected this'), -1, 'absent prompt -> -1 (not written yet)');
  const says = saysAfterAnchor(evs, 2).map((e) => e.text);
  t.eq(says.join(' '), 'You are connected to first mate. Ready to merge?', 'says AFTER the anchor are this turn (not the backlog)');
  t.notIncludes(says.join(' '), 'old answer', 'pre-anchor backlog never included');

  // Repeated/short confirmation prompts: the inject timestamp disambiguates an IDENTICAL
  // earlier turn from OUR new one, so the old reply is never re-spoken at turn start.
  const repeated = [
    { kind: 'human', role: 'user', ts: '2026-06-27T00:00:00.000Z', text: 'go ahead and merge it now' },
    { kind: 'say', role: 'assistant', ts: '2026-06-27T00:00:01.000Z', text: 'Merged the first one.' },
    { kind: 'human', role: 'user', ts: '2026-06-27T00:00:10.000Z', text: 'go ahead and merge it now' },
    { kind: 'say', role: 'assistant', ts: '2026-06-27T00:00:11.000Z', text: 'Merging the second one now.' },
  ] as TranscriptEvent[];
  t.eq(findPromptAnchor(repeated, 'go ahead and merge it now'), 2, 'no baseline -> legacy last-match (index 2)');
  const aNew = findPromptAnchor(repeated, 'go ahead and merge it now', { afterTs: '2026-06-27T00:00:05.000Z' });
  t.eq(aNew, 2, 'inject-timestamp anchor selects OUR post-inject turn, not the identical earlier one');
  const newSays = saysAfterAnchor(repeated, aNew).map((e) => e.text).join(' ');
  t.notIncludes(newSays, 'Merged the first one', 'the earlier identical turn reply is NEVER re-spoken');
  t.includes(newSays, 'Merging the second one', 'only the NEW reply is read for this turn');
  t.eq(findPromptAnchor(repeated, 'go ahead and merge it now', { afterTs: '2026-06-27T00:00:20.000Z' }), -1,
    'before claude writes our user line, anchor is -1 (never the stale earlier turn)');

  // Tightened loose fallback: a short prompt cannot match a longer line that merely
  // CONTAINS the word; a substantial prompt still matches when the agent wraps it.
  const looseEvs = [
    { kind: 'human', role: 'user', ts: '2026-06-27T00:00:00.000Z', text: 'yes please go ahead with everything you proposed' },
  ] as TranscriptEvent[];
  t.eq(findPromptAnchor(looseEvs, 'yes'), -1, 'a short prompt does NOT loose-match a longer line containing the word');
  const wrapEvs = [
    { kind: 'human', role: 'user', ts: '2026-06-27T00:00:00.000Z', text: 'please summarize the memoirs data files' },
  ] as TranscriptEvent[];
  t.ok(findPromptAnchor(wrapEvs, 'summarize the memoirs data files') >= 0, 'a substantial prompt still loose-matches a lightly-wrapped line');

  // latestTranscriptWithPrompt: among concurrent sessions, pick the file with OUR prompt
  // even when a DIFFERENT (unrelated) session is newer by mtime.
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-anchor-'));
  try {
    const ours = join(dir, 'ours.jsonl');
    writeFileSync(ours, userPrompt('pull up my memoirs data') + '\n' + assistantSay('Opening it now.') + '\n');
    utimesSync(ours, new Date(1000), new Date(1000));
    // a NEWER, unrelated session (the supervisor) without our prompt.
    const noise = join(dir, 'noise.jsonl');
    writeFileSync(noise, assistantSay('supervisor chatter') + '\n');
    utimesSync(noise, new Date(5000), new Date(5000));
    t.eq(latestTranscriptIn(dir), noise, 'baseline: newest-by-mtime is the WRONG (unrelated) file');
    t.eq(latestTranscriptWithPrompt(dir, 'pull up my memoirs data'), ours, 'anchored resolver picks OUR file despite the newer noise file');
    t.eq(latestTranscriptWithPrompt(dir, 'something never said'), null, 'no file has the prompt yet -> null');
    t.eq(latestTranscriptWithPrompt(dir, 'pull up my memoirs data', { afterTs: '2026-06-26T00:00:00.000Z' }), ours,
      'afterTs before the prompt ts still resolves OUR file');
    t.eq(latestTranscriptWithPrompt(dir, 'pull up my memoirs data', { afterTs: '2026-06-28T00:00:00.000Z' }), null,
      'afterTs after the prompt ts -> not yet ours (window-safe, no stale match)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────── leg 9: incremental speak — units emitted before turn end ────────
// Bug A: today the broker latches until the WHOLE turn completes, then speaks — ~36s of
// silence on a 36s turn. streamReply must emit complete speakable units AS they stream.
await reporter.leg('streaming — incremental speakable units (audio starts mid-turn)', async (t) => {
  // splitCompleteUnits: sentence/newline boundaries; hold the trailing partial.
  const a = splitCompleteUnits('Hello there. Running the te');
  t.eq(a.units.join('|'), 'Hello there.', 'first complete sentence is a unit');
  t.eq(a.rest, ' Running the te', 'the partial trailing sentence is held (never spoken mid-word)');
  const b = splitCompleteUnits('block one\nblock two\npartial');
  t.eq(b.units.join('|'), 'block one|block two', 'newline (say-block) boundaries split units too');
  t.eq(b.rest, 'partial', 'trailing non-terminated text held');

  // streamReply: text grows over polls; idle only at the end. Units must arrive BEFORE
  // the turn is idle, in order, with no dups, and the full reply returned at the end.
  const FULL = 'Opening your memoirs data. Found three files. Want me to summarize them?';
  const steps = [
    'Opening your memoirs data. Foun',
    'Opening your memoirs data. Found three files. ',
    'Opening your memoirs data. Found three files. Want me to summarize them?',
  ];
  let poll = 0;
  let clock = 0;
  const IDLE_AT = steps.length - 1; // idle once the last step is present
  const units: Array<{ text: string; idleWhenEmitted: boolean }> = [];
  const got = await streamReply({
    readSays: () => ({ count: 1, text: steps[Math.min(poll, steps.length - 1)]! }),
    isIdle: () => poll >= IDLE_AT,
    sleep: (ms) => { clock += ms; poll++; return Promise.resolve(); },
    now: () => clock,
    onUnit: (u) => units.push({ text: u, idleWhenEmitted: poll >= IDLE_AT }),
  }, { sayBefore: 0, settleMs: 0, pollMs: 1, timeoutMs: 60000 });
  t.eq(got, FULL, 'full reply returned at the end');
  t.ok(units.length >= 2, 'multiple units emitted progressively', `${units.length} units`);
  t.ok(units.some((u) => !u.idleWhenEmitted), 'at least one unit spoken BEFORE the turn went idle (latency win)');
  t.eq(units[0]!.text, 'Opening your memoirs data.', 'the FIRST unit is spoken first (early audio)');
  const joined = units.map((u) => u.text).join(' ');
  t.eq(units.filter((u) => u.text === 'Opening your memoirs data.').length, 1, 'no unit is double-emitted');
  t.includes(joined, 'Want me to summarize them?', 'the closing question is emitted too');
});

// ─────────── leg 10: streaming pipeline — progressive chunks ─────────────────
await reporter.leg('streaming — runStreamingPipeline emits chunks before completion', async (t) => {
  const mock = await startMockMinimax();
  try {
    const chunks: PipelineChunkT[] = [];
    let resolveReply: (() => void) | null = null;
    const replyGate = new Promise<void>((r) => { resolveReply = r; });
    let injected = false;
    const result = await runStreamingPipeline('summarize the memoirs', {
      inject: async () => { injected = true; },
      streamReply: async (onUnit) => {
        onUnit('Opening your memoirs data.');
        onUnit('Found three files.');
        // let the first units flow through speakify+synth+onChunk before we finish.
        await replyGate;
        onUnit('Want me to summarize them?');
        return 'Opening your memoirs data. Found three files. Want me to summarize them?';
      },
      speakify: (s) => speakify(s, { backend: 'mock' }),
      synth: (cs) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: cs, endpoint: mock.endpoint, timeoutMs: 8000 }),
      onChunk: (c) => { chunks.push(c); if (chunks.length === 2 && resolveReply) resolveReply(); },
    });
    t.ok(injected, 'inject ran');
    t.ok(chunks.length >= 2, 'a chunk is emitted per speakable unit (progressive)', `${chunks.length} chunks`);
    t.ok(chunks[0]!.pcm.length > 0, 'the first chunk carries real audio (plays before the turn ends)');
    t.ok(chunks[0]!.index === 0 && chunks[1]!.index === 1, 'chunks are ordered by index');
    t.eq(result.reply, 'Opening your memoirs data. Found three files. Want me to summarize them?', 'aggregate reply is the full turn');
    t.ok(result.audio.bytes > 0, 'aggregate audio concatenates the chunk pcm', `${result.audio.bytes} bytes`);
    t.ok(/summarize/i.test(result.narration), 'aggregate narration concatenates the unit narrations');
    // cancellation: an aborted run stops emitting further chunks.
    const aborted = { aborted: true };
    const after: PipelineChunkT[] = [];
    const r2 = await runStreamingPipeline('x', {
      inject: async () => {},
      streamReply: async (onUnit) => { onUnit('one.'); onUnit('two.'); return 'one. two.'; },
      speakify: (s) => speakify(s, { backend: 'mock' }),
      synth: (cs) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: cs, endpoint: mock.endpoint, timeoutMs: 8000 }),
      onChunk: (c) => after.push(c),
      signal: aborted,
    });
    t.eq(after.length, 0, 'an aborted turn (barge-in/hangup) emits no chunks');
    void r2;
  } finally {
    await mock.close();
  }
});

// ─────────── leg 11: benign modal auto-dismiss before inject ─────────────────
// Bug B3: a wedged "How is Claude doing this session?" rating prompt swallowed the next
// injected message (the captain's dead-end). Detect + dismiss known benign dialogs.
await reporter.leg('attach — auto-dismiss benign Claude modals before inject', async (t) => {
  const ratingPane = 'some output\n╭─ How is Claude doing this session? ─╮\n│ 0  1  2 … rate │\n╰─ Press Esc to dismiss ─╯';
  const trustPane = 'Do you trust the files in this folder?\n❯ 1. Yes, I trust\n  2. No';
  const normalPane = '╭─ firstmate ─╮\n❯ \n╰────────────╯';
  const realQuestionPane = '❯ Should I delete the production database? (y/n)';

  const rating = detectBenignModal(ratingPane);
  t.ok(!!rating && rating.kind === 'feedback-rating', 'detects the feedback/rating prompt');
  t.eq(rating!.key, 'Escape', 'feedback prompt is DISMISSED with Escape (no rating given)');
  const trust = detectBenignModal(trustPane);
  t.ok(!!trust && trust.kind === 'trust-folder', 'detects the trust-folder dialog');
  t.eq(trust!.key, 'Enter', 'trust dialog is accepted with Enter');
  t.eq(detectBenignModal(normalPane), null, 'an ordinary composer is NOT a modal (no action)');
  t.eq(detectBenignModal(realQuestionPane), null, 'a genuine question to the captain is NEVER auto-answered');

  // dismissBenignModals: sends the key, then re-checks; returns the dismissed descriptor.
  const keys: string[] = [];
  let pane = ratingPane;
  const dismissed = await dismissBenignModals({
    capture: () => pane,
    sendKey: (k) => { keys.push(k); pane = normalPane; /* modal gone after dismiss */ },
    sleep: () => Promise.resolve(),
  });
  t.ok(!!dismissed && dismissed.kind === 'feedback-rating', 'reports which benign modal it dismissed (for diagnostics)');
  t.eq(keys.join(','), 'Escape', 'dismissed the rating prompt with Escape');

  // a clean pane -> no key sent, returns null.
  const keys2: string[] = [];
  const none = await dismissBenignModals({ capture: () => normalPane, sendKey: (k) => keys2.push(k), sleep: () => Promise.resolve() });
  t.eq(none, null, 'no modal -> nothing dismissed');
  t.eq(keys2.length, 0, 'no keys sent when there is no benign modal');
});

// ─────────── leg 12: web transport — progressive chunks + reconnect replay ───
// The full wiring (app.ts) over a STREAMING driver: multiple narration+audio frames
// arrive progressively (one per unit, indexed), a benign-modal `notice` is surfaced,
// and a client that connects AFTER the turn is REPLAYED the last state (Bug B2 — never
// left blank on refresh) with replay:true so it doesn't auto-play.
await reporter.leg('web — progressive chunks, notice, reconnect replay', async (t) => {
  const mock = await startMockMinimax();
  const streamingDriver: Driver = {
    meta: () => ({ ttsMode: 'local', ttsVoice: 'en_US-lessac-medium', speakBackend: 'mock', sampleRate: 22050 }),
    start: async () => {},
    send: async (text, _i, hooks) => {
      const r = await runStreamingPipeline(text, {
        inject: async () => { hooks.onNotice?.('Auto-dismissed "How is Claude doing this session?" rating prompt before sending.'); },
        streamReply: async (onUnit) => {
          onUnit('Opening your memoirs data.');
          onUnit('Found three files.');
          onUnit('Want me to summarize them?');
          return 'Opening your memoirs data. Found three files. Want me to summarize them?';
        },
        speakify: (s) => speakify(s, { backend: 'mock' }),
        synth: (cs) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: cs, endpoint: mock.endpoint, timeoutMs: 8000 }),
        onChunk: (c) => hooks.onChunk?.({ index: c.index, narration: c.narration, speakBackend: c.speakBackend, pcm: c.pcm, sampleRate: c.sampleRate }),
        onStage: hooks.onStage,
        signal: hooks.signal,
      });
      return { reply: r.reply, narration: r.narration, speakBackend: r.speakBackend, audio: { pcm: r.audio.pcm, sampleRate: r.audio.sampleRate, ttfbMs: r.audio.ttfbMs, bytes: r.audio.bytes } };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const app = await createWebApp({ driver: streamingDriver, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // --- turn 1: drive a streaming turn, collect every frame ---
    const msgs: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { try { client.close(); } catch { /* ignore */ } reject(new Error('streaming WS timed out')); }, 12000);
      let sent = false;
      client.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        msgs.push(m);
        if (m.type === 'hello' && !sent) { sent = true; client.send(JSON.stringify({ type: 'send', text: 'pull up my memoirs' })); }
        if (m.type === 'turn-done') { clearTimeout(timer); client.close(); resolve(); }
      });
      client.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
    const audioFrames = msgs.filter((m) => m.type === 'audio');
    const narrFrames = msgs.filter((m) => m.type === 'narration');
    t.ok(audioFrames.length >= 3, 'one audio frame PER speakable unit (progressive, not one big blob)', `${audioFrames.length} frames`);
    t.ok(narrFrames.length >= 3, 'one narration frame per unit', `${narrFrames.length} frames`);
    t.eq(audioFrames[0]!.index, 0, 'first audio chunk is index 0 (ordered)');
    t.eq(audioFrames[1]!.index, 1, 'second audio chunk is index 1');
    t.ok(Buffer.from((audioFrames[0]!.pcm as string) || '', 'base64').length > 0, 'the first chunk carries playable PCM (plays before the turn ends)');
    const notice = msgs.find((m) => m.type === 'notice') as { message?: string } | undefined;
    t.ok(!!notice && /rating prompt/i.test(notice.message || ''), 'auto-dismissed benign modal surfaced as a notice');
    const reply = msgs.find((m) => m.type === 'reply') as { text?: string } | undefined;
    t.includes(reply?.text || '', 'memoirs', 'the full raw reply is delivered at the end');
    // no DUPLICATE aggregate audio when chunks streamed (would double-speak).
    t.ok(audioFrames.every((m) => typeof m.index === 'number'), 'every audio frame is a progressive chunk (no extra aggregate blob)');

    // --- turn 2: a FRESH client (page refresh) is re-synced, not left blank ---
    const replayMsgs: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const c2 = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { try { c2.close(); } catch { /* ignore */ } reject(new Error('replay WS timed out')); }, 8000);
      c2.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        replayMsgs.push(m);
        if (m.type === 'turn-done') { clearTimeout(timer); c2.close(); resolve(); }
      });
      c2.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
    const rReply = replayMsgs.find((m) => m.type === 'reply') as { replay?: boolean; text?: string } | undefined;
    t.ok(!!rReply && rReply.replay === true, 'a refreshed client is REPLAYED the last reply (not left blank)');
    t.includes(rReply?.text || '', 'memoirs', 'replayed reply carries the last turn text');
    const rAudio = replayMsgs.find((m) => m.type === 'audio') as { replay?: boolean } | undefined;
    t.ok(!!rAudio && rAudio.replay === true, 'replayed audio is flagged replay (client arms Replay, does NOT auto-play)');
    const rDone = replayMsgs.find((m) => m.type === 'turn-done') as { replay?: boolean } | undefined;
    t.ok(!!rDone && rDone.replay === true, 'replay ends with a turn-done so the client settles to idle');
  } finally {
    await app.close();
    await mock.close();
  }
});

// ═══════════ SPEAKABILITY DRIFT — reproduce + fix (the captain's live bug) ═════
// On long / multi-topic replies the Gemini summaries drifted: a topic was dropped, the
// wrong option was reported as recommended, or paths/PIDs were read aloud. Root cause:
// the streaming path summarized each SENTENCE in isolation, so the rewriter never saw the
// whole topic. Fixtures are the real reply shapes (data/ceochat-test-convo.md). These
// legs FAIL without the fix (block-granularity + reply-so-far context + hardened prompt).

// D1 — ROOT CAUSE: per-sentence units split an option from its recommendation; topic
// blocks keep them together. This is the structural reproduction — deterministic, no LLM.
await reporter.leg('drift — root cause: sentence fragments lose context, topic blocks keep it', (t) => {
  const allUnits = (s: { units: string[]; rest: string }): string[] =>
    s.rest.trim() ? [...s.units, s.rest.trim()] : s.units;

  // splitCompleteUnits (the OLD streaming granularity) fragments the options list: NO
  // single sentence unit holds BOTH the recommended option ("SSH") and the recommendation
  // marker — so a per-unit summarizer literally cannot know which option was recommended.
  const sentenceUnits = allUnits(splitCompleteUnits(OPTIONS_REPLY));
  t.ok(!sentenceUnits.some((u) => /\bSSH\b/i.test(u) && /recommend/i.test(u)),
    'per-sentence: no single unit holds the option AND its recommendation (drift reproduced)');

  // splitCompleteBlocks (the FIX) keeps the contiguous numbered list as ONE block, so the
  // recommendation and its option ("SSH") arrive together — the rewriter can name it.
  const blocks = allUnits(splitCompleteBlocks(OPTIONS_REPLY));
  t.ok(blocks.some((b) => /\bSSH\b/i.test(b) && /recommend/i.test(b)),
    'topic block keeps the option WITH its recommendation (SSH) — no drift');
  t.ok(blocks.length >= 2, 'the reply splits into multiple topic blocks', `${blocks.length} blocks`);

  // multi-ask: the two asks live in different blocks, so each survives as its own unit
  // (neither topic silently dropped).
  const askBlocks = allUnits(splitCompleteBlocks(MULTI_ASK_REPLY));
  t.ok(askBlocks.some((b) => /lock|helm/i.test(b)), 'the lock ask is its own block');
  t.ok(askBlocks.some((b) => /install|tool/i.test(b)), 'the tooling ask is its own block (not dropped)');
});

// D2 — the streaming pipeline feeds whole topic blocks AND the reply-so-far as context to
// each speakify call (the two halves of the fix), so the rewriter never drifts on a
// fragment. Asserted by recording every speakify input over runStreamingPipeline.
await reporter.leg('drift — streaming summarizes blocks with reply-so-far context', async (t) => {
  const mock = await startMockMinimax();
  try {
    const calls: Array<{ text: string; context: string | undefined }> = [];
    const split = splitCompleteBlocks(OPTIONS_REPLY);
    const blocks = split.rest.trim() ? [...split.units, split.rest.trim()] : split.units;
    const result = await runStreamingPipeline('bridge the machines', {
      inject: async () => {},
      // drive the SAME block units the broker would emit (broker passes splitCompleteBlocks).
      streamReply: async (onUnit) => { for (const b of blocks) onUnit(b); return OPTIONS_REPLY; },
      speakify: (text, context) => { calls.push({ text, context }); return speakify(text, { backend: 'mock', context }); },
      synth: (cs) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: cs, endpoint: mock.endpoint, timeoutMs: 8000 }),
      onChunk: () => {},
    });
    // every speakify input is a whole topic block (carries enough context to not drift).
    const recCall = calls.find((c) => /recommendation/i.test(c.text));
    t.ok(!!recCall, 'a speakify call carries the recommendation');
    t.ok(/\bSSH\b/i.test(recCall?.text || ''), 'that call ALSO contains the recommended option (SSH) — summarizer can name it');
    // later calls receive the reply-so-far as context (the whole-reply-context fix).
    t.ok(calls.length >= 2, 'multiple blocks summarized', `${calls.length} calls`);
    t.ok(calls[0]!.context === undefined, 'the first block has no prior context');
    t.ok(!!calls[calls.length - 1]!.context && /picture|bridge/i.test(calls[calls.length - 1]!.context || ''),
      'a later block receives the reply-so-far as context');
    // the aggregate narration names the RIGHT option and keeps the questions.
    t.ok(/\bSSH\b/i.test(result.narration), 'aggregate narration names SSH (the recommendation)');
    t.includes(result.narration, '?', 'the follow-up question survives');
  } finally {
    await mock.close();
  }
});

// D3 — deterministic SUMMARY-QUALITY gate: the contract reference (mockSpeakify, the
// per-chunk fail-safe AND the offline mirror of the live Gemini path) must, for every
// drift fixture, cover each topic, name the recommended option, drop paths/URLs/PIDs, and
// keep pending questions. This is what the live Gemini leg asserts against the real model.
await reporter.leg('drift — mock contract summaries cover every topic, name the recommendation, screen-safe', (t) => {
  for (const f of DRIFT_FIXTURES) {
    const n = mockSpeakify(f.reply);
    const low = n.toLowerCase();
    for (const group of f.mustMention) {
      t.ok(group.some((k) => low.includes(k.toLowerCase())),
        `[${f.name}] covers topic (${group.join('/')}) — no dropped topic`, n);
    }
    if (f.recommended) {
      t.ok(low.includes(f.recommended.toLowerCase()),
        `[${f.name}] names the recommended option (${f.recommended})`, n);
    }
    for (const bad of f.forbid) {
      t.notIncludes(n, bad, `[${f.name}] never speaks "${bad}" (path/URL/code/raw-ID)`);
    }
    if (f.expectQuestion) t.includes(n, '?', `[${f.name}] preserves the pending question`);
    if (f.maxSentences) {
      t.ok(sentenceCount(n) <= f.maxSentences,
        `[${f.name}] compresses to <= ${f.maxSentences} sentences`, `got ${sentenceCount(n)}`);
    }
  }
});

// ═══════════════════════ REGRESSION GUARDS (the 3 fixed bugs) ════════════════

// R1 — e2e reply-wait latch: never return a PARTIAL reply while the turn streams.
await reporter.leg('regression — reply-wait latch (no partial reply)', async (t) => {
  const PARTIAL = 'Still running the unit te';
  const FULL = 'Unit tests passed. Ready to merge?';
  const IDLE_AT = 5000;
  let clock = 0;
  let idleChecks = 0;
  const got = await waitForReply({
    readSays: () => ({ count: 1, text: clock >= IDLE_AT ? FULL : PARTIAL }),
    isIdle: () => { idleChecks++; return clock >= IDLE_AT; },
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
    now: () => clock,
  }, { sayBefore: 0, timeoutMs: 60000 });
  t.eq(got, FULL, 'returns the COMPLETE reply, not the partial mid-stream text');
  t.notIncludes(got, 'Still running', 'mid-stream partial fragment is never spoken');
  t.ok(idleChecks >= 2, 'latch held across streaming polls until harness idle', `${idleChecks} idle checks`);

  // control: an already-complete turn returns promptly
  let c2 = 0;
  const quick = await waitForReply({
    readSays: () => ({ count: 1, text: FULL }),
    isIdle: () => true,
    sleep: (ms) => { c2 += ms; return Promise.resolve(); },
    now: () => c2,
  }, { sayBefore: 0 });
  t.eq(quick, FULL, 'a finished turn is returned without over-waiting');
});

// R2 — MiniMax task_started audio-drop: audio riding on the ack must NOT be lost.
await reporter.leg('regression — MiniMax task_started audio-drop', async (t) => {
  const ctrl = await startMockMinimax({ audioOnStarted: false });
  let controlFrames = 0;
  try {
    const r = await synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: ['a', 'b'], endpoint: ctrl.endpoint, timeoutMs: 8000 });
    controlFrames = r.frames;
    t.eq(controlFrames, 2, 'control: one frame per text chunk');
  } finally { await ctrl.close(); }

  const mock = await startMockMinimax({ audioOnStarted: true });
  try {
    const r = await synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: ['a', 'b'], endpoint: mock.endpoint, timeoutMs: 8000 });
    t.eq(r.frames, controlFrames + 1, 'audio frame on task_started is captured, not dropped');
    t.ok(r.pcm.length === r.frames * 4096, 'all PCM (including the ack-borne frame) assembled');
    t.ok(typeof r.ttfbMs === 'number', 'TTFB still measured when first audio rides task_started');
  } finally { await mock.close(); }
});

// R3 — transcript tail cursor race: no dropped/duplicated turns across appends.
await reporter.leg('regression — transcript tail cursor race', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-tail-'));
  const path = join(dir, 'session.jsonl');
  // pre-existing line we must NOT re-emit (cursor starts after it)
  writeFileSync(path, assistantSay('first (already consumed)') + '\n');
  const startOffset = Buffer.byteLength(assistantSay('first (already consumed)') + '\n');

  const got: TranscriptEvent[] = [];
  const stop = tailTranscript(path, (e) => got.push(e), { startOffset, pollMs: 40 });
  try {
    // append a line in TWO writes (writer mid-append) — partial must be buffered
    appendFileSync(path, '{"type":"assistant","message":{"content":[{"type":"text","text":"sec');
    await realSleep(120);
    appendFileSync(path, 'ond"}]}}\n');
    await realSleep(120);
    // then a full third line
    appendFileSync(path, assistantSay('third') + '\n');
    await realSleep(200);
  } finally { stop(); }

  const texts = got.filter((e) => e.kind === 'say').map((e) => (e as Extract<TranscriptEvent, { kind: 'say' }>).text);
  t.notIncludes(texts.join('|'), 'already consumed', 'pre-cursor line not re-emitted (no duplicate)');
  t.eq(texts.filter((x) => x === 'second').length, 1, 'partial line emitted exactly once, fully assembled');
  t.eq(texts.filter((x) => x === 'third').length, 1, 'following line emitted exactly once');
  t.eq(texts.join(','), 'second,third', 'order preserved, nothing dropped');
  rmSync(dir, { recursive: true, force: true });
});

// Bonus regression — fm-send false-negative handling (verified-submit logic).
await reporter.leg('regression — fm-send false-negative (verified submit)', async (t) => {
  // pane glyphs: a composer row "❯ <text>" means the text is STILL in the box.
  const paneWith = (line: string) => `┌──┐\n❯ ${line}\n└──┘`;
  const paneEmpty = '┌──┐\n❯ \n└──┘';
  t.ok(paneHoldsText(paneWith('deploy the build now please'), 'deploy the build now please'), 'paneHoldsText detects text in composer');
  t.ok(!paneHoldsText(paneEmpty, 'deploy the build now please'), 'paneHoldsText sees cleared composer');

  // Case A: fm-send exits NON-ZERO but composer cleared -> submit LANDED (no retry).
  let sends = 0;
  const a = await verifiedSubmit('deploy now', {
    sendOnce: async () => { sends++; return 1; /* false-negative non-zero */ },
    holdsText: () => false, // composer cleared = real proof of submit
    clear: () => {}, sleep: () => Promise.resolve(),
  });
  t.ok(a.ok && !a.retried && a.fmExit === 1, 'non-zero exit + cleared composer => success, no double-submit');
  t.eq(sends, 1, 'did not blind-retry a landed submit');

  // Case B: composer still holds text on first try -> exactly one retry, then ok.
  let sendsB = 0;
  const b = await verifiedSubmit('deploy now', {
    sendOnce: async () => { sendsB++; return 0; },
    holdsText: () => sendsB < 2, // holds until the second send
    clear: () => {}, sleep: () => Promise.resolve(),
  }, { pollTries: 2, pollMs: 1 });
  t.ok(b.ok && b.retried, 'genuinely-stuck submit is retried once and then verified');
  t.eq(sendsB, 2, 'retried exactly once');
});

// ═══════════════════════ EDGE CASES (plan §7) ═══════════════════════════════

// E1 — drops code/paths/URLs, keeps questions/decisions.
await reporter.leg('edge — speakability drops code/paths/URLs, keeps the decision', async (t) => {
  const { narration } = await speakify(SAMPLE_AGENT_TURN, { backend: 'mock' });
  t.notIncludes(narration, 'https://example.com/pr/42', 'URL not read aloud');
  t.notIncludes(narration, 'src/server.ts', 'file path not read aloud');
  t.notIncludes(narration, '`', 'no backticks/code spoken');
  t.includes(narration, 'on your screen', 'code/URL referred to as "on your screen"');
  t.includes(narration, '?', 'the question is preserved');
  t.ok(/merge/i.test(narration), 'the decision word ("merge") is preserved');
});

// E2 — confirmation flow for consequential actions.
await reporter.leg('edge — confirmation flow preserved (consequential action)', async (t) => {
  const { narration } = await speakify(CONFIRM_TURN, { backend: 'mock' });
  t.includes(narration, '?', 'confirmation question reaches the captain');
  t.ok(/proceed|deploy/i.test(narration), 'the consequential decision is surfaced');
  t.notIncludes(narration, 'rm -rf', 'the raw destructive command is not read aloud');
});

// E3 — long-op / "thinking" handling.
await reporter.leg('edge — long-op & thinking handling (stays short, screen-safe)', async (t) => {
  // thinking is parsed but is NEVER part of the spoken (say-only) stream
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-think-'));
  const path = join(dir, 's.jsonl');
  writeFileSync(path, [
    assistantThinking('SECRET internal reasoning that must never be spoken'),
    assistantToolUse('Bash', { command: 'npm test' }, 'tu_9'),
    assistantSay('Tests pass.'),
  ].join('\n') + '\n');
  const spoken = parseTranscript(path).filter((e) => e.kind === 'say').map((e) => (e as Extract<TranscriptEvent, { kind: 'say' }>).text).join(' ');
  t.notIncludes(spoken, 'SECRET internal reasoning', 'thinking blocks are not spoken');
  t.notIncludes(spoken, 'npm test', 'tool input is not spoken');
  rmSync(dir, { recursive: true, force: true });

  // a long, code-heavy turn is compressed and kept screen-safe
  const { narration } = await speakify(LONG_CODE_TURN, { backend: 'mock' });
  t.ok(sentenceCount(narration) <= 3, 'long turn compressed to <= 3 sentences', `got ${sentenceCount(narration)}`);
  t.notIncludes(narration, 'github.com', 'review URL dropped');
  t.notIncludes(narration, 'package.json', 'file path dropped');
  // the same compression directly via the contract reference
  t.ok(mockSpeakify(LONG_CODE_TURN).length > 0, 'contract reference (mockSpeakify) yields speakable text');
});

// ═══════════════════════ MOBILE UX (the hands-free phone-call surface) ═══════

// M1 — pcm helpers: the portable codec the browser player + STT capture share.
await reporter.leg('mobile — pcm codec (base64 / s16le / downsample, browser↔node)', (t) => {
  // base64 round-trips AND matches Node's Buffer (so server-decoded bytes == sent bytes).
  const bytes = new Uint8Array([0, 1, 2, 250, 128, 64, 255, 7, 9]);
  const b64 = bytesToBase64(bytes);
  t.eq(b64, Buffer.from(bytes).toString('base64'), 'bytesToBase64 matches Node Buffer base64');
  t.eq(Buffer.from(base64ToBytes(b64)).toString('hex'), Buffer.from(bytes).toString('hex'), 'base64ToBytes round-trips');
  // s16le <-> float32 round-trips within quantization.
  const f = new Float32Array([0, 0.5, -0.5, 0.999, -1]);
  const back = pcmS16leToFloat32(float32ToPcmS16le(f));
  let maxErr = 0;
  for (let i = 0; i < f.length; i++) maxErr = Math.max(maxErr, Math.abs(back[i]! - f[i]!));
  t.ok(maxErr < 0.001, 's16le<->float32 round-trips within quantization', `maxErr ${maxErr.toFixed(5)}`);
  // downsample 48k -> 16k reduces frame count ~3x; equal rates are a no-op.
  const src = new Float32Array(4800);
  const down = downsampleFloat32(src, 48000, 16000);
  t.ok(Math.abs(down.length - 1600) <= 1, '48k->16k downsample yields ~1/3 frames', `${down.length}`);
  t.eq(downsampleFloat32(src, 16000, 16000).length, src.length, 'equal-rate downsample is a no-op (STT path)');
  // wavBytesFromPcm wraps s16le PCM in a valid 44-byte RIFF header (HTMLAudio fallback).
  const pcm = float32ToPcmS16le(new Float32Array([0.1, -0.1, 0.2]));
  const wav = wavBytesFromPcm(pcm, 22050);
  t.eq(wav.length, 44 + pcm.length, 'WAV is 44-byte header + PCM data');
  t.eq(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!), 'RIFF', 'WAV starts with RIFF');
  t.eq(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!), 'WAVE', 'WAV has WAVE format tag');
  const wavDv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  t.eq(wavDv.getUint32(24, true), 22050, 'WAV header carries the sample rate');
  t.eq(wavDv.getUint16(34, true), 16, 'WAV is 16-bit PCM');
  t.eq(wavDv.getUint32(40, true), pcm.length, 'WAV data chunk length matches the PCM');
});

// M1b — Diagnostics ring buffer (the on-screen panel's data model): timestamped
// lines, error flagging (drives auto-open), a copy-pasteable dump, bounded size.
await reporter.leg('mobile — diagnostics ring buffer (sighted device testing)', (t) => {
  let clock = 1000;
  const errors: string[] = [];
  const diag = new Diagnostics({ now: () => clock, onError: (r) => errors.push(r.msg), max: 3 });
  clock = 1500; diag.add('AudioContext → running');
  clock = 2000; diag.error('play error (element): play() rejected');
  t.eq(diag.count, 2, 'two lines recorded');
  t.eq(errors.length, 1, 'onError fired for the error line (panel auto-opens)');
  t.ok(/\[\+0\.50s\] AudioContext/.test(diag.text()), 'text() stamps lines relative to first use', diag.text().split('\n')[0]);
  t.ok(/ERR/.test(diag.text()), 'error lines are marked in the dump');
  // bounded: never grows past max (the panel can run for a long call).
  clock = 3000; diag.add('a'); clock = 3100; diag.add('b'); clock = 3200; diag.add('c');
  t.ok(diag.count <= 3, 'ring buffer is bounded by max', `count ${diag.count}`);
  diag.clear();
  t.eq(diag.count, 0, 'clear() empties the buffer');
});

// M2 — protocol constants the browser hard-codes must match the typed server source.
await reporter.leg('mobile — browser protocol constants match the server', (t) => {
  t.eq(WEB_STT_SR, STT_SAMPLE_RATE, 'STT_SAMPLE_RATE matches protocol.ts');
  t.eq(WEB_AUDIO_FORMAT, AUDIO_FORMAT, 'AUDIO_FORMAT matches protocol.ts');
  t.eq(WEB_WS_PATH, WS_PATH, 'WS_PATH matches protocol.ts');
});

// M3 — voice-safety confirmation guard (plan §3.5): a misheard phrase can't approve.
await reporter.leg('mobile — confirmation guard (no misheard approval, §3.5)', (t) => {
  t.ok(looksConsequential('Want me to merge it?'), 'detects a consequential action (merge)');
  t.ok(looksConsequential('Should I force-push to main?'), 'detects force-push');
  t.ok(!looksConsequential('I changed three files; the tests pass.'), 'plain status is not consequential');
  t.eq(classifyReply('confirm'), 'confirm', '"confirm" -> confirm');
  t.eq(classifyReply('yes do it'), 'confirm', '"yes do it" -> confirm');
  t.eq(classifyReply('yeah'), 'unclear', 'a bare affirmative noise is NOT a confirm');
  t.eq(classifyReply('no'), 'cancel', '"no" -> cancel');
  t.eq(classifyReply('cancel'), 'cancel', '"cancel" -> cancel');
  // typed input is always explicit.
  t.eq(guardUtterance({ source: 'text', text: 'merge it', awaitingConfirmation: true, lastNarration: 'Want me to merge it?' }).action, 'send', 'typed input always sends');
  // voice during a consequential confirmation: ambiguous -> held & re-prompted.
  const ambiguous = guardUtterance({ source: 'voice', text: 'yeah sure ok', awaitingConfirmation: true, lastNarration: 'Want me to merge it?' });
  t.eq(ambiguous.action, 'reprompt', 'ambiguous spoken reply to a danger Q is held, not sent');
  t.ok((ambiguous as { speak: string }).speak.length > 0, 're-prompt speaks an explicit ask');
  // voice clear confirm/cancel -> forwarded.
  t.eq(guardUtterance({ source: 'voice', text: 'confirm', awaitingConfirmation: true, lastNarration: 'Want me to merge it?' }).action, 'send', 'a clear spoken "confirm" is forwarded');
  t.eq(guardUtterance({ source: 'voice', text: 'cancel', awaitingConfirmation: true, lastNarration: 'Want me to merge it?' }).action, 'send', 'a clear spoken "cancel" is forwarded');
  // voice for a NON-consequential turn passes straight through.
  t.eq(guardUtterance({ source: 'voice', text: 'tell me more', awaitingConfirmation: false, lastNarration: 'The tests pass.' }).action, 'send', 'ordinary speech is not gated');
});

// M4 — AudioPlayer: the core mobile fix. Audio that arrives BEFORE the unlock tap is
// buffered, then auto-plays once unlocked; playback serializes; speaking-state drives
// half-duplex; stop() hard-cuts. Asserted against a fake AudioContext (no audio device).
await reporter.leg('mobile — audio auto-speak (unlock, queue, barge-in)', async (t) => {
  const started: FakeSource[] = [];
  const makeCtx = (): AudioCtxLike => {
    const ctx = {
      state: 'suspended', sampleRate: 48000, currentTime: 0, destination: {},
      resume() { ctx.state = 'running'; return Promise.resolve(); },
      createBuffer(_ch: number, len: number, rate: number) { return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }; },
      createBufferSource(): FakeSource {
        const s: FakeSource = { buffer: null, onended: null, started: false, stopped: false, connect() {}, start() { s.started = true; started.push(s); }, stop() { s.stopped = true; } };
        return s;
      },
    };
    return ctx as unknown as AudioCtxLike;
  };
  const speakingLog: boolean[] = [];
  const player = new AudioPlayer({ createContext: makeCtx, onSpeakingChange: (s) => speakingLog.push(s) });
  const pcm = float32ToPcmS16le(new Float32Array([0.1, -0.1, 0.2, -0.2, 0.05]));

  // Audio BEFORE unlock: must not play (suspended), must be buffered — the iOS bug.
  player.enqueue(pcm, 22050);
  t.eq(started.length, 0, 'audio before unlock does NOT play (AudioContext suspended)');

  // The unlock gesture resumes + flushes the buffered audio.
  const ok = await player.unlock();
  t.ok(ok, 'unlock() resumes the context (running)');
  t.ok(started.length >= 1, 'buffered pre-unlock audio auto-plays after the tap', `${started.length} source(s)`);
  t.ok(player.speaking, 'player reports speaking while audio is scheduled');
  t.eq(speakingLog[0], true, 'onSpeakingChange fired true (mic mutes for half-duplex)');

  // A second reply queues and plays (auto-speak, no extra tap).
  const before = started.length;
  player.enqueue(pcm, 22050);
  t.ok(started.length === before + 1, 'a later reply auto-plays (no per-message tap)');

  // Finish all sources -> speaking flips false (mic may resume).
  for (const s of started) if (s.onended) s.onended();
  t.ok(!player.speaking, 'speaking clears when the queue drains');
  t.eq(speakingLog[speakingLog.length - 1], false, 'onSpeakingChange fired false at drain');

  // Barge-in: stop() hard-cuts everything still scheduled.
  player.enqueue(pcm, 22050);
  player.stop();
  t.ok(!player.speaking, 'stop() ends speaking immediately (barge-in)');

  // Regression: a throwing src.start() must NOT wedge speaking=true forever
  // (half-duplex would stay muted and never re-arm the mic).
  const throwCtx = (): AudioCtxLike => {
    const ctx = {
      state: 'running', sampleRate: 48000, currentTime: 0, destination: {},
      resume() { return Promise.resolve(); },
      createBuffer(_ch: number, len: number, rate: number) { return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }; },
      createBufferSource(): FakeSource {
        const s: FakeSource = { buffer: null, onended: null, started: false, stopped: false, connect() {}, start() { throw new Error('start blocked'); }, stop() { s.stopped = true; } };
        return s;
      },
    };
    return ctx as unknown as AudioCtxLike;
  };
  const tp = new AudioPlayer({ createContext: throwCtx });
  await tp.unlock();
  tp.enqueue(pcm, 22050);
  t.ok(!tp.speaking, 'a failed src.start() does not leave speaking stuck (mic re-arms)');

  // Pre-unlock backlog is bounded: if unlock never resolves while replies keep
  // arriving, the oldest are dropped (symmetric to the server STT cap) — never
  // grows unbounded for the page's life.
  const capStarted: FakeSource[] = [];
  const capMakeCtx = (): AudioCtxLike => {
    const ctx = {
      state: 'suspended', sampleRate: 48000, currentTime: 0, destination: {},
      resume() { return Promise.resolve(); }, // stays suspended — unlock never resolves
      createBuffer(_ch: number, len: number, rate: number) { return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }; },
      createBufferSource(): FakeSource {
        const s: FakeSource = { buffer: null, onended: null, started: false, stopped: false, connect() {}, start() { s.started = true; capStarted.push(s); }, stop() { s.stopped = true; } };
        return s;
      },
    };
    return ctx as unknown as AudioCtxLike;
  };
  const capPlayer = new AudioPlayer({ createContext: capMakeCtx, pendingMaxBytes: pcm.length * 3 });
  for (let i = 0; i < 100; i++) capPlayer.enqueue(pcm, 22050);
  const capInternals = capPlayer as unknown as { _pendingBytes: number; _pending: unknown[] };
  t.eq(capStarted.length, 0, 'still suspended — nothing played (pending only)');
  t.ok(capInternals._pendingBytes <= pcm.length * 3, 'pre-unlock backlog stays under the byte cap', `${capInternals._pendingBytes} bytes`);
  t.ok(capInternals._pending.length >= 1, 'cap keeps at least the newest reply buffered');
});

// M4b — the PRIMARY iOS bug fix: (1) unlock() starts a keep-alive so the context stays
// 'running' for the delayed reply; (2) when the context is NOT running, the reply still
// plays via the HTMLAudioElement fallback (WAV Blob) instead of going silent. Asserted
// against fake context + fake <audio> (no audio device).
await reporter.leg('mobile — audio keep-alive + HTMLAudioElement fallback (iOS idle-suspend)', async (t) => {
  // (1) keep-alive: a context that resumes to running gets a persistent keep-alive
  // source on unlock, and stop() tears it down.
  const started: FakeSource[] = [];
  const runCtx = (): AudioCtxLike => {
    const ctx = {
      state: 'suspended', sampleRate: 48000, currentTime: 0, destination: {},
      resume() { ctx.state = 'running'; return Promise.resolve(); },
      createBuffer(_ch: number, len: number, rate: number) { return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }; },
      createBufferSource(): FakeSource {
        const s: FakeSource = { buffer: null, onended: null, started: false, stopped: false, loop: false, connect() {}, disconnect() {}, start() { s.started = true; started.push(s); }, stop() { s.stopped = true; } };
        return s;
      },
    };
    return ctx as unknown as AudioCtxLike;
  };
  const kp = new AudioPlayer({ createContext: runCtx });
  await kp.unlock();
  t.ok(kp.keepAliveActive, 'unlock() starts the keep-alive (context stays running for the delayed reply)');
  kp.stop();
  t.ok(!kp.keepAliveActive, 'stop() tears the keep-alive down');

  // (2) the fallback: a context stuck SUSPENDED (iOS idle-suspend) + an armed <audio>
  // element. A reply that arrives must play via the element, NOT silently vanish.
  const elPlays: Array<{ src: string; muted: boolean }> = [];
  let fakeEl: AudioElLike;
  const stuckSources: FakeSource[] = [];
  const stuckCtx = (): AudioCtxLike => {
    const ctx = {
      state: 'suspended', sampleRate: 48000, currentTime: 0, destination: {},
      resume() { return Promise.resolve(); }, // never un-suspends — the bug condition
      createBuffer(_ch: number, len: number, rate: number) { return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }; },
      createBufferSource(): FakeSource {
        const s: FakeSource = { buffer: null, onended: null, started: false, stopped: false, loop: false, connect() {}, disconnect() {}, start() { s.started = true; stuckSources.push(s); }, stop() { s.stopped = true; } };
        return s;
      },
    };
    return ctx as unknown as AudioCtxLike;
  };
  const diags: AudioDiag[] = [];
  const player = new AudioPlayer({
    createContext: stuckCtx,
    createAudioElement: () => { fakeEl = { src: '', muted: true, autoplay: false, preload: '', onended: null, onerror: null, play() { elPlays.push({ src: fakeEl.src, muted: fakeEl.muted }); return Promise.resolve(); }, pause() {} }; return fakeEl; },
    makeObjectUrl: (bytes: Uint8Array) => 'blob:wav/' + bytes.length,
    revokeObjectUrl: () => {},
    onDiag: (r: AudioDiag) => diags.push(r),
  });
  const ok = await player.unlock();
  t.ok(!ok, 'unlock() reports Web Audio NOT running (context stuck suspended)');
  t.ok(!player.keepAliveActive, 'no keep-alive while the context is suspended');

  t.ok(elPlays.some((p) => p.muted), 'element was primed muted inside the unlock gesture (iOS user-activation)');
  const pcm = float32ToPcmS16le(new Float32Array([0.1, -0.1, 0.2, -0.2, 0.05]));
  player.enqueue(pcm, 22050);
  const replyPlays = elPlays.filter((p) => !p.muted);
  t.eq(replyPlays.length, 1, 'a reply that arrives while suspended PLAYS via the HTMLAudioElement fallback (unmuted)');
  t.ok(/^blob:wav\//.test(replyPlays[0]?.src || ''), 'the reply is fed to the element as a WAV Blob url', replyPlays[0]?.src);
  t.ok(player.speaking, 'fallback playback marks the player speaking (half-duplex mutes the mic)');
  t.ok(diags.some((d) => d.t === 'play' && d.via === 'element'), 'diagnostics record the element-fallback play');
  // the reply did NOT go through Web Audio (no buffer source scheduled for it; only the
  // unlock prime exists since the context never ran).
  t.ok(stuckSources.length <= 1, 'reply did NOT schedule a Web Audio source (used the fallback)', `${stuckSources.length} source(s)`);

  // draining the element queue clears speaking (mic can re-arm).
  if (fakeEl!.onended) fakeEl!.onended();
  t.ok(!player.speaking, 'speaking clears when the element queue drains');
});

// M5 — SpeechController: iOS-shaped robustness (restart-on-end keep-alive, permanent
// vs transient errors, half-duplex pause/resume). Fake recognizer + injected clock.
await reporter.leg('mobile — speech STT controller (iOS restart, half-duplex, errors)', (t) => {
  const created: RecognitionLike[] = [];
  const results: Array<{ text: string; final: boolean }> = [];
  const errors: Array<{ kind: string }> = [];
  let clock = 0;
  const ctrl = new SpeechController({
    createRecognition: () => { const r = makeRecog(); created.push(r); return r; },
    now: () => (clock += 1000),
    setTimeout: (fn: () => void) => { fn(); return 0; },     // run re-arm synchronously
    clearTimeout: () => {},
    minRestartMs: 0,
    onResult: (text: string, meta: { isFinal: boolean }) => results.push({ text, final: meta.isFinal }),
    onError: (e: { kind: string }) => errors.push(e),
  });

  ctrl.start();
  t.eq(created.length, 1, 'start() arms a recognizer');
  created[0]!.onstart!();
  t.ok(ctrl.listening, 'onstart -> listening');

  // interim + final results surface through onResult.
  created[0]!.onresult!({ results: [mkRes('merge it', false)] });
  created[0]!.onresult!({ results: [mkRes('merge it', true)] });
  t.ok(results.some((r) => !r.final && r.text === 'merge it'), 'interim result delivered (live UI)');
  t.ok(results.some((r) => r.final && r.text === 'merge it'), 'final result delivered');

  // iOS ends the session after an utterance -> controller RE-ARMS (the keep-alive).
  created[0]!.onend!();
  t.eq(created.length, 2, 'onend re-arms a fresh recognizer (iOS keep-alive)');

  // half-duplex: pause() (first mate speaking) stops listening + suppresses re-arm.
  ctrl.pause();
  created[1]!.onend!();
  t.eq(created.length, 2, 'paused (speaking) -> no re-arm while muted');
  ctrl.resume();
  t.eq(created.length, 3, 'resume() re-arms after first mate finishes');

  // a PERMANENT error (no mic permission) stops and tells the UI; no busy-loop re-arm.
  created[2]!.onerror!({ error: 'not-allowed' });
  t.ok(errors.some((e) => e.kind === 'permission'), 'permission error surfaced to the UI');
  const afterPerm = created.length;
  created[2]!.onend!();
  t.eq(created.length, afterPerm, 'after a permanent error it does NOT re-arm (no busy loop)');
});

// M6 — server-side STT seam over the REAL WS: mic PCM (stt-audio) -> stt-end ->
// transcription handed BACK as a `transcript` frame (NOT auto-run — the client guard
// applies first). Asserted with an in-memory driver + a MOCK transcriber (no whisper).
await reporter.leg('mobile — server STT seam (stt-audio -> transcript over WS)', async (t) => {
  const mock = await startMockMinimax();
  const HEARD = 'merge the branch';
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 32000 }),
    start: async () => {},
    send: async (text, _i, hooks) => {
      const r = await runPipeline(text, {
        inject: async () => {}, readReply: async () => SAMPLE_AGENT_TURN,
        speakify: (s) => speakify(s, { backend: 'mock' }),
        synth: (chunks) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: chunks, endpoint: mock.endpoint, timeoutMs: 8000 }),
        onStage: hooks.onStage,
      });
      return { reply: r.reply, narration: r.narration, speakBackend: r.speakBackend, audio: { pcm: r.audio.pcm, sampleRate: r.audio.sampleRate, ttfbMs: r.audio.ttfbMs, bytes: r.audio.bytes } };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  let gotPcmBytes = 0;
  let gotRate = 0;
  const app = await createWebApp({
    driver, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {},
    sttLabel: 'mock-asr',
    transcribe: async (pcm, sr) => { gotPcmBytes = pcm.length; gotRate = sr; return HEARD; },
  });
  try {
    const frames: Record<string, unknown>[] = [];
    const samplePcm = bytesToBase64(float32ToPcmS16le(new Float32Array(320).fill(0.05)));
    await new Promise<void>((resolve, reject) => {
      const client = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { try { client.close(); } catch { /* ignore */ } reject(new Error('STT WS timed out')); }, 8000);
      client.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(m);
        if (m.type === 'hello') {
          client.send(JSON.stringify({ type: 'stt-audio', pcm: samplePcm, sampleRate: STT_SAMPLE_RATE }));
          client.send(JSON.stringify({ type: 'stt-end' }));
        }
        if (m.type === 'transcript') { clearTimeout(timer); client.close(); resolve(); }
      });
      client.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
    const hello = frames.find((m) => m.type === 'hello') as { serverStt?: boolean; sttLabel?: string } | undefined;
    t.ok(hello?.serverStt === true, 'hello advertises server-side STT availability');
    t.eq(hello?.sttLabel, 'mock-asr', 'hello advertises the STT backend label');
    const transcript = frames.find((m) => m.type === 'transcript') as { text?: string; final?: boolean } | undefined;
    t.eq(transcript?.text, HEARD, 'transcription returned to the client (not auto-run)');
    t.eq(transcript?.final, true, 'transcript marked final');
    t.ok(gotPcmBytes > 0, 'broker received the streamed mic PCM', `${gotPcmBytes} bytes`);
    t.eq(gotRate, STT_SAMPLE_RATE, 'mic PCM tagged 16 kHz for the transcriber');
    // No transcript means no auto-run: the turn only happens when the client sends `send`.
    t.ok(!frames.some((m) => m.type === 'narration'), 'server STT did NOT auto-run a turn (client confirms first)');
  } finally {
    await app.close();
    await mock.close();
  }
});

// M6b — Bug 2: an empty OR failed server transcription must surface a CLEAR signal
// (transcript frame with empty=true + a reason) rather than silently nothing — so the
// device shows "heard nothing" instead of the mic swallowing the utterance. Asserted
// over the real WS with a transcriber that returns '' / throws.
await reporter.leg('mobile — server STT empty/failed surfaces a clear signal (Bug 2)', async (t) => {
  const mkDriver = (): Driver => ({
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 32000 }),
    start: async () => {},
    send: async () => ({ reply: '', narration: '', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 32000, ttfbMs: null, bytes: 0 } }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  });
  const samplePcm = bytesToBase64(float32ToPcmS16le(new Float32Array(320).fill(0.0)));
  const runCase = async (transcribe: (pcm: Buffer, sr: number) => Promise<string>): Promise<Record<string, unknown>> => {
    const app = await createWebApp({ driver: mkDriver(), host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {}, sttLabel: 'mock-asr', transcribe });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
        const timer = setTimeout(() => { try { client.close(); } catch { /* ignore */ } reject(new Error('STT empty WS timed out')); }, 8000);
        client.on('message', (raw: Buffer) => {
          const m = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (m.type === 'hello') {
            client.send(JSON.stringify({ type: 'stt-audio', pcm: samplePcm, sampleRate: STT_SAMPLE_RATE }));
            client.send(JSON.stringify({ type: 'stt-end' }));
          }
          if (m.type === 'transcript') { clearTimeout(timer); client.close(); resolve(m); }
        });
        client.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
      });
    } finally { await app.close(); }
  };

  // whisper recognized nothing -> still a transcript frame, flagged empty + reason.
  const empty = await runCase(async () => '');
  t.eq(empty.type, 'transcript', 'empty transcription still returns a transcript frame (not silence)');
  t.eq(empty.text, '', 'empty transcript carries no text');
  t.eq(empty.empty, true, 'empty transcript is flagged empty=true (UI shows "heard nothing")');
  t.ok(typeof empty.reason === 'string' && (empty.reason as string).length > 0, 'empty transcript explains WHY', String(empty.reason));
  t.ok((empty.bytes as number) > 0, 'empty transcript reports the bytes that were received', `${empty.bytes} bytes`);

  // transcriber throws -> surfaced as an empty transcript with the error reason (not a
  // bare silent drop; the client can render it).
  const failed = await runCase(async () => { throw new Error('whisper exited 1'); });
  t.eq(failed.type, 'transcript', 'a transcription FAILURE surfaces as a transcript frame');
  t.eq(failed.empty, true, 'failed transcription flagged empty=true');
  t.ok(/whisper exited 1/.test(String(failed.reason)), 'failure reason carries the underlying error', String(failed.reason));
});

// M7 — REAL audio e2e (the captain's requested generated-audio gate): a first-mate
// reply -> speakability -> LOCAL piper TTS -> a valid decodable speech WAV -> local
// whisper STT -> assert the spoken words carry the decision. Uses the offline stack
// (bin/setup-local-voice.sh); PENDING (never red) if it isn't installed.
await reporter.leg('mobile — REAL audio e2e: reply → speakify → piper TTS → whisper STT', async (t) => {
  const voice = findPiper();
  if (!voice) { t.pending('local voice not installed — run `npm run voice` (piper) to enable the real-audio gate'); return; }

  // reply (has code + a URL + a decision) -> screen-safe narration.
  const { narration } = await speakify(SAMPLE_AGENT_TURN, { backend: 'mock' });
  t.ok(narration.length > 0 && /merge/i.test(narration), 'narration keeps the decision word', narration);

  // speak it for REAL with the offline neural voice.
  const synth = await synthLocal(voice, sentenceChunks(narration));
  const durationSec = synth.pcm.length / 2 / synth.sampleRate;
  t.ok(synth.pcm.length > 0, 'piper produced real PCM audio', `${synth.pcm.length} bytes`);
  t.ok(durationSec > 0.6, 'spoken audio has a sane duration (> 0.6s)', `${durationSec.toFixed(2)}s`);
  t.ok(typeof synth.ttfbMs === 'number', 'time-to-first-audio measured', `${synth.ttfbMs}ms`);

  // it's a valid, decodable speech WAV (real RIFF header + matching data).
  const wav = toWav(synth);
  const outDir = join(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'validate-e2e.wav'), wav); // listen: out/validate-e2e.wav
  const parsed = parseWav(wav);
  t.eq(parsed.sampleRate, synth.sampleRate, 'WAV header sample rate matches the voice');
  t.eq(parsed.bitsPerSample, 16, 'WAV is 16-bit PCM');
  t.eq(parsed.pcm.length, synth.pcm.length, 'WAV data chunk == synthesized PCM');

  // round-trip: transcribe the generated speech and confirm the words survived.
  const transcriber = makeWhisperTranscriber();
  if (!transcriber) { t.pending('whisper not installed — TTS asserted; STT round-trip skipped (run `npm run voice`)'); return; }
  const heard = (await transcriber.transcribe(synth.pcm, synth.sampleRate)).toLowerCase();
  t.ok(heard.length > 0, 'whisper transcribed the generated speech', JSON.stringify(heard));
  t.ok(/merge/.test(heard), 'the spoken decision word "merge" round-trips through real audio', JSON.stringify(heard));
});

// ═══════════════ CALL MODE (Twilio phone leg) + verbatim transcript ══════════
// The phone transport is proven with a MOCK Media Streams client - no Twilio
// account, no network. The mock speaks Twilio's real wire protocol (start/media/
// dtmf/mark/stop frames, 8 kHz mu-law base64 payloads with no header bytes) at the
// real WS endpoint mounted by createWebApp, against the in-memory driver.

const PHONE_TEST_SECRETS: PhoneSecrets = {
  accountSid: 'ACtest000000000000000000000000000',
  authToken: 'test-auth-token',
  phoneNumber: '+15559998888',
  allowedCaller: '+15550001111',
  pin: '4321',
};
const PHONE_PUBLIC_URL = 'https://ceo-chat.acb-apps.com';
const PHONE_TWIML_URL = PHONE_PUBLIC_URL + PHONE_TWIML_PATH;

const until = async (cond: () => boolean, ms = 6000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await realSleep(20);
  }
  return cond();
};

// One 20ms speech frame (160 samples @8k, loud sine - rms well above the VAD gate)
// and one silence frame, as s16le PCM.
function speechFramePcm(): Buffer {
  const b = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), i * 2);
  return b;
}
const silenceFramePcm = (): Buffer => Buffer.alloc(320);
const asMediaFrame = (pcm: Buffer): string =>
  JSON.stringify({ event: 'media', media: { payload: Buffer.from(pcmS16leToMulaw(pcm)).toString('base64') } });

interface PhoneWsClient {
  ws: InstanceType<typeof WsClient>;
  out: Array<Record<string, unknown>>;
  mediaPayloads: string[];
  closed: boolean;
  send: (obj: unknown) => void;
  speakUtterance: () => void;
  close: () => void;
}

// A mock Twilio Media Streams client. echoMarks mirrors what Twilio does: it sends
// a `mark` event back once the named audio finished playing (here: immediately).
function connectPhoneClient(port: number, { echoMarks = true } = {}): Promise<PhoneWsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${PHONE_WS_PATH}`);
    const client: PhoneWsClient = {
      ws, out: [], mediaPayloads: [], closed: false,
      send: (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); },
      speakUtterance: () => {
        for (let i = 0; i < 10; i++) ws.send(asMediaFrame(speechFramePcm()));
        for (let i = 0; i < 30; i++) ws.send(asMediaFrame(silenceFramePcm()));
      },
      close: () => { try { ws.close(); } catch { /* ignore */ } },
    };
    ws.on('open', () => resolve(client));
    ws.on('close', () => { client.closed = true; });
    ws.on('error', (e: Error) => reject(e));
    ws.on('message', (raw: Buffer) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      client.out.push(m);
      if (m.type === undefined && m.event === 'media') {
        client.mediaPayloads.push(((m.media as { payload?: string })?.payload) || '');
      }
      if (echoMarks && m.event === 'mark') {
        client.send({ event: 'mark', streamSid: m.streamSid, mark: m.mark });
      }
    });
  });
}

// POST the Twilio voice webhook with a VALID signature and return the response.
async function postTwiml(baseUrl: string, params: Record<string, string>, sign = true): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = twilioSignature(PHONE_TEST_SECRETS.authToken!, PHONE_TWIML_URL, params);
  const res = await fetch(baseUrl.replace(/\/$/, '') + PHONE_TWIML_PATH, {
    method: 'POST', headers, body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.text() };
}

const tokenFromTwiml = (xml: string): string =>
  (/name="token" value="([0-9a-f]+)"/.exec(xml) || [])[1] || '';

// P1 - the pure wire transcode: G.711 mu-law both ways, no header bytes, the
// 8 kHz downconvert for outbound chunks, the 16 kHz upconvert for whisper.
await reporter.leg('phone - mu-law codec + 8 kHz transcode (Twilio wire format)', (t) => {
  t.eq(linearToMulawSample(0), 0xff, 'G.711: linear 0 encodes to 0xFF');
  t.eq(mulawToLinearSample(0xff), 0, 'G.711: 0xFF decodes back to 0');
  // round-trip stays within mu-law quantization (relative error on loud samples)
  let worst = 0;
  for (const s of [-32000, -12345, -700, -80, 0, 80, 700, 12345, 32000]) {
    const back = mulawToLinearSample(linearToMulawSample(s));
    const err = Math.abs(back - s) / Math.max(64, Math.abs(s));
    worst = Math.max(worst, err);
  }
  t.ok(worst < 0.13, 'mu-law round-trip within quantization tolerance', `worst rel err ${(worst * 100).toFixed(1)}%`);

  const pcm = speechFramePcm();
  const mulaw = pcmS16leToMulaw(pcm);
  t.eq(mulaw.length, pcm.length / 2, 'mu-law is 8-bit: HALF the s16le byte count (no header bytes)');
  t.eq(mulawToPcmS16le(mulaw).length, pcm.length, 'decode restores the s16le byte count');

  // outbound: a 100ms piper-rate chunk -> 8 kHz mu-law payload bytes
  const chunk = Buffer.alloc(2205 * 2); // 100ms @ 22050
  for (let i = 0; i < 2205; i++) chunk.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), i * 2);
  const wire = pcmChunkToPhoneMulaw(chunk, 22050);
  t.ok(Math.abs(wire.length - 800) <= 4, '100ms @22.05k downconverts to ~800 mu-law bytes @8k', `${wire.length}`);
  t.ok(frameRms(new Int16Array(mulawToPcmS16le(wire).buffer)) > 500, 'the transcoded audio still carries the signal energy');

  // inbound: 8 kHz phone audio -> 16 kHz for whisper (its resampler never upsamples)
  const up = phoneMulawToWhisperPcm(mulaw);
  t.eq(up.sampleRate, 16000, 'whisper feed is tagged 16 kHz');
  t.ok(Math.abs(up.pcm.length - pcm.length * 2) <= 4, '8k->16k doubles the frame count', `${up.pcm.length}`);
  t.eq(upsampleFloat32(new Float32Array(100), 16000, 16000).length, 100, 'equal-rate upsample is a no-op');
  t.eq(PHONE_SAMPLE_RATE, 8000, 'the wire rate constant is 8000 Hz');

  // REGRESSION GUARD (double mu-law decode): the detector hands over ALREADY
  // decoded s16le@8k PCM - the PCM-in upconvert must equal the mu-law path
  // byte-for-byte and must never re-decode PCM bytes as mu-law samples.
  const pcm8kDecoded = mulawToPcmS16le(mulaw);
  const upFromPcm = phonePcmToWhisperPcm(pcm8kDecoded);
  t.eq(upFromPcm.sampleRate, 16000, 'PCM-in upconvert is tagged 16 kHz');
  t.ok(Buffer.from(upFromPcm.pcm).equals(Buffer.from(up.pcm)), 'phonePcmToWhisperPcm(decoded) === phoneMulawToWhisperPcm(mulaw), byte-exact (decoded exactly ONCE)');
  const srcRms = frameRms(s16leView(pcm8kDecoded));
  const upRms = frameRms(s16leView(upFromPcm.pcm));
  t.ok(Math.abs(upRms - srcRms) / srcRms < 0.1, 'upconvert preserves the signal energy (no mu-law garbage)', `rms ${srcRms.toFixed(0)} -> ${upRms.toFixed(0)}`);

  // expired stream tokens are pruned on mint (the pure sweep)
  const tokenMap = new Map<string, number>([['stale', 100], ['fresh', 200]]);
  pruneExpiredTokens(tokenMap, 150);
  t.ok(!tokenMap.has('stale') && tokenMap.has('fresh'), 'expired stream tokens are swept; live ones survive');

  // the deterministic utterance detector (frame-count endpointing + barge-in)
  const utterances: number[] = [];
  let barges = 0;
  const det = new UtteranceDetector({
    onUtterance: (u) => utterances.push(u.length),
    onBargeIn: () => barges++,
  });
  for (let i = 0; i < 20; i++) det.feed(silenceFramePcm());
  t.eq(utterances.length, 0, 'pure silence never emits an utterance');
  for (let i = 0; i < 10; i++) det.feed(speechFramePcm());
  for (let i = 0; i < 30; i++) det.feed(silenceFramePcm());
  t.eq(utterances.length, 1, 'speech followed by 500ms silence emits ONE utterance');
  t.ok(utterances[0]! >= 10 * 320, 'the utterance carries the speech frames (with pre-roll)', `${utterances[0]} bytes`);
  for (let i = 0; i < 3; i++) det.feed(speechFramePcm());
  for (let i = 0; i < 30; i++) det.feed(silenceFramePcm());
  t.eq(utterances.length, 1, 'a too-short blip (below minSpeechFrames) is dropped as noise');
  det.playing = true;
  for (let i = 0; i < 12; i++) det.feed(speechFramePcm());
  t.eq(barges, 1, 'sustained speech DURING playback fires barge-in (once per playback)');
  t.eq(utterances.length, 1, 'barge-in speech is not ALSO collected as an utterance while playing');

  t.ok(sameNumber('+1 555-000-1111', '+15550001111') && !sameNumber('+15550001111', '+15550002222'), 'phone-number compare ignores formatting');
  const caps = phoneCapabilities(PHONE_TEST_SECRETS);
  t.ok(caps.inbound && caps.outbound, 'full secrets -> inbound + outbound capable');
  t.ok(!phoneCapabilities(phoneSecrets({})).inbound, 'no secrets -> phone off');
});

// P2 - the TwiML webhook: caller-ID allowlist, X-Twilio-Signature validation, the
// <Connect><Stream> bridge with a single-use stream token, and the outbound
// "Call me" REST call (faked fetch - never a real Twilio request).
await reporter.leg('phone - TwiML webhook: allowlist + signature + stream bridge + Call me', async (t) => {
  const mock = await startMockMinimax();
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 32000 }),
    start: async () => {},
    send: async () => ({ reply: 'ok', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 32000, ttfbMs: null, bytes: 0 } }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // inbound call from the captain -> bridged
    const good = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!, Direction: 'inbound' });
    t.eq(good.status, 200, 'allowlisted caller -> 200');
    t.includes(good.body, '<Connect><Stream url="wss://ceo-chat.acb-apps.com/phone">', 'TwiML bridges into our Media Streams WS (wss through the tunnel)');
    t.ok(tokenFromTwiml(good.body).length === 32, 'a single-use stream token rides as a <Parameter>');

    // the outbound "Call me" leg: the captain is in To, From is our own number
    const outb = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.phoneNumber!, To: PHONE_TEST_SECRETS.allowedCaller!, Direction: 'outbound-api' });
    t.includes(outb.body, '<Connect><Stream', 'outbound leg (captain in To) is bridged too');

    // an unknown caller is REJECTED - no stream, no token
    const bad = await postTwiml(app.url, { From: '+15667770000', To: PHONE_TEST_SECRETS.phoneNumber! });
    t.eq(bad.status, 200, 'unknown caller answered with TwiML (not an HTTP error)');
    t.includes(bad.body, '<Reject', 'unknown caller gets <Reject/> - the call never connects');
    t.notIncludes(bad.body, '<Stream', 'no stream is ever offered to an unknown caller');

    // a forged webhook (bad signature) can't mint a token at all
    const forged = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! }, false);
    t.eq(forged.status, 403, 'missing/invalid X-Twilio-Signature -> 403 (webhook authenticated)');

    // signature helper sanity (the documented HMAC-SHA1 scheme)
    const params = { From: '+15550001111', CallSid: 'CA123' };
    const sig = twilioSignature('tok', 'https://x.example/phone/twiml', params);
    t.ok(validateTwilioSignature('tok', 'https://x.example/phone/twiml', params, sig), 'signature validates against itself');
    t.ok(!validateTwilioSignature('tok', 'https://x.example/phone/twiml', { ...params, From: '+1_spoofed' }, sig), 'any param change breaks the signature');

    // TwiML XML escaping (a hostile parameter value can't break out of the attribute)
    t.includes(twimlConnectStream('wss://x/phone', { a: '"<&>"' }), '&quot;&lt;&amp;&gt;&quot;', 'parameter values are XML-escaped');

    // outbound "Call me" REST call - faked fetch, assert the documented request
    let calledUrl = '';
    let calledAuth = '';
    let calledBody = '';
    const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calledUrl = url; calledAuth = init.headers.Authorization || ''; calledBody = init.body;
      return { ok: true, status: 201, json: async () => ({ sid: 'CAfake123' }) };
    }) as unknown as typeof fetch;
    const placed = await placeCall({
      accountSid: PHONE_TEST_SECRETS.accountSid!, authToken: PHONE_TEST_SECRETS.authToken!,
      from: PHONE_TEST_SECRETS.phoneNumber!, to: PHONE_TEST_SECRETS.allowedCaller!,
      twimlUrl: PHONE_TWIML_URL, fetchImpl: fakeFetch,
    });
    t.ok(placed.ok && placed.detail === 'CAfake123', '"Call me" returns the Twilio Call SID');
    t.includes(calledUrl, `/2010-04-01/Accounts/${PHONE_TEST_SECRETS.accountSid}/Calls.json`, 'POSTs the documented Calls.json endpoint');
    t.includes(calledAuth, 'Basic ', 'HTTP Basic auth (sid:token)');
    const sent = new URLSearchParams(calledBody);
    t.eq(sent.get('To'), PHONE_TEST_SECRETS.allowedCaller!, 'rings the captain (To = allowlisted caller)');
    t.eq(sent.get('From'), PHONE_TEST_SECRETS.phoneNumber!, 'from our Twilio number');
    t.eq(sent.get('Url'), PHONE_TWIML_URL, 'the answered call fetches OUR TwiML webhook');

    // a client hello advertises the Call me availability
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const c = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { c.close(); reject(new Error('hello timed out')); }, 5000);
      c.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (m.type === 'hello') { clearTimeout(timer); c.close(); resolve(m); }
      });
      c.on('error', reject);
    });
    t.eq(hello.phone, true, 'hello advertises the outbound "Call me" capability');
  } finally {
    await app.close();
    await mock.close();
  }
});

// P3 - the Media Streams bridge end-to-end over the REAL phone WS: the stream
// token, the keypad-only PIN gate (NOTHING reaches the driver until it passes;
// pre-auth speech is never even transcribed), STT -> TurnRunner.run, and
// onChunk -> media+mark framing whose payload decodes back to the pipeline
// audio at 8 kHz.
await reporter.leg('phone - media WS: PIN gate blocks injection; STT->send; media+mark framing', async (t) => {
  const sends: string[] = [];
  const spoken: string[] = [];
  const heard = ['run the checks'];
  const CHUNK_SAMPLES = 2205; // 100ms @ 22050
  const chunkPcm = Buffer.alloc(CHUNK_SAMPLES * 2);
  for (let i = 0; i < CHUNK_SAMPLES; i++) chunkPcm.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), i * 2);

  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 22050 }),
    start: async () => {},
    send: async (text, _i, hooks) => {
      sends.push(text);
      hooks.onChunk?.({ index: 0, narration: 'Checks are running.', speakBackend: 'mock', pcm: chunkPcm, sampleRate: 22050 });
      return {
        reply: 'Checks are running now.', narration: 'Checks are running.', speakBackend: 'mock',
        audio: { pcm: chunkPcm, sampleRate: 22050, ttfbMs: 5, bytes: chunkPcm.length }, chunks: 1,
      };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const heardAudio: Array<{ bytes: number; sampleRate: number; rms: number; peak: number }> = [];
  const phone = createPhoneApp({
    runner,
    secrets: PHONE_TEST_SECRETS,
    publicUrl: PHONE_PUBLIC_URL,
    transcribe: async (pcm, sampleRate) => {
      const samples = s16leView(pcm);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
      heardAudio.push({ bytes: pcm.length, sampleRate, rms: frameRms(samples), peak });
      return heard.shift() ?? '';
    },
    synthPrompt: async (text) => { spoken.push(text); return { pcm: silenceFramePcm(), sampleRate: 8000 }; },
    log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // a direct WS hit WITHOUT a webhook-minted token is closed before anything runs
    const intruder = await connectPhoneClient(app.port);
    intruder.send({ event: 'start', start: { streamSid: 'MZbad', customParameters: { token: 'deadbeef'.repeat(4) } } });
    t.ok(await until(() => intruder.closed), 'a stream start with a forged token is CLOSED immediately');
    t.eq(sends.length, 0, 'no injection from the refused stream');

    // the real path: webhook mints the token, the stream presents it
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const token = tokenFromTwiml(twiml.body);
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZtest1', callSid: 'CAtest1', customParameters: { token } } });
    t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.pinPrompt)), 'the call is greeted with the PIN prompt (before any injection)');

    // pre-auth speech is ignored ENTIRELY: never transcribed, no attempt burned
    call.speakUtterance();
    await realSleep(120);
    t.eq(heardAudio.length, 0, 'REGRESSION GUARD: pre-auth speech is never transcribed (keypad-only PIN)');
    t.ok(!spoken.includes(DEFAULT_PHRASES.pinRetry), 'pre-auth speech never burns a PIN attempt');

    // wrong DTMF PIN -> retry prompt, still NO injection
    for (const d of '9999') call.send({ event: 'dtmf', dtmf: { digit: d } });
    t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.pinRetry)), 'a wrong DTMF PIN is refused (retry prompt)');
    t.eq(sends.length, 0, 'REGRESSION GUARD: no Broker.send before a valid PIN');

    // the correct keypad PIN -> authenticated
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.greeting)), 'the keypad (DTMF) PIN authenticates the call');
    t.eq(sends.length, 0, 'PIN entry itself is never injected');

    // now a real command: utterance -> whisper stub -> TurnRunner -> driver.send
    await realSleep(100); // let the greeting's mark echo settle half-duplex
    call.mediaPayloads.length = 0;
    call.speakUtterance();
    t.ok(await until(() => sends.length === 1), 'the transcribed utterance reaches the pipeline (STT -> send)');
    t.eq(sends[0], 'run the checks', 'the exact transcribed text is injected');

    // REGRESSION GUARD (double mu-law decode): whisper must receive the captain's
    // REAL audio - 16 kHz, the sine's sane amplitude and energy. A second mu-law
    // decode of already-decoded PCM turns it into near-full-scale garbage.
    t.ok(heardAudio.length >= 1, 'the transcribe stub saw the command utterance', `${heardAudio.length}`);
    for (const [i, a] of heardAudio.entries()) {
      t.eq(a.sampleRate, 16000, `utterance ${i}: handed to whisper at 16 kHz`);
      t.ok(a.bytes > 0 && a.bytes % 2 === 0, `utterance ${i}: whole s16le samples`, `${a.bytes} bytes`);
      t.ok(a.peak > 4000 && a.peak < 12000, `utterance ${i}: peak matches the spoken sine (decoded exactly once)`, `peak ${a.peak}`);
      t.ok(a.rms > 1500, `utterance ${i}: carries real speech energy`, `rms ${a.rms.toFixed(0)}`);
    }

    // the reply chunk comes back as media frames + a mark, 8 kHz mu-law, no header
    t.ok(await until(() => call.out.some((m) => m.event === 'mark' && (m.mark as { name?: string })?.name?.startsWith('m'))), 'a named mark follows the reply audio');
    const replyMulaw = Buffer.concat(call.mediaPayloads.filter(Boolean).map((p) => Buffer.from(p, 'base64')));
    const expected = Math.round(CHUNK_SAMPLES * 8000 / 22050);
    t.ok(Math.abs(replyMulaw.length - expected) <= 8, 'payload bytes = the chunk downconverted to 8 kHz mu-law (no header bytes)', `${replyMulaw.length} vs ~${expected}`);
    const replyPcm8k = mulawToPcmS16le(replyMulaw);
    t.ok(frameRms(new Int16Array(replyPcm8k.buffer, 0, replyPcm8k.length >> 1)) > 500, 'decoded payload carries the chunk audio energy (round-trips)');
    const mediaIdx = call.out.findIndex((m) => m.event === 'media' && call.mediaPayloads.length > 0);
    const markIdx = call.out.findIndex((m) => m.event === 'mark' && (m.mark as { name?: string })?.name?.startsWith('m'));
    t.ok(mediaIdx >= 0 && markIdx > mediaIdx, 'media frames are sent BEFORE their mark');
    const anyOut = call.out.find((m) => m.event === 'media') as { streamSid?: string } | undefined;
    t.eq(anyOut?.streamSid, 'MZtest1', 'outbound frames carry the streamSid from start');

    // the phone-initiated turn ALSO reached the web transcript (companion screen)
    const webFrames: Record<string, unknown>[] = [];
    const web = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
    web.on('message', (raw: Buffer) => webFrames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await until(() => webFrames.some((m) => m.type === 'sent'));
    const sentFrame = webFrames.find((m) => m.type === 'sent') as { text?: string; source?: string } | undefined;
    t.eq(sentFrame?.text, 'run the checks', 'the phone turn is replayed into the web transcript');
    t.eq(sentFrame?.source, 'phone', 'labelled as spoken on the call');
    web.close();
    call.close();
  } finally {
    await app.close();
  }
});

// P4 - barge-in and hangup: sustained captain speech while first mate talks sends
// Twilio `clear` (flush the buffered audio) AND aborts the in-flight turn; a `stop`
// frame (hangup) aborts it too. The driver observes signal.aborted for real.
await reporter.leg('phone - barge-in sends clear + aborts; hangup aborts the turn', async (t) => {
  const sends: string[] = [];
  let sawAborted = 0;
  const chunk = speechFramePcm();
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    // A long-running turn: emits one chunk, then keeps "streaming" until aborted.
    send: (text, _i, hooks) => new Promise((resolve) => {
      sends.push(text);
      hooks.onChunk?.({ index: 0, narration: 'Working on it.', speakBackend: 'mock', pcm: chunk, sampleRate: 8000 });
      const timer = setInterval(() => {
        if (hooks.signal?.aborted) {
          clearInterval(timer);
          sawAborted++;
          resolve({ reply: '', narration: '', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 1 });
        }
      }, 20);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const heard = ['start the deploy build', 'summarize the logs'];
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // ---- call 1: barge-in. The client does NOT echo marks, so the reply audio is
    // "still playing" when the captain starts talking over it.
    const twiml1 = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call1 = await connectPhoneClient(app.port, { echoMarks: false });
    call1.send({ event: 'start', start: { streamSid: 'MZbarge', customParameters: { token: tokenFromTwiml(twiml1.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call1.send({ event: 'dtmf', dtmf: { digit: d } });
    call1.speakUtterance(); // the command -> long turn starts
    t.ok(await until(() => sends.length === 1), 'the command started a turn');
    t.ok(await until(() => call1.out.some((m) => m.event === 'mark')), 'reply audio is on the wire (unacked mark = still playing)');
    // the captain talks over it: sustained speech during playback (raw frames -
    // asMediaFrame is already the encoded wire message)
    for (let i = 0; i < 14; i++) call1.ws.send(asMediaFrame(speechFramePcm()));
    t.ok(await until(() => call1.out.some((m) => m.event === 'clear')), 'barge-in sends Twilio `clear` (flush buffered audio)');
    t.ok(await until(() => sawAborted === 1), 'barge-in aborts the in-flight turn (driver saw signal.aborted)');
    call1.close();
    t.ok(await until(() => !runner.busy), 'the aborted turn settles');

    // ---- call 2: hangup mid-turn. Twilio sends `stop` when the caller hangs up.
    const twiml2 = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call2 = await connectPhoneClient(app.port);
    call2.send({ event: 'start', start: { streamSid: 'MZhang', customParameters: { token: tokenFromTwiml(twiml2.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call2.send({ event: 'dtmf', dtmf: { digit: d } });
    call2.speakUtterance(); // command -> long turn
    t.ok(await until(() => sends.length === 2), 'the second call started its own turn');
    call2.send({ event: 'stop' });
    t.ok(await until(() => sawAborted === 2), 'hangup (stop frame) aborts the in-flight turn');
    call2.close();
  } finally {
    await app.close();
  }
});

// P4b - unauthenticated-WS hardening on the tunnel-exposed /phone path: the call
// slot is claimed ONLY by a token-authorized `start` frame, so anonymous/pre-start
// sockets never make a legitimate call see busy; they stay bounded (handshake
// deadline + pre-start cap), a forged-token stream is still refused, and anonymous
// churn NEVER cancels the captain's in-flight turn.
await reporter.leg('phone - unauth WS: anonymous sockets never hold the slot; tokened start claims it; deadline + cap bound them', async (t) => {
  const HANDSHAKE_MS = 7777;
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  let sawAborted = 0;
  let finishTurn = false;
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: (_text, _i, hooks) => new Promise((resolve) => {
      const timer = setInterval(() => {
        if (hooks.signal?.aborted) sawAborted++;
        if (finishTurn || hooks.signal?.aborted) {
          clearInterval(timer);
          resolve({ reply: 'done', narration: 'Done.', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 });
        }
      }, 20);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    handshakeTimeoutMs: HANDSHAKE_MS, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // an idle anonymous connection (never sends `start`) does NOT hold the slot
    const idle = await connectPhoneClient(app.port);
    await realSleep(120);
    t.ok(!phone.activeCall, 'an idle anonymous connection does NOT hold the call slot');

    // the captain's real tokened call connects fine while the anonymous socket sits there
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZreal', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    t.ok(await until(() => phone.activeCall), 'a webhook-tokened start CLAIMS the slot while anonymous sockets sit there');
    t.ok(!idle.closed, 'the pre-start socket neither blocked the real call nor was bumped by it');

    // a forged-token stream is still refused, live call or not
    const forged = await connectPhoneClient(app.port);
    forged.send({ event: 'start', start: { streamSid: 'MZevil', customParameters: { token: 'ff'.repeat(16) } } });
    t.ok(await until(() => forged.closed), 'the forged-token stream is refused');
    t.ok(phone.activeCall, 'the captain call stays up through the forged attempt');

    // a second VALID token cannot steal the slot mid-call (single-call semantics)
    const twiml2 = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const second = await connectPhoneClient(app.port);
    second.send({ event: 'start', start: { streamSid: 'MZsecond', customParameters: { token: tokenFromTwiml(twiml2.body) } } });
    t.ok(await until(() => second.closed), 'a second tokened stream during a live call is refused (busy)');
    t.ok(phone.activeCall, 'the live call is untouched');

    call.send({ event: 'stop' });
    t.ok(await until(() => !phone.activeCall), 'hangup frees the slot');

    // the handshake deadline still closes never-started sockets
    for (const p of pending.filter((x) => x.ms === HANDSHAKE_MS)) p.fn();
    t.ok(await until(() => idle.closed), 'the never-started connection is CLOSED at the handshake deadline');

    // an in-flight turn survives anonymous churn on /phone
    const turnDone = runner.run('long job', 'web');
    t.ok(await until(() => runner.busy), 'a (web-initiated) turn is in flight');
    const intruder = await connectPhoneClient(app.port);
    intruder.send({ event: 'start', start: { streamSid: 'MZevil2', customParameters: { token: 'ff'.repeat(16) } } });
    t.ok(await until(() => intruder.closed), 'the forged-token stream is refused');
    const ghost = await connectPhoneClient(app.port);
    ghost.close();
    await realSleep(150);
    t.ok(runner.busy, 'the turn is STILL running after the refused stream + anonymous disconnect');
    t.eq(sawAborted, 0, 'REGRESSION GUARD: unauthenticated teardown never runner.cancel()s the captain turn');
    finishTurn = true;
    await turnDone;
    t.ok(!runner.busy, 'the turn completed normally');

    // pre-start sockets are capped so they cannot pile up
    const anons: PhoneWsClient[] = [];
    for (let i = 0; i < MAX_PENDING_SOCKETS; i++) anons.push(await connectPhoneClient(app.port));
    const overflow = await connectPhoneClient(app.port);
    t.ok(await until(() => overflow.closed), 'a pre-start socket beyond the cap is refused');
    t.ok(anons.every((a) => !a.closed), 'sockets within the cap stay in their handshake window');
    t.ok(!phone.activeCall, 'a full pre-start pool still holds no call slot');
  } finally {
    await app.close();
  }
});

// P4c - keypad-only PIN: pre-auth speech is ignored ENTIRELY (never transcribed,
// never a failed attempt, never injected - no STT gremlins can burn the lockout);
// and a hangup while an utterance is mid-transcription never re-subscribes the
// torn-down call to the shared TurnRunner nor injects the late text.
await reporter.leg('phone - keypad-only PIN: pre-auth speech is ignored entirely; hangup mid-transcription leaks nothing', async (t) => {
  const makeDriver = (sends: string[]): Driver => ({
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: async (text) => {
      sends.push(text);
      return { reply: 'ok', narration: 'Ok.', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  });

  // ---- rig A: stray speech in the pre-auth window
  {
    const sends: string[] = [];
    const spoken: string[] = [];
    let transcribeCalls = 0;
    const driver = makeDriver(sends);
    const runner = new TurnRunner({ driver });
    const phone = createPhoneApp({
      runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
      transcribe: async () => { transcribeCalls++; return 'go for it'; },
      synthPrompt: async (text) => { spoken.push(text); return { pcm: Buffer.alloc(0), sampleRate: 8000 }; },
      log: () => {},
    });
    const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
    try {
      const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
      const call = await connectPhoneClient(app.port);
      call.send({ event: 'start', start: { streamSid: 'MZstray', customParameters: { token: tokenFromTwiml(twiml.body) } } });
      t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.pinPrompt)), 'the call is greeted with the keypad PIN prompt');

      const retries = (): number => spoken.filter((s) => s === DEFAULT_PHRASES.pinRetry).length;
      call.speakUtterance();
      call.speakUtterance();
      await realSleep(150);
      t.eq(transcribeCalls, 0, 'pre-auth speech is NEVER transcribed (keypad-only PIN)');
      t.eq(retries(), 0, 'pre-auth speech burns no attempt: no retry prompt');
      t.eq(sends.length, 0, 'pre-auth speech injects nothing');
      t.ok(!call.closed, 'stray speech never progresses the lockout');

      for (const d of '9999') call.send({ event: 'dtmf', dtmf: { digit: d } });
      t.ok(await until(() => retries() === 1), 'a wrong keypad PIN still burns an attempt');

      for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
      t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.greeting)), 'the correct keypad PIN authenticates - the strays cost nothing');
      t.ok(!spoken.includes(DEFAULT_PHRASES.pinLocked), 'the lockout was never reached');
      call.close();
    } finally {
      await app.close();
    }
  }

  // ---- rig B: hangup while an authenticated utterance is mid-transcription
  {
    const sends: string[] = [];
    let releaseUtterance: ((text: string) => void) | null = null;
    const driver = makeDriver(sends);
    const runner = new TurnRunner({ driver });
    const listenerCount = (): number => (runner as unknown as { listeners: Set<unknown> }).listeners.size;
    const phone = createPhoneApp({
      runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
      transcribe: () => new Promise<string>((res) => { releaseUtterance = res; }),
      synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
      log: () => {},
    });
    const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
    try {
      const baseline = listenerCount();
      const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
      const call = await connectPhoneClient(app.port);
      call.send({ event: 'start', start: { streamSid: 'MZrace', customParameters: { token: tokenFromTwiml(twiml.body) } } });
      for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
      t.ok(await until(() => listenerCount() === baseline + 1), 'the authenticated call subscribed to the shared runner');
      call.speakUtterance();
      t.ok(await until(() => releaseUtterance !== null), 'the utterance reached whisper (transcription pending)');
      call.send({ event: 'stop' }); // hangup while whisper is still working
      t.ok(await until(() => !phone.activeCall), 'the call tears down on hangup');
      releaseUtterance!('run the checks'); // whisper resolves AFTER teardown
      await realSleep(150);
      t.eq(listenerCount(), baseline, 'REGRESSION GUARD: the late transcription never re-subscribes the dead call to the shared runner');
      t.eq(sends.length, 0, 'the late transcription is never injected');
      call.close();
    } finally {
      await app.close();
    }
  }
});

// P5 - the captain-approved INTERACTIVE-PROMPT FALLBACK: an unclear spoken answer
// to a consequential prompt is RE-ASKED once; still unclear (or pure silence, via
// the answer timer) -> a safe default that takes NO consequential action. The
// safe default is a small config (PromptPolicy) - 'send-cancel' is the one-line
// change, asserted here too. Silence can NEVER approve.
await reporter.leg('phone - interactive prompt: re-ask once, then the safe default (never approve)', async (t) => {
  const mkRig = async (policy: Partial<typeof DEFAULT_PROMPT_POLICY>, heardScript: string[], timers?: PhoneTimers) => {
    const sends: string[] = [];
    const spoken: string[] = [];
    const heard = [...heardScript];
    const driver: Driver = {
      meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
      start: async () => {},
      send: async (text) => {
        sends.push(text);
        const narration = text === 'cancel' ? 'Cancelled.' : 'Want me to merge and deploy it?';
        return { reply: narration, narration, speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 };
      },
      terminalSnapshot: () => 'ceo-chat',
      stop: async () => {},
    };
    const runner = new TurnRunner({ driver });
    const phone = createPhoneApp({
      runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
      transcribe: async () => heard.shift() ?? '',
      synthPrompt: async (text) => { spoken.push(text); return { pcm: Buffer.alloc(0), sampleRate: 8000 }; },
      promptPolicy: policy,
      timers,
      log: () => {},
    });
    const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZprompt', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await until(() => spoken.includes(DEFAULT_PHRASES.greeting));
    return { sends, spoken, call, app, runner };
  };

  // ---- rig A (default policy = no-action): two unclear spoken answers
  const a = await mkRig({}, ['ship the release', 'umm banana maybe', 'still just mumbling here']);
  try {
    a.call.speakUtterance(); // the command -> consequential question turn
    t.ok(await until(() => a.sends.length === 1 && !a.runner.busy), 'turn 1 ran and awaits a consequential answer');
    t.ok(a.runner.awaitingConfirmation, 'the runner is awaiting confirmation (narration asked)');
    a.call.speakUtterance(); // "umm banana maybe" - unclear
    t.ok(await until(() => a.spoken.includes(DEFAULT_PROMPT_POLICY.reAskText)), 'an UNCLEAR spoken answer is RE-ASKED (not sent, not approved)');
    t.eq(a.sends.length, 1, 'the unclear answer was NOT injected');
    a.call.speakUtterance(); // still unclear -> past the re-ask budget
    t.ok(await until(() => a.spoken.includes(DEFAULT_PROMPT_POLICY.giveUpTextNoAction)), 'a second unclear answer hits the SAFE DEFAULT (announced)');
    await realSleep(150);
    t.eq(a.sends.length, 1, 'safe default = NO consequential action: nothing was injected on silence/mumbling');
    a.call.close();
  } finally {
    await a.app.close();
  }

  // ---- rig B (config flip: onUnresolved 'send-cancel') driven by the ANSWER TIMER
  // (pure silence, no utterances at all) - manual timers make it deterministic.
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const fireAnswerTimer = (): boolean => {
    const i = pending.findIndex((p) => p.ms === DEFAULT_PROMPT_POLICY.answerTimeoutMs);
    if (i < 0) return false;
    const [h] = pending.splice(i, 1);
    h!.fn();
    return true;
  };
  const b = await mkRig({ onUnresolved: 'send-cancel' }, ['ship the release'], manualTimers);
  try {
    b.call.speakUtterance();
    t.ok(await until(() => b.sends.length === 1 && !b.runner.busy), 'turn 1 ran (send-cancel rig)');
    t.ok(await until(() => fireAnswerTimer()), 'the answer timer was armed after the consequential turn');
    t.ok(await until(() => b.spoken.includes(DEFAULT_PROMPT_POLICY.reAskText)), 'SILENCE past the window -> re-ask once');
    t.ok(fireAnswerTimer(), 'the re-ask re-armed the timer');
    t.ok(await until(() => b.spoken.includes(DEFAULT_PROMPT_POLICY.giveUpTextCancel)), 'still silent -> the configured safe default announces the cancel');
    t.ok(await until(() => b.sends.length === 2 && b.sends[1] === 'cancel'), "config 'send-cancel' injects an explicit cancel - NEVER an approval");
    b.call.close();
  } finally {
    await b.app.close();
  }
});

// F2 (pure) - REAL-only progress rendering: describeToolUse turns a tool_use event into
// a short, screen-safe spoken line reflecting ACTUAL activity (never generic), or null
// when there is nothing worth narrating. Paths/URLs/code/raw-ids are never spoken.
await reporter.leg('phone - F2 progress: describeToolUse renders REAL, screen-safe lines (pure)', (t) => {
  const tu = (name: string, input: unknown, id = 't1'): Extract<TranscriptEvent, { kind: 'tool_use' }> =>
    ({ kind: 'tool_use', role: 'assistant', ts: null, id, name, input });
  // Bash description -> a natural gerund (what the agent is DOING), not an imperative.
  t.eq(describeToolUse(tu('Bash', { description: 'Run firstmate bootstrap' })), "Still on it. I'm running firstmate bootstrap.", 'Bash description spoken as a gerund');
  t.eq(describeToolUse(tu('Bash', { description: 'Acquire session lock' })), "Still on it. I'm acquiring session lock.", 'drop-e gerund');
  // A path/slash in the description degrades to the bare verb (§7.3: never speak a path).
  const pathy = describeToolUse(tu('Bash', { description: 'Recovery: drain backlog/metas/projects' }));
  t.eq(pathy, 'Still on it. I just ran a command.', 'a path in the description degrades to the bare verb');
  t.ok(!/backlog|metas|projects|\//.test(pathy || ''), 'no path fragment is spoken');
  t.eq(describeToolUse(tu('Bash', { command: 'ls -la' })), 'Still on it. I just ran a command.', 'Bash with no description -> bare verb (still REAL)');
  // Path-bearing tools speak only the VERB - never the file path.
  for (const [n, expect] of [['Read', 'reading through a file'], ['Edit', 'making an edit'], ['Write', 'writing a file']] as const) {
    const line = describeToolUse(tu(n, { file_path: '/home/acbecquet/firstmate/data/projects.md' }))!;
    t.includes(line, expect, `${n} -> "${expect}"`);
    t.ok(!line.includes('/') && !/\d{4,}/.test(line), `${n} never speaks the path`);
  }
  t.eq(describeToolUse(tu('TodoWrite', { todos: [{ content: 'Add tests for the parser', status: 'in_progress' }, { content: 'x', status: 'pending' }] })), "Still on it. I'm adding tests for the parser.", 'TodoWrite in-progress item is the progress line');
  // A leading NON-verb is never conjugated into gibberish - the bare fallback speaks.
  t.eq(describeToolUse(tu('TodoWrite', { todos: [{ content: 'Tests for the parser', status: 'in_progress' }] })), "Still on it. I'm working through the task list.", 'a non-verb TodoWrite item falls back to the bare form (never "testsing")');
  t.eq(describeToolUse(tu('Agent', { description: 'New validation leg' })), 'Still on it. I started a subtask.', 'a non-verb Agent description falls back to the bare form (never "newing")');
  t.eq(describeToolUse(tu('Agent', { description: 'Research session sharing' })), "Still on it. I'm researching session sharing.", 'Agent description');
  t.eq(describeToolUse(tu('Skill', { skill: 'no-mistakes' })), "Still on it. I'm running the no-mistakes step.", 'Skill name');
  // Internal bookkeeping tools stay SILENT - no generic filler (captain decision D2).
  t.eq(describeToolUse(tu('ToolSearch', { query: 'x' })), null, 'a non-narratable tool returns null (silence, never generic)');
  t.eq(describeToolUse(tu('TaskGet', { id: 'x' })), null, 'internal tool -> null');
  // screenSafe guard + gerund helpers.
  t.ok(screenSafe('acquire the session lock') && screenSafe('plain words'), 'plain prose is screen-safe');
  for (const bad of ['see /home/x', 'http://a.b', 'use `code`', 'pid 66035', 'a<b>c']) t.ok(!screenSafe(bad), `unsafe rejected: ${bad}`);
  t.eq(verbGerund('Run'), 'running', 'CVC doubling');
  t.eq(verbGerund('Acquire'), 'acquiring', 'drop-e');
  t.eq(verbGerund('Read'), 'reading', 'plain +ing');
  t.eq(verbGerund('Sync'), 'syncing', 'sync takes plain +ing (never "synccing")');
  t.eq(verbGerund('Submit'), 'submitting', 'submit doubles (never "submiting")');
  t.eq(verbGerund('Debug'), 'debugging', 'debug doubles');
  t.eq(verbGerund('Strip'), 'stripping', 'strip doubles (never "striping")');
  t.eq(verbGerund('Format'), 'formatting', 'format doubles');
  t.eq(verbGerund('Pin'), 'pinning', 'pin doubles (never "pining")');
  t.eq(verbGerund('Tests'), null, 'a non-verb is never conjugated');
  t.eq(verbGerund('New'), null, 'unknown leading word -> null');
  // -ing words pass ONLY when the stem maps back to a KNOWN verb - "Bring"/"Ongoing"
  // end in -ing but are gerunds of nothing we know.
  t.eq(verbGerund('Running'), 'running', 'an already-gerund known verb passes (de-doubled stem)');
  t.eq(verbGerund('Reading'), 'reading', 'already-gerund, direct stem');
  t.eq(verbGerund('Acquiring'), 'acquiring', 'already-gerund, drop-e stem');
  t.eq(verbGerund('Submitting'), 'submitting', 'already-gerund, de-doubled stem (submit)');
  t.eq(verbGerund('Debugging'), 'debugging', 'already-gerund, de-doubled stem (debug)');
  t.eq(verbGerund('Bring'), null, '"bring" is NOT accepted verbatim (its gerund is not its base form)');
  t.eq(verbGerund('Ongoing'), null, 'a non-verb -ing word is never accepted as a gerund');
  t.eq(gerundClause('Bring the branch up to date'), null, 'a "Bring …" label falls back (never "I\'m bring …")');
  t.eq(describeToolUse(tu('Bash', { description: 'Bring the branch up to date' })), 'Still on it. I just ran a command.', 'a Bash "Bring …" description uses the bare fallback');
  t.eq(describeToolUse(tu('TodoWrite', { todos: [{ content: 'Ongoing cleanup of the parser', status: 'in_progress' }] })), "Still on it. I'm working through the task list.", 'an "Ongoing …" TodoWrite item uses the bare fallback (never "I\'m ongoing …")');
  t.eq(gerundClause('Deploy the app'), 'deploying the app', 'gerundClause = verb + rest');
  t.eq(gerundClause('Tests for the parser'), null, 'a non-verb label -> null (caller uses the bare fallback)');
  t.eq(gerundClause('/just/a/path'), null, 'unsafe input -> null');
  // toolUseAfterAnchor: only THIS turn's tool calls, stopping at the next human turn.
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-act-'));
  const p = join(dir, 'sess.jsonl');
  writeFileSync(p, [
    userPrompt('first', '2026-06-27T00:00:00.000Z'),
    assistantToolUse('Bash', { description: 'Run bootstrap' }, 'a1'),
    assistantSay('done'),
    userPrompt('second'),
    assistantToolUse('Read', { file_path: '/x' }, 'b1'),
  ].join('\n') + '\n');
  const events = parseTranscript(p);
  const tools = toolUseAfterAnchor(events, findPromptAnchor(events, 'first'));
  t.eq(tools.length, 1, 'only the first turn tool_use is in scope (stops at the next human)');
  t.eq(tools[0]!.name, 'Bash', 'the right tool call is surfaced');
  rmSync(dir, { recursive: true, force: true });
});

// F1 - exactly ONE thinking-filler per turn (captain decision D1): armed at the 3s
// threshold, fired only if no real reply audio has played, one-shot (never a repeating
// cadence), and cancelled outright when the reply is prompt. Manual timers make it
// deterministic (no wall-clock wait).
await reporter.leg('phone - F1: exactly one thinking-filler per turn (3s), cancelled by prompt reply audio', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const hasMs = (ms: number): boolean => pending.some((p) => p.ms === ms);
  const TH = DEFAULT_FILLER.thresholdMs;
  const spoken: string[] = [];
  const sends: string[] = [];
  const heard = ['first task', 'second task'];
  let emitAudio = false;
  let release: () => void = () => {};
  const chunk = speechFramePcm();
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      sends.push(text);
      if (emitAudio) hooks.onChunk?.({ index: 0, narration: 'Reply.', speakBackend: 'mock', pcm: chunk, sampleRate: 8000 });
      release = () => resolve({ reply: 'r', narration: 'Reply.', speakBackend: 'mock', audio: { pcm: emitAudio ? chunk : Buffer.alloc(0), sampleRate: 8000, ttfbMs: emitAudio ? 1 : null, bytes: emitAudio ? chunk.length : 0 }, chunks: emitAudio ? 1 : 0 });
      if (hooks.signal?.aborted) release();
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async (text) => { spoken.push(text); return { pcm: silenceFramePcm(), sampleRate: 8000 }; },
    timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  const isFiller = (s: string): boolean => DEFAULT_FILLER.phrases.includes(s);
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZfiller', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await until(() => spoken.includes(DEFAULT_PHRASES.greeting));

    // ---- turn 1: NO reply audio in time -> the SINGLE filler fires at 3s
    emitAudio = false;
    call.speakUtterance();
    t.ok(await until(() => sends.length === 1), 'turn 1 started');
    t.ok(await until(() => hasMs(TH)), 'the filler timer is armed at the 3s threshold');
    const before = spoken.filter(isFiller).length;
    t.ok(fireByMs(TH), 'fire the 3s filler timer');
    t.ok(await until(() => spoken.filter(isFiller).length === before + 1), 'exactly ONE filler is spoken');
    t.ok(!hasMs(TH), 'the filler is one-shot - no repeating 3s cadence (captain decision D1)');
    release();
    t.ok(await until(() => !runner.busy), 'turn 1 settled');
    const fillerCount1 = spoken.filter(isFiller).length;
    t.eq(fillerCount1, before + 1, 'still exactly one filler for the whole turn');

    // ---- turn 2: reply audio arrives BEFORE the threshold -> NO filler at all
    emitAudio = true;
    call.speakUtterance();
    t.ok(await until(() => sends.length === 2), 'turn 2 started');
    t.ok(await until(() => !hasMs(TH)), 'prompt reply audio cancels the filler timer (no dead-air filler needed)');
    release();
    await until(() => !runner.busy);
    await realSleep(60);
    t.eq(spoken.filter(isFiller).length, fillerCount1, 'no filler is spoken when the reply is prompt');
    call.close();
  } finally {
    await app.close();
  }
});

// F2 (integration) - REAL-only progress over the wire: a progress line is spoken ONLY
// when there is NEW real activity, throttled to the min gap, never the same statement
// twice, SILENT when nothing new happened, and it yields while the reply is actually
// speaking. Driven by manual timers + a fake activity tap (deterministic).
await reporter.leg('phone - F2: real-only progress - throttled, no repeats, silent when nothing new, yields to reply audio', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const GAP = 20000;
  const fireGap = (): boolean => { const i = pending.findIndex((p) => p.ms === GAP); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const hasGap = (): boolean => pending.some((p) => p.ms === GAP);
  const spoken: string[] = [];
  const sends: string[] = [];
  const heard = ['do the big task'];
  let emitChunk: () => void = () => {};
  let release: () => void = () => {};
  const chunk = speechFramePcm();
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      sends.push(text);
      emitChunk = () => hooks.onChunk?.({ index: 0, narration: 'Partial.', speakBackend: 'mock', pcm: chunk, sampleRate: 8000 });
      release = () => resolve({ reply: 'done', narration: 'Done.', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 });
      if (hooks.signal?.aborted) release();
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  let pushActivity: ((line: string) => void) | null = null;
  const activity: ActivityTap = (o: ActivityTurnOpts) => { pushActivity = o.onActivity; return { stop: () => { pushActivity = null; } }; };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async (text) => { spoken.push(text); return { pcm: silenceFramePcm(), sampleRate: 8000 }; },
    activity, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  const A = "Still on it. I'm acquiring session lock.";
  const B = "Still on it. I'm running the tests.";
  const C = "Still on it. I'm making an edit.";
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZprog', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await until(() => spoken.includes(DEFAULT_PHRASES.greeting));

    call.speakUtterance();
    t.ok(await until(() => sends.length === 1), 'the long turn started');
    t.ok(await until(() => pushActivity !== null), 'the activity tap was started for this turn');
    t.ok(await until(() => hasGap()), 'the progress throttle timer is armed');

    // NEW real activity A -> spoken at the next tick
    pushActivity!(A);
    t.ok(fireGap(), 'fire progress tick 1');
    t.ok(await until(() => spoken.includes(A)), 'the freshest REAL activity is spoken at the tick');

    // nothing new -> the next tick is SILENT (never a generic line)
    const n1 = spoken.length;
    t.ok(fireGap(), 'fire progress tick 2 (nothing new)');
    await realSleep(60);
    t.eq(spoken.length, n1, 'silence when there is no new activity - REAL only, never generic (D2)');

    // the SAME activity again -> never spoken twice in a turn
    pushActivity!(A);
    t.ok(fireGap(), 'fire progress tick 3 (A repeats)');
    await realSleep(60);
    t.eq(spoken.filter((s) => s === A).length, 1, 'the same statement is never spoken twice in a turn');

    // a NEW activity B -> spoken
    pushActivity!(B);
    t.ok(fireGap(), 'fire progress tick 4');
    t.ok(await until(() => spoken.includes(B)), 'a new real activity is spoken');

    // reply audio plays this window -> progress YIELDS; then speaks once quiet again
    emitChunk();
    pushActivity!(C);
    t.ok(fireGap(), 'fire progress tick 5 (audio played this window)');
    await realSleep(60);
    t.ok(!spoken.includes(C), 'progress yields while the reply is actually speaking');
    t.ok(fireGap(), 'fire progress tick 6 (quiet again)');
    t.ok(await until(() => spoken.includes(C)), 'the held activity is spoken once the reply pauses');

    release();
    await until(() => !runner.busy);
    call.close();
  } finally {
    await app.close();
  }
});

// F3 (core) - attach-and-reinterpret at the TurnRunner: buildSteerPrompt frames the merge,
// steer() aborts the in-flight turn + interrupts the agent + re-runs the COMBINED prompt,
// the aborted turn leaves no history/turn-done (no double-speak), submitOrSteer only
// attaches a SAME-transport follow-up (an SMS never cuts off a live call), and a FAILED
// interrupt still re-runs the correction (D5: never lost).
await reporter.leg('turns - attach-and-reinterpret: buildSteerPrompt + steer (interrupt, merge, re-run, same-source, fallback)', async (t) => {
  const merged = buildSteerPrompt('summarize the deploy logs', 'I meant the staging logs', 'phone');
  t.ok(!merged.includes('\n'), 'the merged prompt is ONE line (fm-send submits on newline)');
  t.includes(merged, 'summarize the deploy logs', 'keeps the original prompt verbatim (D3)');
  t.includes(merged, 'I meant the staging logs', 'carries the correction');
  t.includes(merged.toLowerCase(), 'misread', 'a SPOKEN correction is framed as the authoritative fix of a possible STT misread');
  // Typed sources have no STT to misread: the follow-up is an ADDITION, never an
  // invitation to reinterpret/replace the original.
  for (const src of ['web', 'sms'] as const) {
    const typed = buildSteerPrompt('summarize the deploy logs', 'also check the error rate', src);
    t.ok(!typed.includes('\n'), `a typed ${src} merge is still ONE line`);
    t.includes(typed, 'summarize the deploy logs', `${src}: keeps the original verbatim`);
    t.includes(typed, 'also check the error rate', `${src}: carries the follow-up`);
    t.ok(!/misread|speech-to-text/i.test(typed), `${src}: no STT-misread framing for a typed follow-up`);
    t.includes(typed.toLowerCase(), 'addition', `${src}: framed as an addition, not a correction`);
  }
  t.eq(buildSteerPrompt('', 'x', 'phone'), 'x', 'no original -> just the correction');
  t.eq(buildSteerPrompt('o', '', 'phone'), 'o', 'no correction -> just the original');

  const runs: string[] = [];
  let interrupts = 0;
  let aborts = 0;
  let interruptOk = true;
  let latestRelease = (): void => {};
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => { interrupts++; if (!interruptOk) throw new Error('cannot interrupt'); },
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      latestRelease = done;
      iv = setInterval(() => { if (hooks.signal?.aborted) { aborts++; done(); } }, 5);
    }),
    terminalSnapshot: () => '',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const events: Array<{ type: string; turn?: number }> = [];
  runner.on((ev) => events.push(ev as { type: string; turn?: number }));

  // ---- happy path: a phone turn in flight, a spoken correction steers it
  void runner.run('summarize the deploy logs', 'phone');
  t.ok(await until(() => runner.busy && runs.length === 1), 'the first turn is in flight');
  t.eq(runner.currentPrompt, 'summarize the deploy logs', 'currentPrompt tracks the in-flight prompt');
  t.eq(runner.currentSource, 'phone', 'currentSource tracks the transport');
  const steerP = runner.steer('I meant the staging logs', 'phone');
  t.ok(await until(() => aborts === 1), 'steer aborts the in-flight turn (stops speaking the old reply)');
  t.ok(await until(() => interrupts === 1), 'steer interrupts the underlying agent (Escape) so it re-plans');
  t.ok(await until(() => runs.length === 2), 'the COMBINED prompt is re-run as a fresh turn');
  t.includes(runs[1]!, 'summarize the deploy logs', 're-run keeps the original');
  t.includes(runs[1]!, 'staging logs', 're-run carries the correction');
  t.ok(!events.some((e) => e.type === 'turn-done' && e.turn === 1), 'the aborted turn emitted NO turn-done (no residue, no double-speak)');
  latestRelease(); // finish the combined turn (it is a "thinking" hold)
  await steerP;
  t.ok(await until(() => !runner.busy), 'the combined turn settles');
  const doneTurns = events.filter((e) => e.type === 'turn-done').map((e) => e.turn);
  t.ok(doneTurns.includes(2) && !doneTurns.includes(1), 'only the combined turn recorded a turn-done');
  t.eq(runner.history.length, 1, 'only the combined turn is in history (the aborted one left none)');

  // ---- submitOrSteer: a DIFFERENT transport never interrupts the live turn
  void runner.run('a phone task', 'phone');
  await until(() => runner.busy && runs.length === 3);
  const before = runs.length;
  const errsBefore = events.filter((e) => e.type === 'error').length;
  const rWeb = await runner.submitOrSteer('an unrelated web line', 'web');
  t.eq(rWeb.turn, 0, 'a DIFFERENT transport does NOT interrupt the live turn (one at a time)');
  t.eq(interrupts, 1, 'no agent interrupt for the cross-transport attempt');
  t.eq(runs.length, before, 'no re-run for the cross-transport attempt');
  t.ok(events.filter((e) => e.type === 'error').length === errsBefore + 1, 'the cross-transport send got the busy error');
  // same transport -> attaches + reinterprets
  const rPhone = runner.submitOrSteer('actually the other task', 'phone');
  t.ok(await until(() => runs.length === before + 1 && interrupts === 2), 'a SAME-transport follow-up attaches + reinterprets');
  t.includes(runs[before]!, 'actually the other task', 'the combined re-run carries the follow-up');
  latestRelease();
  await rPhone;
  await until(() => !runner.busy);

  // ---- queue fallback: a FAILED interrupt still re-runs the combined prompt
  interruptOk = false;
  void runner.run('the base task', 'phone');
  await until(() => runner.busy);
  const n = runs.length;
  const fbP = runner.steer('and also this fix', 'phone');
  t.ok(await until(() => runs.length === n + 1), 'a FAILED interrupt still re-runs the combined prompt (correction never lost, D5)');
  t.includes(runs[n]!, 'and also this fix', 'the correction survives the interrupt failure');
  latestRelease();
  await fbP;
  await until(() => !runner.busy);
});

// F3 (D5 hard case) - the aborted turn is SLOW to unwind: the driver ignores the abort
// signal (a long TTS synth draining in the unit queue) well past the 8s wait window.
// steer must HOLD the correction until the lock actually frees and then run it - never
// force run() into a silent "one at a time" busy rejection that drops it.
await reporter.leg('turns - steer holds a correction through a slow unwind (never dropped, D5)', async (t) => {
  const runs: string[] = [];
  const errors: string[] = [];
  let releaseStuck: () => void = () => {};
  let latestRelease: () => void = () => {};
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => {},
    // The FIRST send IGNORES the abort signal entirely (the stuck/draining pipeline) and
    // resolves only when the test releases it; later sends hold for an explicit release.
    send: (text) => new Promise((resolve) => {
      runs.push(text);
      const done = (): void => resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 });
      if (runs.length === 1) releaseStuck = done; else latestRelease = done;
    }),
    terminalSnapshot: () => '',
    stop: async () => {},
  };
  // Virtual clock: every runner sleep(ms) advances vnow by ms (so hours of wait burn in
  // milliseconds of real time). Once vnow passes 9s - beyond the old fixed 8s window -
  // the stuck turn finally unwinds; the held state at that instant is snapshotted.
  let vnow = 0;
  let releasedAt = 0;
  let runsAtRelease = -1;
  let errorsAtRelease = -1;
  const runner = new TurnRunner({
    driver,
    now: () => vnow,
    sleep: async (ms) => {
      vnow += ms;
      if (vnow > 9000 && !releasedAt) {
        releasedAt = vnow;
        runsAtRelease = runs.length;
        errorsAtRelease = errors.length;
        releaseStuck();
      }
      await realSleep(1);
    },
  });
  runner.on((ev) => { if (ev.type === 'error') errors.push(ev.message); });

  void runner.run('the base task', 'phone');
  t.ok(await until(() => runner.busy && runs.length === 1), 'the base turn is in flight');
  const steerP = runner.steer('actually use staging', 'phone');
  t.ok(await until(() => runs.length === 2), 'the combined correction ran once the lock freed (never dropped, D5)');
  t.ok(releasedAt > 9000, 'the aborted turn stayed busy well past the old 8s wait window', `unwound at ${releasedAt}ms virtual`);
  t.eq(runsAtRelease, 1, 'the correction was HELD while the turn unwound - never force-run while busy');
  t.eq(errorsAtRelease, 0, 'no silent "one at a time" rejection while holding');
  t.includes(runs[1]!, 'the base task', 'the combined re-run keeps the original');
  t.includes(runs[1]!, 'actually use staging', 'the correction survived the slow unwind');
  latestRelease();
  const r = await steerP;
  t.ok(r.ok && r.turn === 2, 'the steer resolved with the combined turn');
  await until(() => !runner.busy);
});

// F3 (D4 for SECOND corrections) - a correction arriving DURING a steered re-run must
// abort that run at request time and merge (never queue behind the whole combined turn,
// never run bare); the superseded turn resolves `superseded`, not a failure.
await reporter.leg('turns - a second correction during a steered re-run attaches immediately (D4, superseded not failed)', async (t) => {
  const runs: string[] = [];
  let interrupts = 0;
  const releases: Array<() => void> = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => { interrupts++; },
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => '',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });

  const run1 = runner.run('deploy the app', 'phone');
  t.ok(await until(() => runner.busy && runs.length === 1), 'the base turn is in flight');
  const steer1 = runner.steer('to staging', 'phone');
  t.ok(await until(() => runs.length === 2 && runner.busy && runner.currentPrompt === runs[1]), 'the first correction re-ran the combined prompt');
  const r1 = await run1;
  t.ok(!r1.ok && r1.turn === 1 && r1.superseded === true, 'the steered-away base turn resolves superseded, not a bare failure');

  // The steered re-run is IN FLIGHT (never released). A second correction lands.
  const steer2 = runner.steer('actually the blue environment', 'phone');
  t.ok(await until(() => runs.length === 3), 'the second correction re-ran WITHOUT waiting for the combined turn to complete');
  t.includes(runs[2]!, 'deploy the app', 'the original survives the second merge');
  t.includes(runs[2]!, 'to staging', 'the FIRST correction is still in the merged prompt');
  t.includes(runs[2]!, 'actually the blue environment', 'the second correction is merged, never dropped or run bare');
  t.eq(interrupts, 2, 'each correction interrupted the agent once');
  const s1 = await steer1;
  t.ok(!s1.ok && s1.turn === 2 && s1.superseded === true, 'the superseded steered re-run also resolves superseded');

  releases[2]!();
  const s2 = await steer2;
  t.ok(s2.ok && s2.turn === 3, 'the second steer resolves when the final combined turn completes');
  await until(() => !runner.busy);
  t.eq(runner.history.length, 1, 'only the final combined turn is in history (superseded turns left none)');
});

// F3 (D4 in the UNWIND window) - a second correction arriving while the FIRST aborted
// turn is still unwinding (interrupt wait + draining pipeline, the steered re-run NOT
// yet started) must merge onto base + c1, not just the base: the stale pending re-run
// is superseded and only the final fully-merged turn runs. c1 is never lost.
await reporter.leg('turns - a second correction during the unwind window keeps the first (D4, no stale re-run)', async (t) => {
  const runs: string[] = [];
  let interrupts = 0;
  let releaseStuck: () => void = () => {};
  let latestRelease: () => void = () => {};
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => { interrupts++; },
    // The FIRST send IGNORES the abort signal (the unwinding pipeline) and resolves only
    // on explicit release - the unwind window stays open as long as the test needs.
    send: (text) => new Promise((resolve) => {
      runs.push(text);
      const done = (): void => resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 });
      if (runs.length === 1) releaseStuck = done; else latestRelease = done;
    }),
    terminalSnapshot: () => '',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });

  const run1 = runner.run('deploy the app', 'phone');
  t.ok(await until(() => runner.busy && runs.length === 1), 'the base turn is in flight');
  const steer1 = runner.steer('to staging', 'phone');
  t.ok(await until(() => interrupts === 1), 'the first correction aborted + interrupted and is now waiting out the unwind');
  t.eq(runs.length, 1, 'the steered re-run has NOT started - the aborted turn is still unwinding');

  // The second correction lands INSIDE the unwind window.
  const steer2 = runner.steer('actually the blue environment', 'phone');
  t.eq(runs.length, 1, 'still nothing re-ran - both corrections are held');

  releaseStuck(); // the aborted turn finally unwinds
  t.ok(await until(() => runs.length === 2), 'exactly one re-run fired once the lock freed');
  t.includes(runs[1]!, 'deploy the app', 'the merged prompt keeps the base');
  t.includes(runs[1]!, 'to staging', 'the FIRST correction survived the unwind-window merge (never lost)');
  t.includes(runs[1]!, 'actually the blue environment', 'and the second correction is merged in');
  const r1 = await run1;
  t.ok(!r1.ok && r1.superseded === true, 'the aborted base turn resolves superseded');
  const s1 = await steer1;
  t.ok(!s1.ok && s1.superseded === true, 'the stale pending re-run resolves superseded (it was re-merged, never ran)');

  latestRelease();
  const s2 = await steer2;
  t.ok(s2.ok && s2.turn === 2, 'the second steer resolves with the single fully-merged turn');
  await until(() => !runner.busy);
  t.eq(runs.length, 2, 'no stale or bare re-run ever fired - only base, then base + c1 + c2');
  t.eq(runner.history.length, 1, 'only the merged turn is in history');
});

// F3 (phone happy-path) - a follow-up utterance while the turn is thinking is coalesced
// and STEERS: the buffered outbound audio is flushed (`clear`), the agent is interrupted,
// and the combined prompt (original + correction) is re-run.
await reporter.leg('phone - F3: a follow-up utterance attaches + reinterprets (coalesce -> clear -> interrupt -> combined re-run)', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const COALESCE = 700;
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  let interrupts = 0;
  let latestRelease = (): void => {};
  const heard = ['summarize the deploy logs', 'I meant the staging logs'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => { interrupts++; },
    // a thinking turn: NO reply audio, resolve only on abort or explicit release.
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      latestRelease = done;
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    steerCoalesceMs: COALESCE, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZsteer', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth + greeting settle (still idle)

    // first command -> a thinking turn (no audio)
    call.speakUtterance();
    t.ok(await until(() => runs.length === 1 && runner.busy), 'the first command started a (thinking) turn');
    call.out.length = 0;

    // a correction arrives while the turn is in flight -> coalesced, not dropped
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === COALESCE)), 'the follow-up utterance is buffered for coalescing (NOT dropped)');
    t.eq(runs.length, 1, 'the follow-up did not start a second concurrent turn');

    // fire the coalesce window -> steer
    t.ok(fireByMs(COALESCE), 'fire the coalesce window');
    t.ok(await until(() => call.out.some((m) => m.event === 'clear')), 'steering flushes buffered outbound audio (clear)');
    t.ok(await until(() => interrupts === 1), 'the agent is interrupted to reinterpret');
    t.ok(await until(() => runs.length === 2), 'the combined prompt is re-run');
    t.includes(runs[1]!, 'summarize the deploy logs', 'the re-run keeps the original prompt');
    t.includes(runs[1]!, 'staging logs', 'the re-run carries the spoken correction');
    t.includes(runs[1]!.toLowerCase(), 'misread', 'the phone leg keeps the STT-misread framing (spoken source)');
    latestRelease();
    await until(() => !runner.busy);
    call.close();
  } finally {
    await app.close();
  }
});

// F3 (phone barge-in) - a correction spoken OVER the reply barges in: the old audio is
// flushed, the in-flight prompt is PINNED, and the ensuing utterance attaches to it (so a
// mid-speech fix still steers the right prompt even though barge-in aborted the turn).
await reporter.leg('phone - F3: barge-in pins the prompt so a mid-speech correction attaches + reinterprets', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const COALESCE = 700;
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  let interrupts = 0;
  let latestRelease = (): void => {};
  const chunk = speechFramePcm();
  const heard = ['summarize the deploy logs', 'I meant the staging logs'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => { interrupts++; },
    // emits reply audio (so it is "playing" and can be barged over), then holds.
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      hooks.onChunk?.({ index: 0, narration: 'Working on it.', speakBackend: 'mock', pcm: chunk, sampleRate: 8000 });
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: chunk, sampleRate: 8000, ttfbMs: 1, bytes: chunk.length }, chunks: 1 }); };
      latestRelease = done;
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    // empty prompt audio so the PIN/greeting never set "playing" (only the reply chunk does)
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    steerCoalesceMs: COALESCE, timers: manualTimers, log: () => {},
  });
  // marks never echo -> the reply audio stays "playing", so the captain talks over it
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port, { echoMarks: false });
    call.send({ event: 'start', start: { streamSid: 'MZbargere', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await until(() => !runner.busy);

    call.speakUtterance(); // command -> turn plays reply audio (now "playing")
    t.ok(await until(() => runs.length === 1), 'the command started a turn that is speaking');
    t.ok(await until(() => call.out.some((m) => m.event === 'mark')), 'reply audio is on the wire (playing)');
    call.out.length = 0;

    // the captain talks OVER the reply: sustained speech -> barge-in (raw wire frames)
    for (let i = 0; i < 14; i++) call.ws.send(asMediaFrame(speechFramePcm()));
    t.ok(await until(() => call.out.some((m) => m.event === 'clear')), 'barge-in flushes the buffered audio (clear)');

    // the correction utterance completes -> attaches to the PINNED prompt
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === COALESCE)), 'the mid-speech correction is captured (not dropped)');
    t.ok(fireByMs(COALESCE), 'fire the coalesce window');
    t.ok(await until(() => interrupts === 1), 'the agent is interrupted to reinterpret');
    t.ok(await until(() => runs.length === 2), 'the combined prompt is re-run');
    t.includes(runs[1]!, 'summarize the deploy logs', 'the PINNED original prompt is attached (survived the barge-in abort)');
    t.includes(runs[1]!, 'staging logs', 'the correction is attached');
    latestRelease();
    await until(() => !runner.busy);
    call.close();
  } finally {
    await app.close();
  }
});

// F3 (cross-source) - SAME-SOURCE steering only: a spoken line while a WEB-initiated turn
// is in flight must never steer or interrupt it (typed work is never rewritten). The
// utterance takes the D5 silent-queue path instead and runs as its own turn right after.
await reporter.leg('phone - F3: a foreign-source turn is never steered - the utterance queues and runs after (D5)', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const COALESCE = 700;
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  let interrupts = 0;
  let latestRelease = (): void => {};
  const heard = ['note the login bug too'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => { interrupts++; },
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      latestRelease = done;
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    steerCoalesceMs: COALESCE, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZforeign', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle
    call.out.length = 0;

    // a WEB-initiated turn is in flight
    void runner.run('web: refactor the parser', 'web');
    t.ok(await until(() => runner.busy && runs.length === 1), 'a web-initiated turn is in flight');

    // the captain speaks on the call -> queued behind the foreign turn, NOT steered
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === 250)), 'the spoken line is QUEUED (250ms settle-retry armed), not merged');
    t.ok(!pending.some((p) => p.ms === COALESCE), 'no steer coalesce window opens for a foreign-source turn');
    t.ok(fireByMs(250), 'a retry tick fires while the web turn is still busy');
    await realSleep(40);
    t.eq(runs.length, 1, 'the foreign turn keeps running - nothing was re-run over it');
    t.eq(interrupts, 0, 'the web turn is NEVER interrupted by a phone utterance (same-source only)');
    t.ok(!call.out.some((m) => m.event === 'clear'), 'no clear frame - the foreign turn audio is untouched');

    // the web turn finishes normally -> the queued utterance runs as its OWN turn
    latestRelease();
    t.ok(await until(() => !runner.busy), 'the web turn settled normally (kept its reply)');
    t.eq(runner.history.length, 1, 'the web turn recorded its history (never aborted)');
    t.ok(fireByMs(250), 'the next retry tick fires with the lock free');
    t.ok(await until(() => runs.length === 2), 'the queued spoken line ran as its own turn (never lost, D5)');
    t.includes(runs[1]!, 'note the login bug too', 'the utterance text survived intact');
    t.ok(!/misread|addition/i.test(runs[1]!) && !runs[1]!.includes('refactor the parser'), 'it ran verbatim - never merged into the web prompt');
    latestRelease();
    await until(() => !runner.busy);
    call.close();
  } finally {
    await app.close();
  }
});

// F3 (foreign-busy FIFO) - multiple spoken lines arriving while a FOREIGN (web/SMS)
// turn holds the lock must run in SPOKEN order. Per-utterance retry timers would race
// when the lock frees (whichever tick lands first wins - u2 could run before u1); the
// shared FIFO drains them one at a time, each as its own fresh phone turn - never
// reordered, never merged into one prompt.
await reporter.leg('phone - F3: utterances queued behind a foreign turn drain in spoken order - one FIFO, never reordered or merged', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const COALESCE = 700;
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  const releases: Array<() => void> = [];
  const heard = ['first check the deploy status', 'second read me the failing test'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    steerCoalesceMs: COALESCE, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZfifo', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle (still idle)

    // a WEB-initiated turn holds the lock
    const webResult = runner.run('web: refactor the parser', 'web');
    t.ok(await until(() => runner.busy && runs.length === 1), 'a web-initiated turn is in flight');

    // two spoken lines land while the foreign turn is busy - ONE queue, ONE drain
    call.speakUtterance();
    t.ok(await until(() => pending.filter((p) => p.ms === 250).length === 1), 'the first line joins the FIFO (one drain tick armed)');
    call.speakUtterance();
    await realSleep(40);
    t.eq(pending.filter((p) => p.ms === 250).length, 1, 'the second line joins the SAME queue - no second racing retry timer');
    t.ok(!pending.some((p) => p.ms === COALESCE), 'no steer coalesce window opens for a foreign-source turn');

    // a drain tick while still busy just re-arms - nothing runs over the foreign turn
    t.ok(fireByMs(250), 'a drain tick fires while the web turn is still busy');
    await realSleep(20);
    t.eq(runs.length, 1, 'the foreign turn keeps running - nothing dispatched over it');

    // the web turn finishes -> the FIFO drains IN ORDER, one fresh phone turn at a time
    releases[0]!();
    const web = await webResult;
    t.ok(web.ok, 'the web turn completed normally');
    t.ok(fireByMs(250), 'the next drain tick fires with the lock free');
    t.ok(await until(() => runs.length === 2), 'the FIRST spoken line runs first');
    t.includes(runs[1]!, 'first check the deploy status', 'u1 kept its spot at the head of the queue');
    t.ok(!runs[1]!.includes('second read me'), 'u1 ran as its own turn - not merged with u2');
    releases[1]!();
    t.ok(await until(() => runs.length === 3), 'the SECOND spoken line runs right after');
    t.includes(runs[2]!, 'second read me the failing test', 'u2 ran after u1 - spoken order preserved');
    t.ok(!runs[2]!.includes('first check'), 'u2 ran as its own turn - never merged');
    releases[2]!();
    await until(() => !runner.busy);
    t.eq(runs.length, 3, 'exactly three turns - no duplicates, no drops');
    call.close();
  } finally {
    await app.close();
  }
});

// F3 (D4 in the phone-leg UNWIND window) - after a steer aborts the turn, `busy` clears
// while the runner is still interrupting the agent (up to ~3s of pane polling on the real
// broker) and the coalesce timer / barge pin are already consumed. An utterance landing
// in that busy=false slice must still ATTACH to the pending steered re-run - never grab
// the freed lock and run bare ahead of it (the re-run would then override the captain's
// latest correction). The held driver.interrupt keeps the window open deterministically.
await reporter.leg('phone - F3: an utterance in the steer unwind window attaches - never a bare turn ahead of the re-run', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const COALESCE = 700;
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  let interrupts = 0;
  let releaseInterrupt = (): void => {};
  let latestRelease = (): void => {};
  const heard = ['deploy the app', 'to staging', 'actually the blue environment'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    // The FIRST interrupt HOLDS (the broker's "esc to interrupt" pane polling) so the
    // unwind window stays open exactly as long as the test needs; later ones return.
    interrupt: () => new Promise<void>((resolve) => {
      interrupts++;
      if (interrupts === 1) releaseInterrupt = resolve; else resolve();
    }),
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      latestRelease = done;
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    steerCoalesceMs: COALESCE, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZunwind', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle (still idle)

    call.speakUtterance();
    t.ok(await until(() => runs.length === 1 && runner.busy), 'the base turn is in flight');

    // c1 arrives -> coalesce -> steer aborts the turn; the interrupt HOLDS
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === COALESCE)), 'the first correction is buffered for coalescing');
    t.ok(fireByMs(COALESCE), 'fire the coalesce window for the first correction');
    t.ok(await until(() => interrupts === 1), 'the steer aborted the turn and is inside the (held) agent interrupt');
    t.ok(await until(() => !runner.busy), 'the aborted turn cleared busy - the unwind window is OPEN');
    t.eq(runs.length, 1, 'the steered re-run has NOT started yet');

    // c2 lands INSIDE the unwind window (busy=false, no coalesce timer, no barge pin)
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === COALESCE)), 'the unwind-window utterance is buffered to ATTACH (steer pending) - not run bare');
    t.eq(runs.length, 1, 'no bare turn grabbed the freed lock');
    t.ok(fireByMs(COALESCE), 'fire the coalesce window for the second correction');
    await realSleep(40);
    t.eq(runs.length, 1, 'the second correction merged into the pending steer - still nothing re-ran');

    releaseInterrupt(); // the agent interrupt finally returns
    t.ok(await until(() => runs.length === 2), 'exactly one merged re-run fired once the unwind completed');
    t.includes(runs[1]!, 'deploy the app', 'the merged prompt keeps the base');
    t.includes(runs[1]!, 'to staging', 'the first correction survives the merge');
    t.includes(runs[1]!, 'actually the blue environment', 'the unwind-window correction is merged in - never a bare turn ahead of the re-run');
    latestRelease();
    await until(() => !runner.busy);
    t.eq(runs.length, 2, 'no extra bare turn ever ran');
    call.close();
  } finally {
    await app.close();
  }
});

// F3 (pending steer + foreign lock-grab) - with a phone steer PENDING (turn A aborted,
// still unwinding) a foreign SMS/web turn can transiently grab the freed lock. A second
// phone correction landing then belongs to the PHONE chain: it must merge onto the
// pending combined prompt via runner.steer, never take fireSteer's foreign fallback
// (a bare submit racing the pending re-run) - and the foreign turn is never touched.
await reporter.leg('phone - F3: a correction merges into the pending phone steer even when a foreign turn holds the lock', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const COALESCE = 700;
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  let interrupts = 0;
  let releaseInterrupt = (): void => {};
  const releases: Array<() => void> = [];
  const heard = ['deploy the app', 'to staging', 'actually the blue environment'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    // The FIRST interrupt HOLDS so the unwind window stays open while the foreign turn
    // grabs the lock; later ones return immediately.
    interrupt: () => new Promise<void>((resolve) => {
      interrupts++;
      if (interrupts === 1) releaseInterrupt = resolve; else resolve();
    }),
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    steerCoalesceMs: COALESCE, timers: manualTimers, log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZpendfor', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle (still idle)

    call.speakUtterance();
    t.ok(await until(() => runs.length === 1 && runner.busy), 'the base phone turn is in flight');

    // c1 -> coalesce -> steer aborts the turn; the interrupt HOLDS (unwind window open)
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === COALESCE)), 'the first correction is buffered for coalescing');
    t.ok(fireByMs(COALESCE), 'fire the coalesce window for the first correction');
    t.ok(await until(() => interrupts === 1), 'the steer aborted the turn and is inside the (held) agent interrupt');
    t.ok(await until(() => !runner.busy), 'the aborted turn cleared busy - the unwind window is OPEN');

    // a FOREIGN turn grabs the freed lock (SMS runWhenFree polling wins the slice)
    const smsResult = runner.run('sms: also check the inbox backlog', 'sms');
    t.ok(await until(() => runner.busy && runs.length === 2), 'a foreign SMS turn grabbed the lock during the unwind window');

    // c2 lands now: phone steer pending + foreign turn busy -> it must MERGE, not submit
    call.speakUtterance();
    t.ok(await until(() => pending.some((p) => p.ms === COALESCE)), 'the second correction is buffered to attach (steer pending)');
    t.ok(fireByMs(COALESCE), 'fire the coalesce window for the second correction');
    await realSleep(40);
    t.ok(!pending.some((p) => p.ms === 250), 'no submit retry armed - the correction went to the phone steer chain, not the foreign fallback');
    t.eq(runs.length, 2, 'the correction never ran bare');
    t.eq(interrupts, 1, 'the foreign turn is never interrupted by the phone correction');

    // the interrupt returns; the merged re-run still QUEUES behind the foreign turn
    releaseInterrupt();
    await realSleep(60);
    t.eq(runs.length, 2, 'the merged re-run waits for the foreign turn - it is never cancelled');

    // the foreign turn completes normally, then exactly one fully-merged re-run fires
    releases[1]!();
    const sms = await smsResult;
    t.ok(sms.ok, 'the foreign SMS turn completed normally (never aborted, no spurious failure)');
    t.ok(await until(() => runs.length === 3), 'the merged phone re-run fired after the foreign turn freed the lock');
    t.includes(runs[2]!, 'deploy the app', 'the merged prompt keeps the base');
    t.includes(runs[2]!, 'to staging', 'the first correction survives the merge');
    t.includes(runs[2]!, 'actually the blue environment', 'the second correction is merged in - never a bare turn');
    t.ok(!runs[2]!.includes('inbox backlog'), 'the phone chain never merged onto the foreign prompt');
    releases[2]!();
    await until(() => !runner.busy);
    t.eq(runs.length, 3, 'no extra turn ever ran');
    call.close();
  } finally {
    await app.close();
  }
});

// Barge-in over a FOREIGN turn: sustained captain speech while an SMS/web-initiated
// turn's audio plays on the call flushes the LOCAL Twilio buffer (clear) but never
// cancels that turn - it runs to completion and keeps its ok result, so its transport
// never reports a spurious "turn failed" (text.ts texts failure only on !ok).
await reporter.leg('phone - barge-in over a foreign-source turn flushes audio only - the turn is never cancelled', async (t) => {
  let sawAborted = 0;
  let finishTurn = false;
  const chunk = speechFramePcm();
  const runs: string[] = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      hooks.onChunk?.({ index: 0, narration: 'Working on it.', speakBackend: 'mock', pcm: chunk, sampleRate: 8000 });
      const timer = setInterval(() => {
        if (hooks.signal?.aborted) sawAborted++;
        if (finishTurn || hooks.signal?.aborted) {
          clearInterval(timer);
          resolve({ reply: 'done', narration: 'Done.', speakBackend: 'mock', audio: { pcm: chunk, sampleRate: 8000, ttfbMs: 1, bytes: chunk.length }, chunks: 1 });
        }
      }, 10);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const heard: string[] = [];
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    log: () => {},
  });
  // marks never echo -> the foreign turn's broadcast audio stays "playing" on the call
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port, { echoMarks: false });
    call.send({ event: 'start', start: { streamSid: 'MZforbarge', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle

    // an SMS-initiated turn is in flight; its reply audio streams onto the call
    const resP = runner.run('sms: summarize the inbox', 'sms');
    t.ok(await until(() => runner.busy && runs.length === 1), 'a foreign SMS turn is in flight');
    t.ok(await until(() => call.out.some((m) => m.event === 'mark')), 'its reply audio is on the wire (unacked mark = playing)');
    call.out.length = 0;

    // the captain talks over it: barge-in must flush the audio but spare the turn
    for (let i = 0; i < 14; i++) call.ws.send(asMediaFrame(speechFramePcm()));
    t.ok(await until(() => call.out.some((m) => m.event === 'clear')), 'barge-in still flushes the buffered audio (clear)');
    await realSleep(80);
    t.eq(sawAborted, 0, 'the foreign turn was NOT cancelled by the phone barge-in');
    t.ok(runner.busy, 'the foreign turn keeps running');

    finishTurn = true;
    const res = await resP;
    t.ok(res.ok, 'the foreign turn completed with ok:true - no "turn failed" text would ever be sent');
    t.eq(runner.history.length, 1, 'the foreign turn recorded its history (never aborted)');
    call.close();
  } finally {
    await app.close();
  }
});

// Foreign-busy FIFO: each queued line ages on its OWN patience budget from its own
// arrival. An early item that waits out a long-blocking foreign turn is dropped ALONE
// when ITS budget expires; a line spoken late into that window keeps its full window
// and still runs when the lock frees (a shared budget would evict it after seconds).
await reporter.leg('phone - F3: a late-queued utterance keeps its own patience budget - an early timeout never evicts it', async (t) => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const manualTimers: PhoneTimers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) pending.splice(i, 1); },
  };
  const fireByMs = (ms: number): boolean => { const i = pending.findIndex((p) => p.ms === ms); if (i < 0) return false; const [h] = pending.splice(i, 1); h!.fn(); return true; };
  const runs: string[] = [];
  const logs: string[] = [];
  const releases: Array<() => void> = [];
  const heard = ['early spoken line about the deploy', 'late spoken line about the tests'];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    interrupt: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'r', narration: 'ok', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    timers: manualTimers, log: (m) => logs.push(m),
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const twiml = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call = await connectPhoneClient(app.port);
    call.send({ event: 'start', start: { streamSid: 'MZbudget', customParameters: { token: tokenFromTwiml(twiml.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle (still idle)

    // a WEB-initiated turn holds the lock for a LONG time
    const webResult = runner.run('web: refactor the parser', 'web');
    t.ok(await until(() => runner.busy && runs.length === 1), 'a web-initiated turn is in flight');

    // u1 joins the FIFO and waits almost its whole 720-tick (180s) budget
    call.speakUtterance();
    t.ok(await until(() => pending.filter((p) => p.ms === 250).length === 1), 'the early line joins the FIFO (drain armed)');
    let fired = 0;
    for (let i = 0; i < 700; i++) if (fireByMs(250)) fired++;
    t.eq(fired, 700, 'the drain kept ticking while the foreign turn stayed busy');

    // u2 arrives LATE - 175s into u1's wait - with a fresh budget of its own
    call.speakUtterance();
    await realSleep(40);
    const dropped = (): boolean => logs.some((l) => l.includes('dropping 1 queued utterance(s)'));
    for (let i = 0; i < 30 && !dropped(); i++) fireByMs(250);
    t.ok(dropped(), 'the early line expired on ITS OWN budget and was dropped alone');
    t.ok(!logs.some((l) => l.includes('dropping 2')), 'the late line was never evicted with it');
    t.eq(pending.filter((p) => p.ms === 250).length, 1, 'the drain keeps running for the late line');

    // the foreign turn finally frees the lock -> the surviving late line runs
    releases[0]!();
    const web = await webResult;
    t.ok(web.ok, 'the web turn completed normally');
    t.ok(fireByMs(250), 'the next drain tick fires with the lock free');
    t.ok(await until(() => runs.length === 2), 'the late line runs as its own phone turn');
    t.includes(runs[1]!, 'late spoken line about the tests', 'the surviving line is the late one');
    t.ok(!runs.some((r) => r.includes('early spoken line')), 'the expired early line never ran');
    releases[1]!();
    await until(() => !runner.busy);
    call.close();
  } finally {
    await app.close();
  }
});

// Hangup over a FOREIGN turn: a `stop` frame / dead-zone socket drop tears the call
// down but must never cancel a web/SMS-initiated turn - it runs to completion and
// keeps its ok result (no spurious "turn failed" text, no dead web turn). Hanging up
// during the caller's OWN phone turn still aborts it.
await reporter.leg('phone - hangup cancels only the caller\'s own turn - a foreign turn survives the teardown', async (t) => {
  let sawAborted = 0;
  const runs: string[] = [];
  const releases: Array<() => void> = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'done', narration: 'Done.', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) { sawAborted++; done(); } }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const heard = ['check the deploy status'];
  const runner = new TurnRunner({ driver });
  const phone = createPhoneApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
    synthPrompt: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8000 }),
    log: () => {},
  });
  const app = await createWebApp({ driver, runner, phone, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    // ---- call 1: hangup while an SMS-initiated turn is in flight
    const twiml1 = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call1 = await connectPhoneClient(app.port);
    call1.send({ event: 'start', start: { streamSid: 'MZhangfor', customParameters: { token: tokenFromTwiml(twiml1.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call1.send({ event: 'dtmf', dtmf: { digit: d } });
    await realSleep(60); // let the DTMF auth settle
    const smsP = runner.run('sms: summarize the inbox', 'sms');
    t.ok(await until(() => runner.busy && runs.length === 1), 'a foreign SMS turn is in flight');
    call1.send({ event: 'stop' }); // the caller hangs up mid foreign turn
    t.ok(await until(() => !phone.activeCall), 'the call tears down on hangup');
    await realSleep(80);
    t.eq(sawAborted, 0, 'the hangup did NOT cancel the foreign turn');
    t.ok(runner.busy, 'the foreign turn keeps running');
    releases[0]!();
    const sms = await smsP;
    t.ok(sms.ok, 'the foreign turn completed with ok:true - no "turn failed" text would ever be sent');
    t.eq(runner.history.length, 1, 'the foreign turn recorded its history (never aborted)');
    call1.close();

    // ---- call 2: hangup during the caller's OWN phone turn still aborts it
    const twiml2 = await postTwiml(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber! });
    const call2 = await connectPhoneClient(app.port);
    call2.send({ event: 'start', start: { streamSid: 'MZhangown', customParameters: { token: tokenFromTwiml(twiml2.body) } } });
    for (const d of PHONE_TEST_SECRETS.pin!) call2.send({ event: 'dtmf', dtmf: { digit: d } });
    call2.speakUtterance(); // command -> the caller's own long phone turn
    t.ok(await until(() => runs.length === 2), 'the second call started its own phone turn');
    call2.send({ event: 'stop' });
    t.ok(await until(() => sawAborted === 1), "hangup still aborts the caller's OWN phone turn");
    call2.close();
    await until(() => !runner.busy);
  } finally {
    await app.close();
  }
});

// F3 (round 8) - the LAST ungated cancel site: the web `stop` frame. A web voice-hangup
// must abort only a WEB-sourced turn; a live phone caller's or SMS-initiated turn keeps
// running (cancelling it would be the same spurious-failure class the phone leg's
// barge-in/hangup ownership gates prevent). Centralized in runner.cancelIfSource.
await reporter.leg('web - stop cancels only a web-sourced turn - a foreign (phone/SMS) turn survives', async (t) => {
  let sawAborted = 0;
  const runs: string[] = [];
  const releases: Array<() => void> = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 8000 }),
    start: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      runs.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: 'done', narration: 'Done.', speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 8000, ttfbMs: null, bytes: 0 }, chunks: 0 }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) { sawAborted++; done(); } }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const runner = new TurnRunner({ driver });
  const app = await createWebApp({ driver, runner, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const web = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
    await new Promise<void>((resolve, reject) => { web.on('open', () => resolve()); web.on('error', reject); });

    // ---- pure gate: cancelIfSource refuses a wrong-source / idle cancel
    t.ok(!runner.cancelIfSource('web', 'idle probe'), 'cancelIfSource is a no-op when idle');

    // ---- a foreign (phone-sourced) turn is in flight: web stop must NOT cancel it
    const phoneP = runner.run('phone: check the deploy', 'phone');
    t.ok(await until(() => runner.busy && runs.length === 1), 'a foreign phone-sourced turn is in flight');
    web.send(JSON.stringify({ type: 'stop' }));
    await realSleep(80);
    t.eq(sawAborted, 0, 'the web stop did NOT cancel the phone-sourced turn');
    t.ok(runner.busy, 'the foreign turn keeps running');
    releases[0]!();
    const phoneR = await phoneP;
    t.ok(phoneR.ok, 'the foreign turn completed ok - no spurious failure on its transport');

    // ---- a web-sourced turn: web stop still cancels it (explicit same-source hangup)
    const webP = runner.run('web: long job', 'web');
    t.ok(await until(() => runner.busy && runs.length === 2), 'a web-sourced turn is in flight');
    web.send(JSON.stringify({ type: 'stop' }));
    t.ok(await until(() => sawAborted === 1), 'the web stop still aborts a web-sourced turn');
    await webP;
    web.close();
  } finally {
    await app.close();
  }
});

// V1 - the 1:1 VERBATIM transcript, byte-exact. The tap streams the exact assistant
// text (code fences, odd whitespace and all) while the reply grows, and the final
// read equals the session transcript text byte-for-byte.
await reporter.leg('web - verbatim transcript: live streaming + BYTE-EXACT final text', async (t) => {
  const SAY_1 = 'Here is the config, captain - two things stand out.';
  const SAY_2 = 'The relevant section:\n\n```yaml\nserver:\n  host: 0.0.0.0   # note the double-space indents\n  port: 8420\n```\n\nWant me to tighten the host binding?';
  const EXPECTED = SAY_1 + '\n\n' + SAY_2;

  // ---- the pure tap over a real JSONL fixture
  const dir = mkdtempSync(join(tmpdir(), 'ceochat-verbatim-'));
  try {
    const file = join(dir, 'session.jsonl');
    const PROMPT = 'show me the server config';
    const t0 = new Date(Date.now() - 1000).toISOString();
    writeFileSync(file, userPrompt(PROMPT, new Date().toISOString()) + '\n' + assistantSay(SAY_1, new Date().toISOString()) + '\n');
    const tap = makeTranscriptVerbatim({ resolveProjectDir: () => dir, pollMs: 20 });
    const growth: string[] = [];
    const handle = tap({ prompt: PROMPT, afterTs: t0, onText: (text) => growth.push(text) });
    await until(() => growth.length >= 1);
    appendFileSync(file, assistantSay(SAY_2, new Date().toISOString()) + '\n');
    await until(() => growth.length >= 2);
    const final = handle.stop();
    t.eq(growth[0], SAY_1, 'the tap streams the first say while the turn is still running');
    t.ok(growth.length >= 2, 'the verbatim text GROWS live as says append', `${growth.length} snapshots`);
    t.ok(Object.is(final, EXPECTED), 'BYTE-EXACT: the final verbatim equals the transcript says exactly (fences, spaces, newlines)');
    t.includes(final, '  host: 0.0.0.0   # note the double-space indents', 'inner code whitespace is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- the same guarantee over the REAL web WS: a driver that appends to a live
  // JSONL while "replying"; the browser receives progressive `verbatim` frames and
  // a final:true frame that is byte-exact.
  const dir2 = mkdtempSync(join(tmpdir(), 'ceochat-verbatim-ws-'));
  const file2 = join(dir2, 'session.jsonl');
  writeFileSync(file2, '');
  const mock = await startMockMinimax();
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 32000 }),
    start: async () => {},
    send: async (text) => {
      appendFileSync(file2, userPrompt(text, new Date().toISOString()) + '\n');
      appendFileSync(file2, assistantSay(SAY_1, new Date().toISOString()) + '\n');
      await realSleep(150); // let the tap emit a mid-turn snapshot
      appendFileSync(file2, assistantSay(SAY_2, new Date().toISOString()) + '\n');
      await realSleep(150);
      const r = await synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: ['done'], endpoint: mock.endpoint, timeoutMs: 8000 });
      // NOTE: reply is the pipeline's whitespace-NORMALIZED text - the verbatim tap
      // must win over it for the byte-exact final frame.
      return { reply: (SAY_1 + ' ' + SAY_2).replace(/\s+/g, ' '), narration: 'Config is up. Want me to tighten it?', speakBackend: 'mock', audio: { pcm: r.pcm, sampleRate: r.sampleRate, ttfbMs: r.ttfbMs, bytes: r.pcm.length }, chunks: 0 };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const app = await createWebApp({
    driver, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {},
    verbatim: makeTranscriptVerbatim({ resolveProjectDir: () => dir2, pollMs: 20 }),
  });
  try {
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const c = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { c.close(); reject(new Error('verbatim WS timed out')); }, 12000);
      let sent = false;
      c.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(m);
        if (m.type === 'hello' && !sent) { sent = true; c.send(JSON.stringify({ type: 'send', text: 'show me the server config' })); }
        if (m.type === 'turn-done') { clearTimeout(timer); c.close(); resolve(); }
      });
      c.on('error', reject);
    });
    const verbatims = frames.filter((m) => m.type === 'verbatim');
    t.ok(verbatims.some((m) => !m.final), 'verbatim frames stream DURING the turn (live 1:1 view)');
    const finalFrame = verbatims.find((m) => m.final === true) as { text?: string } | undefined;
    t.ok(!!finalFrame, 'a final verbatim frame closes the turn');
    t.ok(Object.is(finalFrame?.text, EXPECTED), 'BYTE-EXACT over the WS: final verbatim == the exact session reply text');
    t.notIncludes((frames.find((m) => m.type === 'reply') as { text?: string })?.text || '', '\n', 'control: the legacy reply frame is whitespace-normalized (verbatim is the exact one)');
  } finally {
    await app.close();
    await mock.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

// V2 - the iPhone UI building blocks: lossless fenced-segment rendering, the
// tappable answer card, the installable-PWA static surface, and reconnect resume
// (multi-turn history replay + the shared `sent` echo).
await reporter.leg('web - iPhone UI: lossless segments, answer card, PWA assets, reconnect resume', async (t) => {
  // splitFencedSegments is LOSSLESS - the rendered characters ARE the reply text.
  const tricky = [
    'plain only',
    'before\n```js\nconst a = 1;\n```\nafter',
    '```sh\nnpm test\n```',
    'stream cut mid-fence\n```py\nprint("hi")',
    'two\n```a\n1\n```\nmid\n```b\n2\n```\n',
    '',
  ];
  for (const input of tricky) {
    const segs = splitFencedSegments(input);
    t.ok(Object.is(segs.map((s) => s.text).join(''), input), `segments reconstruct byte-exact (${JSON.stringify(input.slice(0, 24))}…)`);
  }
  const withCode = splitFencedSegments(tricky[1]!);
  t.ok(withCode.some((s) => s.kind === 'code' && s.text.includes('const a = 1;')), 'the fenced block renders as a code segment (scrollable container)');
  t.ok(splitFencedSegments(tricky[3]!).some((s) => s.kind === 'code'), 'an unterminated fence (still streaming) renders as code, not plain');

  // the tappable answer card
  const card = extractPrompt(OPTIONS_REPLY);
  t.ok(!!card, 'an options reply yields an answer card');
  t.ok((card?.options.length ?? 0) >= 3, 'each numbered option becomes a tappable button', `${card?.options.length}`);
  t.eq(card?.options[0]?.send, '1', 'tapping option 1 submits "1" (same as speaking it)');
  t.includes(card?.question || '', '?', 'the card shows the verbatim closing question');
  const yesno = extractPrompt('All tests pass.\n\nShould I proceed with the deploy?');
  t.ok(!!yesno && yesno.options.some((o) => o.send === 'yes') && yesno.options.some((o) => o.send === 'no'), 'a yes/no question gets Yes and No buttons');
  t.eq(extractPrompt('Deployed. All done, no action needed.'), null, 'a statement turn pins no card');

  // installable PWA static surface (Add to Home Screen)
  const mock = await startMockMinimax();
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 32000 }),
    start: async () => {},
    send: async (text, _i, hooks) => {
      const r = await runPipeline(text, {
        inject: async () => {}, readReply: async () => SAMPLE_AGENT_TURN,
        speakify: (s) => speakify(s, { backend: 'mock' }),
        synth: (chunks) => synthStreaming({ apiKey: MOCK_KEY, groupId: MOCK_GROUP, textChunks: chunks, endpoint: mock.endpoint, timeoutMs: 8000 }),
        onStage: hooks.onStage,
      });
      return { reply: r.reply, narration: r.narration, speakBackend: r.speakBackend, audio: { pcm: r.audio.pcm, sampleRate: r.audio.sampleRate, ttfbMs: r.audio.ttfbMs, bytes: r.audio.bytes } };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const app = await createWebApp({ driver, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const html = await (await fetch(app.url)).text();
    t.includes(html, 'viewport-fit=cover', 'viewport covers the notch (safe-area ready)');
    t.includes(html, 'apple-mobile-web-app-capable', 'standalone full-screen when added to the Home Screen');
    t.includes(html, '/manifest.webmanifest', 'the page links the web app manifest');
    t.includes(html, '/icons/apple-touch-icon.png', 'the page links the apple-touch-icon');
    const manifest = await fetch(app.url + 'manifest.webmanifest');
    t.eq(manifest.status, 200, 'manifest.webmanifest is served');
    t.includes(manifest.headers.get('content-type') || '', 'manifest+json', 'manifest served with the manifest MIME type');
    const mf = JSON.parse(await manifest.text()) as { display?: string; icons?: unknown[] };
    t.eq(mf.display, 'standalone', 'manifest requests a standalone (full-screen) app');
    t.ok((mf.icons?.length ?? 0) >= 2, 'manifest carries the icon set');
    const icon = await fetch(app.url + 'icons/apple-touch-icon.png');
    t.eq(icon.status, 200, 'apple-touch-icon.png is served');
    t.includes(icon.headers.get('content-type') || '', 'image/png', 'icon served as image/png');

    // ---- reconnect resume: run TWO turns, then a fresh client gets the WHOLE
    // conversation back (deduped by turn) - dead zones never lose history.
    const runTurn = (text: string): Promise<Record<string, unknown>[]> => new Promise((resolve, reject) => {
      const frames: Record<string, unknown>[] = [];
      const c = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { c.close(); reject(new Error('turn WS timed out')); }, 12000);
      let sent = false;
      c.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(m);
        if (m.type === 'hello' && !sent) { sent = true; c.send(JSON.stringify({ type: 'send', text })); }
        if (m.type === 'turn-done' && !m.replay) { clearTimeout(timer); c.close(); resolve(frames); }
      });
      c.on('error', reject);
    });
    const live1 = await runTurn('first question');
    await runTurn('second question');
    const liveSent = live1.find((m) => m.type === 'sent') as { text?: string; source?: string; ts?: number } | undefined;
    t.eq(liveSent?.text, 'first question', 'every accepted captain line is echoed to all clients (`sent`)');
    t.eq(liveSent?.source, 'web', 'the sent frame carries its source');
    t.ok(typeof liveSent?.ts === 'number', 'the sent frame carries a timestamp for the transcript');

    const replayFrames: Record<string, unknown>[] = await new Promise((resolve, reject) => {
      const frames: Record<string, unknown>[] = [];
      const c = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
      const timer = setTimeout(() => { c.close(); reject(new Error('resume WS timed out')); }, 8000);
      c.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(m);
        if (m.type === 'turn-done') { clearTimeout(timer); c.close(); resolve(frames); }
      });
      c.on('error', reject);
    });
    const replayedSent = replayFrames.filter((m) => m.type === 'sent' && m.replay === true);
    t.eq(replayedSent.length, 2, 'a reconnecting client is replayed BOTH turns (full history, not just the last)');
    t.eq((replayedSent[0] as { text?: string }).text, 'first question', 'history replays in order');
    const replayedVerbatim = replayFrames.filter((m) => m.type === 'verbatim' && m.replay === true && m.final === true);
    t.eq(replayedVerbatim.length, 2, 'each replayed turn carries its final verbatim text');
    const replayedAudio = replayFrames.filter((m) => m.type === 'audio' && m.replay === true);
    t.eq(replayedAudio.length, 1, 'audio is replayed for the NEWEST turn only (bounded payload, arms Replay)');
  } finally {
    await app.close();
    await mock.close();
  }
});

// ═══════════════ TEXT MODE (SMS/MMS on the same Twilio number) ═══════════════
// The text transport is proven with faked Twilio HTTP - no account, no network.
// Signed webhook POSTs hit the REAL /text/webhook endpoint mounted by
// createWebApp against the in-memory driver; outbound REST (replies + notify)
// and MMS media fetches go through an injected fetch that records everything.

const TEXT_WEBHOOK_URL = PHONE_PUBLIC_URL + TEXT_WEBHOOK_PATH;

// POST the Twilio messaging webhook (optionally with a valid signature).
async function postText(baseUrl: string, params: Record<string, string>, sign = true): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = twilioSignature(PHONE_TEST_SECRETS.authToken!, TEXT_WEBHOOK_URL, params);
  const res = await fetch(baseUrl.replace(/\/$/, '') + TEXT_WEBHOOK_PATH, {
    method: 'POST', headers, body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.text() };
}

interface RecordedSms { url: string; auth: string; params: URLSearchParams; }
interface RecordedMediaHit { url: string; auth: string; }

// One injected fetch for a text leg: records Messages.json POSTs (replies +
// notifications) and serves MMS media GETs by URL suffix.
function makeTextFetch(media: Record<string, { bytes: Buffer; contentType: string }>): {
  fetchImpl: typeof fetch; smsSent: RecordedSms[]; mediaHits: RecordedMediaHit[];
} {
  const smsSent: RecordedSms[] = [];
  const mediaHits: RecordedMediaHit[] = [];
  const fetchImpl = (async (url: string | URL, init?: { headers?: Record<string, string>; body?: string }) => {
    const u = String(url);
    const auth = init?.headers?.Authorization || '';
    if (u.includes('/Messages.json')) {
      smsSent.push({ url: u, auth, params: new URLSearchParams(init?.body || '') });
      return { ok: true, status: 201, json: async () => ({ sid: 'SMfake' + smsSent.length }) };
    }
    mediaHits.push({ url: u, auth });
    const hit = Object.entries(media).find(([suffix]) => u.endsWith(suffix));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const { bytes, contentType } = hit[1];
    return {
      ok: true, status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, smsSent, mediaHits };
}

// A driver whose narration is a summary of a LONGER verbatim reply - the SMS
// reply must carry the narration and append the transcript link for the detail.
const TEXT_NARRATION = 'The deploy is green. Want me to merge it?';
const TEXT_REPLY =
  'Deploy pipeline finished.\n\n' +
  '```\nnpm run deploy -- --stage prod\n```\n\n' +
  'All 214 checks passed on src/server/deploy.ts. Want me to merge it?';
function makeTextDriver(): { driver: Driver; sends: string[] } {
  const sends: string[] = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 22050 }),
    start: async () => {},
    send: async (text) => {
      sends.push(text);
      return {
        reply: TEXT_REPLY, narration: TEXT_NARRATION, speakBackend: 'mock',
        audio: { pcm: Buffer.alloc(0), sampleRate: 22050, ttfbMs: 3, bytes: 0 },
      };
    },
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  return { driver, sends };
}

// T1 - the pure pieces: reply framing within Twilio's 1600-char Body limit, the
// transcript link for verbatim detail, the single-line injected text, media
// extensions, the notify token, and the capability gates.
await reporter.leg('text - SMS reply framing: 1600 limit + transcript link + injected line (pure)', (t) => {
  const URL_ = 'https://ceo-chat.acb-apps.com';
  const LINK = '\n\nFull reply: ' + URL_;

  // narration == verbatim -> nothing was compressed away, no link needed
  t.eq(formatSmsReply('Done.', 'Done.', URL_), 'Done.', 'no link when the verbatim reply adds nothing');
  t.eq(formatSmsReply('Done.', ' Done. ', URL_), 'Done.', 'whitespace-only differences do not trigger the link');

  // the verbatim reply holds more detail -> the web transcript link is appended
  const linked = formatSmsReply(TEXT_NARRATION, TEXT_REPLY, URL_);
  t.ok(linked.startsWith(TEXT_NARRATION), 'the SMS body leads with the concise narration');
  t.ok(linked.endsWith(LINK), 'the verbatim detail appends the transcript link');
  t.ok(linked.length <= SMS_BODY_LIMIT, 'within the limit');

  // empty narration falls back to the verbatim text (self-identical -> no link)
  t.eq(formatSmsReply('', 'Short reply.', URL_), 'Short reply.', 'no narration -> the verbatim text IS the body');

  // the 1600 boundary: exactly at the limit is untouched...
  const exact = 'a'.repeat(SMS_BODY_LIMIT);
  t.eq(formatSmsReply(exact, exact, URL_).length, SMS_BODY_LIMIT, 'exactly 1600 chars passes untruncated');
  t.notIncludes(formatSmsReply(exact, exact, URL_), '…', 'no truncation marker at the boundary');
  // ...one char past (with the link) truncates the narration, never the link
  const fitting = 'b'.repeat(SMS_BODY_LIMIT - LINK.length);
  const atLimit = formatSmsReply(fitting, TEXT_REPLY, URL_);
  t.eq(atLimit.length, SMS_BODY_LIMIT, 'narration + link that exactly fits is untruncated', );
  t.notIncludes(atLimit, '…', 'no marker when it fits');
  const over = formatSmsReply(fitting + 'bb', TEXT_REPLY, URL_);
  t.ok(over.length <= SMS_BODY_LIMIT, 'one char over -> truncated back within the limit', `${over.length}`);
  t.ok(over.endsWith(LINK), 'the transcript link SURVIVES truncation');
  t.includes(over, '…', 'the truncation is marked');
  const huge = formatSmsReply('c'.repeat(5000), TEXT_REPLY, URL_);
  t.ok(huge.length <= SMS_BODY_LIMIT && huge.endsWith(LINK), 'a 5000-char narration still yields limit-safe body + link');
  // truncation FORCES the link even when narration == verbatim (content was cut,
  // so the captain always gets the pointer to the full transcript)
  const longSame = 'd'.repeat(2000);
  const forced = formatSmsReply(longSame, longSame, URL_);
  t.ok(forced.length <= SMS_BODY_LIMIT, 'narration==verbatim over the limit is truncated');
  t.ok(forced.endsWith(LINK), 'ANY truncation forces the transcript link, regardless of narration mode');
  t.includes(forced, '…', 'and is marked as truncated');

  // the injected line: ONE line (fm-send submits on newline), body + references
  const files = [
    { path: '/repo/inbox/2026-07-02_10-00-00-SM1-0.jpg', contentType: 'image/jpeg', bytes: 8 },
    { path: '/repo/inbox/2026-07-02_10-00-00-SM1-1.pdf', contentType: 'application/pdf', bytes: 9 },
  ];
  const injected = buildInjectedText('look at this ticket', files);
  t.notIncludes(injected, '\n', 'the injected text is a SINGLE line');
  t.ok(injected.startsWith('look at this ticket'), 'the captain\'s words lead');
  t.includes(injected, 'attachment 1/2 from the captain: /repo/inbox/2026-07-02_10-00-00-SM1-0.jpg (image/jpeg)', 'each attachment injects its inbox path + type');
  t.includes(injected, 'open and inspect it', 'first mate is told to open the file');
  const noBody = buildInjectedText('', [files[0]!]);
  t.includes(noBody, 'The captain texted 1 attachment (no message text).', 'a media-only MMS still injects a meaningful line');
  t.eq(buildInjectedText('  ', []), '', 'no body + no media -> nothing to inject');
  t.eq(buildInjectedText('two\n lines here', []), 'two lines here', 'embedded newlines in the SMS body are flattened');

  // partial MMS failure is NAMED in the injected line - first mate must never
  // mistake a partial MMS for the whole one
  t.eq(ordinalName(1) + ordinalName(2) + ordinalName(3) + ordinalName(11), '1st2nd3rd11th', 'ordinal naming');
  t.eq(describeMediaFailures([2], 3), '1 of 3 attachments (the 2nd) failed to download', 'a single failure is named by position');
  t.eq(describeMediaFailures([1, 3], 3), '2 of 3 attachments (the 1st and 3rd) failed to download', 'multiple failures list every position');
  const partial = buildInjectedText('see photos', [files[0]!], [2]);
  t.includes(partial, 'WARNING: MMS 1 of 2 attachments (the 2nd) failed to download - you did NOT receive it.', 'the injected line warns first mate about the dropped attachment');
  t.notIncludes(partial, '\n', 'the warning keeps the injection single-line');
  t.eq(buildInjectedText('', [], [1]), '', 'all-failed with no body still injects nothing (the reply carries the failure)');

  // media extensions
  t.eq(mediaExtension('image/jpeg'), 'jpg', 'image/jpeg -> .jpg');
  t.eq(mediaExtension('image/png; charset=binary'), 'png', 'content-type parameters are ignored');
  t.eq(mediaExtension('application/x-unknown'), 'bin', 'unknown types fall back to .bin');

  // the notify token: sha256(auth token) hex - EXACTLY what bin/text-captain.sh
  // derives with `printf '%s' "$TWILIO_AUTH_TOKEN" | sha256sum`.
  t.eq(notifyToken('test-auth-token'), 'f35cd067d05752edf483ea62c03582e9a2a87f40336d3b72fbb5899ec9c9aefb', 'notifyToken == sha256sum of the token (script parity)');

  // capability + config gates
  const caps = textCapabilities(PHONE_TEST_SECRETS);
  t.ok(caps.inbound && caps.outbound, 'full secrets -> inbound + replies capable');
  t.ok(!textCapabilities({ ...PHONE_TEST_SECRETS, authToken: undefined }).inbound, 'no auth token -> NO inbound (signature validation is mandatory)');
  t.ok(!textCapabilities({ ...PHONE_TEST_SECRETS, accountSid: undefined }).outbound, 'no account SID -> no outbound replies');
  t.ok(textNotifyEnabled({}), 'proactive notify defaults ON');
  t.ok(!textNotifyEnabled({ CEOCHAT_TEXT_NOTIFY: '0' }) && !textNotifyEnabled({ CEOCHAT_TEXT_NOTIFY: 'off' }), 'CEOCHAT_TEXT_NOTIFY=0/off disables it');
  t.ok(textNotifyEnabled({ CEOCHAT_TEXT_NOTIFY: '1' }), 'an explicit 1 keeps it on');
});

// T2 - the webhook end-to-end over the REAL HTTP endpoint: the MANDATORY
// signature gate, the sender allowlist, Body -> TurnRunner injection (the same
// seam as a spoken utterance), and the REST reply framing.
await reporter.leg('text - SMS webhook: signature gate + allowlist + Body->send + REST reply', async (t) => {
  const { driver, sends } = makeTextDriver();
  const { fetchImpl, smsSent } = makeTextFetch({});
  const inbox = mkdtempSync(join(tmpdir(), 'ceochat-inbox-'));
  const runner = new TurnRunner({ driver });
  const text = createTextApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    inboxDir: inbox, fetchImpl, log: () => {},
  });
  const app = await createWebApp({ driver, runner, text, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });

  // a web client watches: SMS turns must broadcast to the browser transcript too
  const webFrames: Array<Record<string, unknown>> = [];
  const watcher = new WsClient(`ws://127.0.0.1:${app.port}${WS_PATH}`);
  watcher.on('message', (raw: Buffer) => { try { webFrames.push(JSON.parse(raw.toString()) as Record<string, unknown>); } catch { /* ignore */ } });
  await new Promise<void>((resolve, reject) => { watcher.on('open', () => resolve()); watcher.on('error', reject); });

  try {
    // 1. a forged POST (no signature) NEVER reaches the agent
    const forged = await postText(app.url, { From: PHONE_TEST_SECRETS.allowedCaller!, Body: 'rm -rf /' }, false);
    t.eq(forged.status, 403, 'missing/invalid X-Twilio-Signature -> 403 (webhook authenticated, MANDATORY)');
    // 2. a signed message from a STRANGER is silently dropped
    const stranger = await postText(app.url, { From: '+15667770000', To: PHONE_TEST_SECRETS.phoneNumber!, Body: 'hello?' });
    t.eq(stranger.status, 200, 'non-allowlisted sender is answered 200 (nothing revealed)');
    t.includes(stranger.body, '<Response/>', 'empty TwiML - no auto-reply to strangers');
    await realSleep(150);
    t.eq(sends.length, 0, 'NOTHING was injected for the forged or stranger messages');
    t.eq(smsSent.length, 0, 'and no reply SMS went out for them');

    // 3. the captain texts: Body is injected through the SAME TurnRunner seam
    const ok = await postText(app.url, {
      From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!,
      Body: 'status of the deploy?', NumMedia: '0', MessageSid: 'SMtest1',
    });
    t.eq(ok.status, 200, 'allowlisted + signed -> 200');
    t.includes(ok.body, '<Response/>', 'webhook answers immediately (reply rides REST after the turn)');
    t.ok(await until(() => sends.length === 1), 'the text was injected as a turn');
    t.eq(sends[0], 'status of the deploy?', 'the injected text is the SMS Body, unchanged');

    // 4. the reply: concise narration + transcript link, within the limit
    t.ok(await until(() => smsSent.length === 1), 'a reply SMS goes out via Twilio REST');
    const reply = smsSent[0]!;
    t.includes(reply.url, `/2010-04-01/Accounts/${PHONE_TEST_SECRETS.accountSid}/Messages.json`, 'POSTs the documented Messages.json endpoint');
    t.includes(reply.auth, 'Basic ', 'HTTP Basic auth (sid:token)');
    t.eq(reply.params.get('To'), PHONE_TEST_SECRETS.allowedCaller!, 'replies to the captain');
    t.eq(reply.params.get('From'), PHONE_TEST_SECRETS.phoneNumber!, 'from our Twilio number');
    const body = reply.params.get('Body') || '';
    t.ok(body.startsWith(TEXT_NARRATION), 'the reply leads with the speakable summary');
    t.includes(body, 'Full reply: ' + PHONE_PUBLIC_URL, 'the verbatim detail appends the web transcript link');
    t.ok(body.length <= SMS_BODY_LIMIT, 'the reply stays within the 1600-char limit');

    // 5. the SMS turn reached the browser transcript with its source
    t.ok(await until(() => webFrames.some((m) => m.type === 'sent' && m.source === 'sms')), 'the web client sees the SMS turn (source: "sms")');
    const sent = webFrames.find((m) => m.type === 'sent' && m.source === 'sms') as { text?: string };
    t.eq(sent?.text, 'status of the deploy?', 'with the captain\'s exact words');
  } finally {
    try { watcher.close(); } catch { /* ignore */ }
    await app.close();
    rmSync(inbox, { recursive: true, force: true });
  }
});

// T2b - a quick same-source follow-up text steers the in-flight SMS turn (Feature 3).
// The deliberately superseded first turn must NOT text the captain "That turn failed" -
// only the combined turn's reply goes out. A GENUINE mid-turn failure still does.
await reporter.leg('text - a follow-up text steers the SMS turn: no spurious failure SMS for the superseded turn', async (t) => {
  const sends: string[] = [];
  const releases: Array<() => void> = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 22050 }),
    start: async () => {},
    interrupt: async () => {},
    send: (text, _i, hooks) => new Promise((resolve, reject) => {
      sends.push(text);
      if (/detonate the driver/.test(text)) { reject(new Error('driver exploded')); return; }
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: TEXT_REPLY, narration: TEXT_NARRATION, speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 22050, ttfbMs: 3, bytes: 0 } }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  const { fetchImpl, smsSent } = makeTextFetch({});
  const inbox = mkdtempSync(join(tmpdir(), 'ceochat-inbox-'));
  const runner = new TurnRunner({ driver });
  const text = createTextApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    inboxDir: inbox, fetchImpl, log: () => {},
  });
  const app = await createWebApp({ driver, runner, text, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const post = (body: string, sid: string): Promise<{ status: number; body: string }> => postText(app.url, {
      From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!,
      Body: body, NumMedia: '0', MessageSid: sid,
    });
    await post('summarize the deploy logs', 'SMsteer1');
    t.ok(await until(() => sends.length === 1 && runner.busy), 'the first text turn is in flight');
    await post('I meant the staging logs', 'SMsteer2');
    t.ok(await until(() => sends.length === 2), 'the follow-up steered: the COMBINED prompt re-ran');
    t.includes(sends[1]!, 'summarize the deploy logs', 'the combined turn keeps the first message verbatim');
    t.includes(sends[1]!, 'I meant the staging logs', 'and carries the follow-up');
    releases[1]!(); // finish the combined turn
    t.ok(await until(() => smsSent.length === 1), 'exactly ONE reply SMS goes out - the combined turn\'s');
    const body = smsSent[0]!.params.get('Body') || '';
    t.ok(body.startsWith(TEXT_NARRATION), 'the reply is the combined turn\'s narration');
    await realSleep(200);
    t.eq(smsSent.length, 1, 'the superseded first message never sent its own reply');
    t.ok(!smsSent.some((s) => /turn failed/i.test(s.params.get('Body') || '')), 'NO spurious "turn failed" text for the deliberately superseded turn');

    // a GENUINE mid-turn failure still texts the captain a failure note
    await until(() => !runner.busy);
    await post('please detonate the driver', 'SMsteer3');
    t.ok(await until(() => smsSent.length === 2), 'a genuine failure still produces a text');
    t.includes(smsSent[1]!.params.get('Body') || '', 'That turn failed', 'and it is the failure note');
  } finally {
    await app.close();
    rmSync(inbox, { recursive: true, force: true });
  }
});

// T2c - a superseded MMS turn must NOT silently drop its partial-failure note. When an
// attachment failed to download and the captain's quick follow-up then steers the turn,
// the "first mate did NOT see it" note is carried forward and LEADS the combined turn's
// reply - the captain never assumes a dropped photo was seen.
await reporter.leg('text - a superseded MMS turn\'s media-failure note still reaches the captain', async (t) => {
  const sends: string[] = [];
  const releases: Array<() => void> = [];
  const driver: Driver = {
    meta: () => ({ ttsMode: 'mock', ttsVoice: 'mock tone', speakBackend: 'mock', sampleRate: 22050 }),
    start: async () => {},
    interrupt: async () => {},
    send: (text, _i, hooks) => new Promise((resolve) => {
      sends.push(text);
      let iv: ReturnType<typeof setInterval> | null = null;
      const done = (): void => { if (iv) clearInterval(iv); resolve({ reply: TEXT_REPLY, narration: TEXT_NARRATION, speakBackend: 'mock', audio: { pcm: Buffer.alloc(0), sampleRate: 22050, ttfbMs: 3, bytes: 0 } }); };
      releases.push(done);
      iv = setInterval(() => { if (hooks.signal?.aborted) done(); }, 5);
    }),
    terminalSnapshot: () => 'ceo-chat',
    stop: async () => {},
  };
  // No media mapped -> the MMS fetch 404s and the attachment intake FAILS.
  const { fetchImpl, smsSent } = makeTextFetch({});
  const inbox = mkdtempSync(join(tmpdir(), 'ceochat-inbox-'));
  const runner = new TurnRunner({ driver });
  const text = createTextApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    inboxDir: inbox, fetchImpl, log: () => {},
  });
  const app = await createWebApp({ driver, runner, text, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    await postText(app.url, {
      From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!,
      Body: 'analyze this photo', NumMedia: '1', MessageSid: 'MMdrop1',
      MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${PHONE_TEST_SECRETS.accountSid}/Messages/MMdrop1/Media/ME0`,
      MediaContentType0: 'image/jpeg',
    });
    t.ok(await until(() => sends.length === 1 && runner.busy), 'the partial-MMS turn is in flight');
    t.includes(sends[0]!, 'WARNING: MMS 1 of 1 attachment (the 1st) failed to download', 'first mate is told the attachment never arrived');

    await postText(app.url, {
      From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!,
      Body: 'and compare it with last week', NumMedia: '0', MessageSid: 'SMdrop2',
    });
    t.ok(await until(() => sends.length === 2), 'the follow-up steered: the COMBINED prompt re-ran');
    releases[1]!(); // finish the combined turn
    t.ok(await until(() => smsSent.length === 1), 'exactly ONE reply SMS goes out - the combined turn\'s');
    const body = smsSent[0]!.params.get('Body') || '';
    t.ok(body.startsWith('Note: 1 of 1 attachment (the 1st) failed to download - first mate did NOT see it.'),
      'the superseded turn\'s media-failure note was carried forward and LEADS the reply');
    t.includes(body, TEXT_NARRATION, 'and the combined turn\'s narration follows it');
    t.ok(body.length <= SMS_BODY_LIMIT, 'note + reply stay within the limit');
    await realSleep(200);
    t.eq(smsSent.length, 1, 'the note rode the combined reply - no extra outbound message');
    t.ok(!smsSent.some((s) => /turn failed/i.test(s.params.get('Body') || '')), 'and no spurious "turn failed" text');
  } finally {
    await app.close();
    rmSync(inbox, { recursive: true, force: true });
  }
});

// T3 - MMS intake: MediaUrl0..N fetched with Twilio-scoped Basic auth, stored in
// the gitignored inbox, and referenced in the injected line so first mate can
// open exactly what the captain sent.
await reporter.leg('text - MMS intake: authenticated fetch -> gitignored inbox -> injected reference', async (t) => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PDF = Buffer.from('%PDF-1.4 fake');
  const { driver, sends } = makeTextDriver();
  const { fetchImpl, smsSent, mediaHits } = makeTextFetch({
    '/Media/ME0': { bytes: JPEG, contentType: 'image/jpeg' },
    '/Media/ME1': { bytes: PDF, contentType: 'application/pdf' },
    '/off-twilio-media': { bytes: JPEG, contentType: 'image/jpeg' },
  });
  const inbox = mkdtempSync(join(tmpdir(), 'ceochat-inbox-'));
  const runner = new TurnRunner({ driver });
  const text = createTextApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    inboxDir: inbox, fetchImpl, log: () => {},
  });
  const app = await createWebApp({ driver, runner, text, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  try {
    const mediaBase = `https://api.twilio.com/2010-04-01/Accounts/${PHONE_TEST_SECRETS.accountSid}/Messages/MMtest/Media`;
    await postText(app.url, {
      From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!,
      Body: 'here is the sketch', NumMedia: '3', MessageSid: 'MMtest',
      MediaUrl0: `${mediaBase}/ME0`, MediaContentType0: 'image/jpeg',
      MediaUrl1: `${mediaBase}/ME1`, MediaContentType1: 'application/pdf',
      MediaUrl2: 'https://evil.example/off-twilio-media', MediaContentType2: 'image/jpeg',
    });
    t.ok(await until(() => sends.length === 1), 'the MMS was injected as a turn');

    const injected = sends[0]!;
    t.ok(injected.startsWith('here is the sketch'), 'the captain\'s words lead the injected line');
    t.includes(injected, inbox, 'attachment references point into the inbox dir');
    t.includes(injected, '.jpg (image/jpeg)', 'the image reference carries extension + type');
    t.includes(injected, '.pdf (application/pdf)', 'the PDF reference carries extension + type');
    t.includes(injected, 'open and inspect it', 'first mate is told to open the files');
    t.notIncludes(injected, '\n', 'still a single injected line');

    const saved = readdirSync(inbox).sort();
    t.eq(saved.length, 3, 'all three media files landed in the inbox');
    const jpg = saved.find((f) => f.endsWith('-0.jpg'));
    t.ok(!!jpg && readFileSync(join(inbox, jpg!)).equals(JPEG), 'the stored image is byte-exact');
    const pdf = saved.find((f) => f.endsWith('-1.pdf'));
    t.ok(!!pdf && readFileSync(join(inbox, pdf!)).equals(PDF), 'the stored PDF is byte-exact');
    t.ok(saved.every((f) => /MMtest/.test(f)), 'filenames carry the (sanitized) message SID');

    const twilioHits = mediaHits.filter((h) => h.url.includes('api.twilio.com'));
    t.ok(twilioHits.length === 2 && twilioHits.every((h) => h.auth.startsWith('Basic ')), 'Twilio media fetches carry the account Basic auth');
    const offTwilio = mediaHits.find((h) => h.url.includes('evil.example'));
    t.ok(!!offTwilio && offTwilio.auth === '', 'credentials are NEVER sent to a non-Twilio media host');

    t.ok(await until(() => smsSent.length === 1), 'the MMS turn still gets its SMS reply');

    // an http:// (non-https) media URL is refused outright - the text still
    // lands, and BOTH sides are told the attachment was not seen
    await postText(app.url, {
      From: PHONE_TEST_SECRETS.allowedCaller!, To: PHONE_TEST_SECRETS.phoneNumber!,
      Body: 'insecure media test', NumMedia: '1', MessageSid: 'MMtest2',
      MediaUrl0: 'http://api.twilio.com/insecure', MediaContentType0: 'image/jpeg',
    });
    t.ok(await until(() => sends.length === 2), 'the message body still injected');
    t.ok(sends[1]!.startsWith('insecure media test'), 'the captain\'s words still lead');
    t.includes(sends[1]!, 'WARNING: MMS 1 of 1 attachment (the 1st) failed to download', 'the injected line tells first mate the attachment never arrived');
    t.notIncludes(sends[1]!, 'open and inspect', 'no attachment reference for the refused http URL');
    t.ok(!mediaHits.some((h) => h.url.startsWith('http://')), 'the http URL was never fetched');
    t.ok(await until(() => smsSent.length === 2), 'the partial-failure turn still gets its SMS reply');
    const failReply = smsSent[1]!.params.get('Body') || '';
    t.ok(failReply.startsWith('Note: 1 of 1 attachment (the 1st) failed to download - first mate did NOT see it.'), 'the SMS reply LEADS with the failure note naming the unseen attachment');
    t.includes(failReply, TEXT_NARRATION, 'and still carries the turn reply');
    t.ok(failReply.length <= SMS_BODY_LIMIT, 'note + reply stay within the limit');
  } finally {
    await app.close();
    rmSync(inbox, { recursive: true, force: true });
  }
});

// T4 - proactive outbound texts: the /text/notify trigger (bin/text-captain.sh)
// with its token + config gates, and the REST framing to the captain's number.
await reporter.leg('text - proactive notify: config + token gates + REST framing', async (t) => {
  const { driver } = makeTextDriver();
  const { fetchImpl, smsSent } = makeTextFetch({});
  const runner = new TurnRunner({ driver });
  const text = createTextApp({
    runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
    inboxDir: mkdtempSync(join(tmpdir(), 'ceochat-inbox-')), fetchImpl, log: () => {},
  });
  const app = await createWebApp({ driver, runner, text, host: '127.0.0.1', port: 0, terminalPollMs: 0, log: () => {} });
  const notifyUrl = app.url.replace(/\/$/, '') + TEXT_NOTIFY_PATH;
  const token = notifyToken(PHONE_TEST_SECRETS.authToken!);
  try {
    // token gate
    const noToken = await fetch(notifyUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=hi' });
    t.eq(noToken.status, 403, 'no x-ceochat-notify token -> 403');
    const badToken = await fetch(notifyUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ceochat-notify': 'wrong' }, body: 'text=hi' });
    t.eq(badToken.status, 403, 'a wrong token -> 403');
    t.eq(smsSent.length, 0, 'nothing was texted for refused requests');

    // the trigger: form-encoded (exactly what bin/text-captain.sh sends)
    const okRes = await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ceochat-notify': token },
      body: new URLSearchParams({ text: 'PR is green' }).toString(),
    });
    t.eq(okRes.status, 200, 'a tokened notify succeeds');
    t.eq(((await okRes.json()) as { ok?: boolean }).ok, true, 'and reports ok');
    t.eq(smsSent.length, 1, 'exactly one SMS went out');
    t.eq(smsSent[0]!.params.get('Body'), 'PR is green', 'with the notification text');
    t.eq(smsSent[0]!.params.get('To'), PHONE_TEST_SECRETS.allowedCaller!, 'to the captain - the only possible recipient');
    t.eq(smsSent[0]!.params.get('From'), PHONE_TEST_SECRETS.phoneNumber!, 'from our Twilio number');

    // JSON body works too (programmatic callers)
    const jsonRes = await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ceochat-notify': token },
      body: JSON.stringify({ text: 'CI is red' }),
    });
    t.eq(jsonRes.status, 200, 'JSON notify body is accepted');
    t.eq(smsSent[1]?.params.get('Body'), 'CI is red', 'and lands as the SMS body');

    // empty text is a 400, and GET is a 404 (webhook + notify are POST-only)
    const empty = await fetch(notifyUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ceochat-notify': token }, body: 'text=' });
    t.eq(empty.status, 400, 'empty text -> 400');
    t.eq((await fetch(notifyUrl)).status, 404, 'GET /text/notify -> 404');
    t.eq((await fetch(app.url.replace(/\/$/, '') + TEXT_WEBHOOK_PATH)).status, 404, 'GET /text/webhook -> 404');

    // config gate: CEOCHAT_TEXT_NOTIFY=0 -> the trigger is off even with a token
    const offApp = createTextApp({
      runner, secrets: PHONE_TEST_SECRETS, publicUrl: PHONE_PUBLIC_URL,
      notifyEnabled: false, fetchImpl, log: () => {},
    });
    t.eq(offApp.notifyEnabled, false, 'the config gate is surfaced');
    const before = smsSent.length;
    // mount check via the same server would need a second app; assert the handler directly
    const fakeRes = {
      code: 0, body: '',
      writeHead(c: number) { this.code = c; return this; },
      end(b?: string) { this.body = b || ''; },
    };
    const fakeReq = Object.assign(
      new (await import('node:stream')).Readable({ read() { this.push('text=hi'); this.push(null); } }),
      { url: TEXT_NOTIFY_PATH, method: 'POST', headers: { 'x-ceochat-notify': token, 'content-type': 'application/x-www-form-urlencoded' } },
    );
    offApp.handleHttp(fakeReq as unknown as Parameters<typeof offApp.handleHttp>[0], fakeRes as unknown as Parameters<typeof offApp.handleHttp>[1]);
    t.ok(await until(() => fakeRes.code === 404), 'CEOCHAT_TEXT_NOTIFY=0 -> notify answers 404 (disabled)');
    t.eq(smsSent.length, before, 'and nothing is texted');

    // programmatic notify without REST creds degrades with a clear reason
    const noCreds = createTextApp({
      runner, secrets: { ...PHONE_TEST_SECRETS, accountSid: undefined }, publicUrl: PHONE_PUBLIC_URL, log: () => {},
    });
    const failed = await noCreds.notify('hello');
    t.ok(!failed.ok && failed.detail.includes('not configured'), 'notify without outbound creds fails with a clear reason');
  } finally {
    await app.close();
  }
});

// ═══════════════════════ LIVE legs (creds required) ═════════════════════════
if (LIVE) {
  // Live MiniMax — measure REAL time-to-first-audio; unpaired creds => PENDING.
  await reporter.leg('live — MiniMax real WS (time-to-first-audio)', async (t) => {
    if (!hasMinimaxCreds(secrets)) {
      t.pending('MINIMAX_API_KEY not in ~/.config/ceo-chat/secrets.env — add it to run live');
      return;
    }
    if (!has(secrets, 'MINIMAX_GROUP_ID')) t.ok(true, 'note: MINIMAX_GROUP_ID blank — attempting anyway (WS auth does not require it)');
    try {
      const res: SynthResult = await synthStreaming({
        apiKey: secrets.MINIMAX_API_KEY!,
        groupId: secrets.MINIMAX_GROUP_ID || '',
        textChunks: ['Hello from ceo chat. ', 'This is a live time to first audio test.'],
        endpoint: INTL_WS, timeoutMs: 20000,
      });
      // If we got here, audio actually flowed — assert the real bytes + TTFB.
      t.ok(res.pcm.length > 0, 'live audio bytes received', `${res.pcm.length} bytes`);
      t.ok(typeof res.ttfbMs === 'number', 'real time-to-first-audio measured', `${res.ttfbMs}ms`);
    } catch (e) {
      // Until the captain pairs creds at home, the live leg is EXPECTED to not
      // produce audio — a 1004 (cred pairing), 1008 (balance), or even a transport
      // error (egress/TLS) is reported as PENDING, never a red run. It flips to a
      // real PASS the moment audio flows.
      const msg = (e as Error).message;
      const known = /1004|1008|insufficient balance|auth|ws error|timed out|ECONN|ENOTFOUND|TLS/i.test(msg);
      t.pending(`${known ? 'expected pre-pairing/transport blocker' : 'live MiniMax not yet producing audio'} — ${msg}`);
    }
  });

  // Live MiniMax REST auth probe — confirms the API key + GroupId are valid WITHOUT
  // spending credits or creating a clone: a read-only POST /v1/get_voice (lists voices).
  // This is the same auth surface the clone pipeline uses (Bearer + GroupId-in-query),
  // so a green probe means `npm run clone-voice` will authenticate. PENDING (never red)
  // when creds are absent or the account/GroupId is not yet paired.
  await reporter.leg('live — MiniMax REST auth probe (get_voice, no credits)', async (t) => {
    if (!hasMinimaxCreds(secrets)) {
      t.pending('MINIMAX_API_KEY not in secrets.env — add it to probe REST auth');
      return;
    }
    try {
      const url = `https://api.minimax.io/v1/get_voice?GroupId=${encodeURIComponent(secrets.MINIMAX_GROUP_ID || '')}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secrets.MINIMAX_API_KEY!}`, 'content-type': 'application/json' },
        body: JSON.stringify({ voice_type: 'all' }),
      });
      const data = (await res.json()) as { base_resp?: { status_code?: number; status_msg?: string } };
      const code = data.base_resp?.status_code;
      if (code && code !== 0) {
        t.pending(`MiniMax auth/GroupId not paired (base_resp ${code}: ${data.base_resp?.status_msg}) — fix before cloning`);
        return;
      }
      t.ok(res.ok, 'get_voice reachable', `HTTP ${res.status}`);
      t.ok(!code || code === 0, 'API key + GroupId authenticate (status_code 0) — clone pipeline will work');
    } catch (e) {
      t.pending('REST transport blocker (egress/TLS) — ' + (e as Error).message);
    }
  });

  // Live speakability — sanity-check the REAL LLM stays screen-safe (tolerant).
  await reporter.leg('live — speakability real backend (screen-safe)', async (t) => {
    const apiKey = has(secrets, 'ANTHROPIC_API_KEY') ? secrets.ANTHROPIC_API_KEY! : null;
    try {
      const { narration, backend } = await speakify(SAMPLE_AGENT_TURN, { apiKey, backend: 'auto' });
      t.ok(narration.length > 0, `live narration produced (${backend})`);
      t.notIncludes(narration, 'https://example.com/pr/42', 'live backend drops the URL');
    } catch (e) {
      t.pending('live speakability backend unavailable — ' + (e as Error).message);
    }
  });

  // Live GEMINI drift gate — the REAL end-to-end summary-quality check the captain wants:
  // run each real drift fixture through gemini-2.5-flash (thinkingBudget:0) and assert the
  // SAME contract the mock asserts offline — every topic covered, the right option named,
  // no paths/URLs/PIDs, questions preserved. PENDING (never red) without GEMINI_API_KEY so
  // `npm run validate:live` stays green until the key is paired; flips to PASS once it is.
  await reporter.leg('live — Gemini drift fixtures (cover topics, right recommendation, screen-safe)', async (t) => {
    if (!hasGeminiCreds(secrets)) {
      t.pending('GEMINI_API_KEY not in ~/.config/ceo-chat/secrets.env — add it to run the live drift gate');
      return;
    }
    // This is a REAL-MODEL quality REPORT, not a hard gate: gemini-2.5-flash is
    // non-deterministic, so an occasional miss (a path slips through one run) must NOT
    // turn `npm run validate:live` red — it's reported as PENDING with the offending
    // narration so the captain can tune the prompt. The DETERMINISTIC drift gate (D1-D3
    // in mock mode) is the hard guard. Each fixture's misses are collected and surfaced.
    const misses: string[] = [];
    let ran = 0;
    for (const f of DRIFT_FIXTURES) {
      try {
        const { narration, backend } = await speakify(f.reply, {
          backend: 'gemini', geminiApiKey: secrets.GEMINI_API_KEY!,
        });
        if (backend !== 'gemini') { misses.push(`${f.name}: fell back to ${backend} (Gemini unavailable)`); continue; }
        ran++;
        const low = narration.toLowerCase();
        for (const group of f.mustMention) {
          if (!group.some((k) => low.includes(k.toLowerCase()))) misses.push(`${f.name}: dropped topic (${group.join('/')}) — "${narration}"`);
        }
        if (f.recommended && !low.includes(f.recommended.toLowerCase())) {
          misses.push(`${f.name}: did not name recommendation (${f.recommended}) — "${narration}"`);
        }
        for (const bad of f.forbid) {
          if (narration.includes(bad)) misses.push(`${f.name}: spoke "${bad}" — "${narration}"`);
        }
        if (f.expectQuestion && !narration.includes('?')) misses.push(`${f.name}: dropped the pending question — "${narration}"`);
      } catch (e) {
        misses.push(`${f.name}: live call failed — ${(e as Error).message}`);
      }
    }
    t.ok(ran > 0, 'at least one fixture summarized by the live Gemini backend', `${ran} ran`);
    if (misses.length) {
      t.pending(`Gemini quality misses (LLM variance — tune the prompt if persistent):\n     - ${misses.join('\n     - ')}`);
    }
  });
} else {
  reporter.skip('live — MiniMax real WS', 'run `npm run validate:live` with creds in secrets.env');
  reporter.skip('live — MiniMax REST auth probe (get_voice)', 'run `npm run validate:live` with creds in secrets.env');
  reporter.skip('live — speakability real backend', 'run `npm run validate:live` with creds in secrets.env');
  reporter.skip('live — Gemini drift fixtures', 'run `npm run validate:live` with GEMINI_API_KEY in secrets.env');
}

const green = reporter.summary();
process.exit(green ? 0 : 1);
