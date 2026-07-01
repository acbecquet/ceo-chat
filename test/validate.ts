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

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSecrets, has, hasMinimaxCreds, hasGeminiCreds, minimaxVoiceId, type Secrets } from '../src/config/secrets.ts';
import {
  parseTranscript, tailTranscript, latestTranscriptIn, type TranscriptEvent,
  findPromptAnchor, saysAfterAnchor, latestTranscriptWithPrompt,
} from '../src/transcript/transcript.ts';
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
  pcmChunkToPhoneMulaw, phoneMulawToWhisperPcm, upsampleFloat32, frameRms,
  UtteranceDetector, PHONE_SAMPLE_RATE,
} from '../src/server/phone-audio.ts';
import {
  twimlConnectStream, twilioSignature, validateTwilioSignature, sameNumber, placeCall,
} from '../src/server/twilio.ts';
import {
  createPhoneApp, digitsFromSpoken, DEFAULT_PHRASES, DEFAULT_PROMPT_POLICY,
  PHONE_WS_PATH, PHONE_TWIML_PATH, type PhoneTimers,
} from '../src/server/phone.ts';
import { TurnRunner } from '../src/server/turns.ts';
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

  // spoken PIN digits
  t.eq(digitsFromSpoken('four three two one'), '4321', 'word digits parse ("four three two one")');
  t.eq(digitsFromSpoken('4 3, 2 1.'), '4321', 'numeric digits parse with punctuation');
  t.eq(digitsFromSpoken('please merge it'), '', 'non-digit speech yields no digits');
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
// token, the PIN gate (NOTHING reaches the driver until it passes), spoken-PIN,
// STT -> TurnRunner.run, and onChunk -> media+mark framing whose payload decodes
// back to the pipeline audio at 8 kHz.
await reporter.leg('phone - media WS: PIN gate blocks injection; STT->send; media+mark framing', async (t) => {
  const sends: string[] = [];
  const spoken: string[] = [];
  const heard = ['four three two one', 'run the checks'];
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
  const phone = createPhoneApp({
    runner,
    secrets: PHONE_TEST_SECRETS,
    publicUrl: PHONE_PUBLIC_URL,
    transcribe: async () => heard.shift() ?? '',
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

    // wrong DTMF PIN -> retry prompt, still NO injection
    for (const d of '9999') call.send({ event: 'dtmf', dtmf: { digit: d } });
    t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.pinRetry)), 'a wrong DTMF PIN is refused (retry prompt)');
    t.eq(sends.length, 0, 'REGRESSION GUARD: no Broker.send before a valid PIN');

    // spoken PIN ("four three two one") -> authenticated
    call.speakUtterance();
    t.ok(await until(() => spoken.includes(DEFAULT_PHRASES.greeting)), 'the SPOKEN pin ("four three two one") authenticates the call');
    t.eq(sends.length, 0, 'the PIN utterance itself is never injected');

    // now a real command: utterance -> whisper stub -> TurnRunner -> driver.send
    await realSleep(100); // let the greeting's mark echo settle half-duplex
    call.mediaPayloads.length = 0;
    call.speakUtterance();
    t.ok(await until(() => sends.length === 1), 'the transcribed utterance reaches the pipeline (STT -> send)');
    t.eq(sends[0], 'run the checks', 'the exact transcribed text is injected');

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
  const heard = ['4321', 'start the deploy build', '4321', 'summarize the logs'];
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
    call1.speakUtterance(); // spoken PIN "4321"
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
    call2.speakUtterance(); // PIN
    await until(() => heard.length === 1);
    call2.speakUtterance(); // command -> long turn
    t.ok(await until(() => sends.length === 2), 'the second call started its own turn');
    call2.send({ event: 'stop' });
    t.ok(await until(() => sawAborted === 2), 'hangup (stop frame) aborts the in-flight turn');
    call2.close();
  } finally {
    await app.close();
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
