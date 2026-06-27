#!/usr/bin/env node
// spike3-fm-send.mjs — broker-style injection into a dedicated ceo-chat session.
//
// PROVES (plan §2): from a broker-like Node process we can drive firstmate's own
// bin/fm-send.sh to inject a line into a DEDICATED throwaway `ceo-chat` agent
// tmux session and get the VERIFIED submit (fm-send exits 0 only once the
// composer clears; non-zero if Enter was swallowed). The voice INPUT path is
// therefore "STT text -> one fm-send.sh call" — no new injection code needed.
//
// SAFETY: creates its own `ceo-chat` session in a temp cwd, never touches the
// captain's sessions or fm-<id> windows, and always tears down.
//
// RUN:   node phase0/spike3-fm-send.mjs ["line to inject"]
// No external creds required (uses the locally-authenticated claude harness).

import { spawnCeoChat, teardown, waitForComposer, fmSend, capturePane } from './lib/session.mjs';

const line = process.argv[2] || 'Reply with exactly the word PONG and nothing else.';
const log = (m) => console.log('  ·', m);

let ctx = null;
let ok = false;
try {
  console.log('Spawning throwaway ceo-chat session…');
  ctx = spawnCeoChat({ log });
  await waitForComposer({ log });

  console.log('\nInjecting via fm-send.sh (verified submit)…');
  const r = await fmSend(line, { log }); // throws if the submit was not verified
  console.log(`✅ submit VERIFIED via composer-cleared (fm-send exit=${r.fmExit}${r.retried ? ', retried' : ''}).`);
  if (r.fmExit !== 0) {
    console.log('   ⚠ NOTE: fm-send.sh exited non-zero but the text DID submit — a false');
    console.log('     negative in its composer-clear read on claude v2.1.x (see FINDINGS).');
  }

  // Brief settle, then show the composer is empty / agent is now working.
  await new Promise((r) => setTimeout(r, 1500));
  const after = capturePane();
  console.log('\n--- pane tail after injection (last 12 lines) ---');
  console.log(after.split('\n').slice(-12).join('\n'));

  ok = true;
} catch (e) {
  console.error('\n❌ spike3 failed:', e.message);
} finally {
  if (ctx) teardown({ cwd: ctx.cwd, log });
}
process.exit(ok ? 0 : 1);
