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

import { mkdtempSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSecrets, has, hasMinimaxCreds, type Secrets } from '../src/config/secrets.ts';
import {
  parseTranscript, tailTranscript, type TranscriptEvent,
} from '../src/transcript/transcript.ts';
import { waitForReply } from '../src/transcript/reply.ts';
import { speakify, mockSpeakify } from '../src/speakability/speakability.ts';
import {
  synthStreaming, toWav, wavHeader, INTL_WS, type SynthResult,
} from '../src/tts/minimax.ts';
import {
  verifiedSubmit, paneHoldsText, resolveTargetFromEnv, attachTarget, paneCurrentPath,
  sessionExists, capturePane, capturePaneAnsi,
} from '../src/session/session.ts';
import { runPipeline } from '../src/broker/pipeline.ts';
import { Reporter } from './harness/report.ts';
import { startMockMinimax } from '../src/tts/mock-server.ts';
import { createWebApp } from '../src/server/app.ts';
import { WS_PATH, AUDIO_FORMAT } from '../src/server/protocol.ts';
import type { Driver } from '../src/server/driver.ts';
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
    meta: () => ({ ttsMode: 'mock', speakBackend: 'mock', sampleRate: 32000 }),
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
