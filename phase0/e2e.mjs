#!/usr/bin/env node
// e2e.mjs — the Phase-0 payoff: typed text → firstmate → transcript → speakability
// → MiniMax TTS → spoken audio on hub. No phone, no car yet (plan §10 milestone).
//
// Pipeline (every leg is the real component, wired exactly as the broker will):
//   1. spawn a dedicated throwaway `ceo-chat` claude session            (lib/session)
//   2. inject the typed line via fm-send.sh — verified submit           (lib/session)
//   3. read the agent's reply from the transcript JSONL tap             (lib/transcript)
//   4. speakability pass → <=2-3 spoken sentences                       (lib/speakability)
//   5. stream the narration into MiniMax streaming TTS → spoken audio   (lib/minimax)
//
// CREDS: legs 1-4 run for real with no API key (speakability falls back to the
// locally-authenticated `claude -p`). Leg 5 needs MINIMAX_API_KEY + GroupId; if
// blank, we still produce the narration and STUB only the MiniMax call with a
// clear TODO + run instructions (per task spec).
//
// RUN:   node phase0/e2e.mjs ["typed text to send to firstmate"]
// OUT:   phase0/out/e2e-narration.txt  (+ e2e.wav when MiniMax creds present)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets, has } from './lib/secrets.mjs';
import {
  PROJECTS_DIR, mangleCwd, latestTranscriptIn, parseTranscript,
} from './lib/transcript.mjs';
import { speakify } from './lib/speakability.mjs';
import { synthStreaming, wavHeader } from './lib/minimax.mjs';
import { spawnCeoChat, teardown, waitForComposer, fmSend, capturePane, sleep } from './lib/session.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const log = (m) => console.log('  ·', m);

const typed =
  process.argv[2] ||
  'You just finished a task. In a couple of sentences tell me the unit tests ' +
  'passed, that you edited src/server.ts, and that the pull request is open at ' +
  'https://example.com/pr/42 — then ask whether I want you to merge it.';

const secrets = loadSecrets();
let ctx = null;
let exitCode = 1;

try {
  // ---- 1. spawn dedicated session -----------------------------------------
  console.log('① spawning dedicated ceo-chat session');
  ctx = spawnCeoChat({ log });
  await waitForComposer({ log });

  const projectDir = join(PROJECTS_DIR, mangleCwd(ctx.cwd));

  // ---- 2. inject via fm-send.sh -------------------------------------------
  console.log('\n② injecting typed text via fm-send.sh (verified submit)');
  console.log('   typed: "' + typed + '"');
  await fmSend(typed, { log });
  log('submit verified');

  // The session transcript file is written lazily, around the first turn — so we
  // discover it AFTER injecting, with a generous poll.
  let transcript = null;
  for (let i = 0; i < 120 && !transcript; i++) {
    transcript = latestTranscriptIn(projectDir);
    if (!transcript) await sleep(500);
  }
  if (!transcript) throw new Error('no transcript appeared under ' + projectDir);
  log('transcript: ' + transcript);

  // ---- 3. read the agent reply from the transcript tap --------------------
  console.log('\n③ waiting for the agent reply on the transcript tap');
  const reply = await waitForReply(transcript, 0, { timeoutMs: 150000 });
  console.log('   agent said (raw):\n' + indent(reply));

  // ---- 4. speakability pass -----------------------------------------------
  console.log('\n④ speakability pass (rewrite for the ear)');
  const { narration, backend } = await speakify(reply, {
    apiKey: has(secrets, 'ANTHROPIC_API_KEY') ? secrets.ANTHROPIC_API_KEY : null,
    log,
  });
  console.log(`   backend: ${backend}`);
  console.log('   narration:\n' + indent(narration));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'e2e-narration.txt'), narration + '\n');

  // ---- 5. MiniMax TTS ------------------------------------------------------
  // Mirror spike1: attempt the LIVE call whenever the API key is present (even if
  // GroupId is blank) so the e2e surfaces the real result/error. A known blocker
  // (e.g. insufficient balance) is reported but does NOT fail the run — legs 1-4
  // are the payoff this round.
  console.log('\n⑤ MiniMax streaming TTS');
  if (has(secrets, 'MINIMAX_API_KEY')) {
    if (!has(secrets, 'MINIMAX_GROUP_ID')) console.log('   ⚠ MINIMAX_GROUP_ID blank — attempting anyway.');
    const chunks = narration.match(/[^.!?]+[.!?]*\s*/g) || [narration];
    try {
      const { pcm, ttfbMs, sampleRate, billing } = await synthStreaming({
        apiKey: secrets.MINIMAX_API_KEY,
        groupId: secrets.MINIMAX_GROUP_ID || '',
        textChunks: chunks,
        log,
      });
      const wavPath = join(OUT_DIR, 'e2e.wav');
      writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));
      console.log(`   ✅ spoke ${pcm.length} PCM bytes; time-to-first-audio ${ttfbMs ?? 'n/a'} ms`);
      console.log(`   billing: ${billing ? JSON.stringify(billing) : '(none)'}`);
      console.log(`   wrote: ${wavPath}`);
    } catch (e) {
      console.log('   ⏳ TTS leg not completed (known/pending blocker): ' + e.message);
      console.log('      Narration above is ready; this leg auto-completes once the blocker clears.');
    }
  } else {
    console.log('   ⏳ STUBBED — no MINIMAX_API_KEY. Narration is ready to speak.');
    console.log('   TODO: add MINIMAX_API_KEY + MINIMAX_GROUP_ID to ~/.config/ceo-chat/secrets.env;');
    console.log('         then this leg auto-runs (verify standalone with phase0/spike1-minimax-tts.mjs).');
  }

  console.log('\n✅ E2E pipeline wired end-to-end (legs 1-4 ran for real this run).');
  exitCode = 0;
} catch (e) {
  console.error('\n❌ e2e failed:', e.message);
} finally {
  if (ctx) teardown({ cwd: ctx.cwd, log });
}
process.exit(exitCode);

// ---- helpers ---------------------------------------------------------------

// Poll the transcript until a NEW assistant `say` turn lands AND the composer
// returns to idle (turn complete), then return the concatenated new say text.
async function waitForReply(transcript, sayBefore, { timeoutMs }) {
  const start = performance.now();
  let lastSeen = sayBefore;
  while (performance.now() - start < timeoutMs) {
    const says = parseTranscript(transcript).filter((e) => e.kind === 'say');
    if (says.length > lastSeen) {
      // give the turn a beat to finish, then confirm the harness is idle again
      // (claude shows "esc to interrupt" while a turn is still streaming).
      await sleep(2000);
      const pane = capturePane();
      const idle = !/esc to interrupt/i.test(pane);
      const after = parseTranscript(transcript).filter((e) => e.kind === 'say');
      if (after.length >= says.length && idle) {
        return after.slice(sayBefore).map((e) => e.text).join('\n').trim();
      }
      lastSeen = says.length;
    }
    await sleep(1000);
  }
  throw new Error('timed out waiting for agent reply');
}

function indent(s) {
  return (s || '').split('\n').map((l) => '       ' + l).join('\n');
}
