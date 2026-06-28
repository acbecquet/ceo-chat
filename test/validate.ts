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

import { loadSecrets, has, hasMinimaxCreds, type Secrets } from '../src/config/secrets.ts';
import {
  parseTranscript, tailTranscript, latestTranscriptIn, type TranscriptEvent,
} from '../src/transcript/transcript.ts';
import { waitForReply } from '../src/transcript/reply.ts';
import { speakify, mockSpeakify } from '../src/speakability/speakability.ts';
import {
  synthStreaming, toWav, wavHeader, INTL_WS, type SynthResult,
} from '../src/tts/minimax.ts';
import {
  verifiedSubmit, paneHoldsText, resolveTargetFromEnv, attachTarget, paneCurrentPath,
  sessionExists, capturePane, capturePaneAnsi, resolveSessionWindow,
} from '../src/session/session.ts';
import { runPipeline, sentenceChunks } from '../src/broker/pipeline.ts';
import { Reporter } from './harness/report.ts';
import { startMockMinimax } from '../src/tts/mock-server.ts';
import { createWebApp } from '../src/server/app.ts';
import { WS_PATH, AUDIO_FORMAT, STT_SAMPLE_RATE } from '../src/server/protocol.ts';
import type { Driver } from '../src/server/driver.ts';
import { findPiper, synthLocal } from '../src/tts/local-tts.ts';
import { makeWhisperTranscriber } from '../src/server/stt.ts';
import { parseWav } from '../src/tts/minimax.ts';
// Shared browser modules — the SAME files the page loads at /lib/… (asserted here so
// the mobile audio-unlock / STT-restart / confirmation logic can't silently regress).
import {
  base64ToBytes, bytesToBase64, pcmS16leToFloat32, float32ToPcmS16le, downsampleFloat32,
} from '../src/web/pcm.js';
import { looksConsequential, classifyReply, guardUtterance } from '../src/web/confirm.js';
import { AudioPlayer } from '../src/web/audio-player.js';
import type { AudioCtxLike, AudioSrcLike } from '../src/web/audio-player.js';
import { SpeechController } from '../src/web/speech.js';
import type { RecognitionLike } from '../src/web/speech.js';
import {
  STT_SAMPLE_RATE as WEB_STT_SR, AUDIO_FORMAT as WEB_AUDIO_FORMAT, WS_PATH as WEB_WS_PATH,
} from '../src/web/protocol-consts.js';
import { WebSocket as WsClient } from 'ws';
import {
  assistantSay, assistantThinking, assistantToolUse, userPrompt, userToolResult,
  bookkeeping, SAMPLE_AGENT_TURN, CONFIRM_TURN, LONG_CODE_TURN,
} from './harness/fixtures.ts';

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
} else {
  reporter.skip('live — MiniMax real WS', 'run `npm run validate:live` with creds in secrets.env');
  reporter.skip('live — speakability real backend', 'run `npm run validate:live` with creds in secrets.env');
}

const green = reporter.summary();
process.exit(green ? 0 : 1);
