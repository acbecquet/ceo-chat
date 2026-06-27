// session.mjs — own a DEDICATED, throwaway `ceo-chat` firstmate-style tmux
// session, drive firstmate's own bin/fm-send.sh to inject text into it, and tear
// it down. This is exactly what the broker does for the voice INPUT path
// (plan §2): STT text -> one verified fm-send.sh call -> the agent composer.
//
// SAFETY (task rules): we create our OWN session named `ceo-chat` in a temp cwd,
// never touch the captain's real sessions or any fm-<id> windows, address it via
// the explicit `session:window` escape hatch (which fm-send leaves unmarked), and
// always kill it on teardown. We refuse to start if a `ceo-chat` session already
// exists.

import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FM_SEND = '/home/acbecquet/firstmate/bin/fm-send.sh';
const SESSION = 'ceo-chat';
const WINDOW = 'agent';
export const TARGET = `${SESSION}:${WINDOW}`;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts });

export function sessionExists(name = SESSION) {
  try {
    sh('tmux', ['has-session', '-t', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(target = TARGET) {
  try {
    return sh('tmux', ['capture-pane', '-p', '-t', target]);
  } catch {
    return '';
  }
}

// Launch a real claude harness in the throwaway session, mirroring how firstmate
// spawns one (fm-spawn.sh launch template): prompt suggestions off + skip the
// permission prompts so it reaches an interactive composer unattended. Returns
// { cwd } — the agent's working dir, whose mangled name locates its transcript.
export function spawnCeoChat({ log = () => {} } = {}) {
  if (sessionExists()) {
    throw new Error(
      `a tmux session named '${SESSION}' already exists — refusing to touch it. ` +
      `Kill it yourself if it is a leftover spike session.`,
    );
  }
  const cwd = mkdtempSync(join(tmpdir(), 'ceochat-spike-'));
  const launch =
    'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false ' +
    'claude --dangerously-skip-permissions';
  log(`tmux new-session ${SESSION} (cwd ${cwd})`);
  sh('tmux', ['new-session', '-d', '-s', SESSION, '-n', WINDOW, '-c', cwd, launch]);
  return { cwd, session: SESSION, target: TARGET };
}

export function teardown({ cwd, log = () => {} } = {}) {
  try {
    if (sessionExists()) {
      sh('tmux', ['kill-session', '-t', SESSION]);
      log(`killed tmux session ${SESSION}`);
    }
  } catch (e) {
    log('teardown: kill-session failed: ' + e.message);
  }
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

// Poll the pane until the claude composer is drawn and idle, handling the
// one-time "trust this folder" dialog that claude shows for a fresh cwd
// (`--dangerously-skip-permissions` does NOT bypass it). We accept it in-band by
// sending Enter on the pre-selected "Yes, I trust this folder" option.
export async function waitForComposer({ target = TARGET, timeoutMs = 90000, log = () => {} } = {}) {
  const start = performance.now();
  let trusted = false;
  while (performance.now() - start < timeoutMs) {
    const pane = capturePane(target);

    if (!trusted && /trust this folder|Yes, I trust/i.test(pane)) {
      log('accepting "trust this folder" dialog');
      try { sh('tmux', ['send-keys', '-t', target, 'Enter']); } catch {}
      trusted = true;
      await sleep(1500);
      continue;
    }

    // claude's idle composer shows a bordered box with a `❯`/`>` prompt and a
    // "bypass permissions" / "for shortcuts" footer.
    if (
      /[❯>]\s*$/m.test(pane) ||
      /bypass permissions/i.test(pane) ||
      /\bfor shortcuts\b/i.test(pane) ||
      /Welcome to Claude Code/i.test(pane)
    ) {
      // The composer can paint a beat before it actually accepts input/Enter
      // (worst right after the trust dialog), which otherwise causes a swallowed
      // first Enter. Give it a settle.
      await sleep(trusted ? 3500 : 1500);
      log('composer ready');
      return true;
    }
    await sleep(500);
  }
  log('composer wait timed out (continuing anyway)');
  return false;
}

// Clear anything sitting in the composer (kill-line + Escape) so a verified
// submit starts from an empty box — also our recovery after a swallowed Enter,
// which leaves our text in the composer.
export function clearComposer(target = TARGET) {
  try {
    sh('tmux', ['send-keys', '-t', target, 'C-u']);
    sh('tmux', ['send-keys', '-t', target, 'Escape']);
  } catch {}
}

// Is `line` still sitting in the composer? We read the bottom `❯ `/`> ` composer
// input line (between the box borders) and look for the line's distinctive head.
// The echoed user message above the composer uses a different glyph, so this only
// inspects the live input box.
export function composerHoldsText(line, target = TARGET) {
  const head = line.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!head) return false;
  const pane = capturePane(target);
  const rows = pane.split('\n');
  // find the LAST composer prompt row
  let promptRow = '';
  for (const r of rows) {
    const m = r.match(/^\s*[❯>]\s?(.*)$/);
    if (m) promptRow = m[1];
  }
  return promptRow.replace(/\s+/g, ' ').includes(head.slice(0, 16));
}

function fmSendOnce(line, { target = TARGET, log = () => {} } = {}) {
  return new Promise((resolve) => {
    log(`fm-send.sh ${target} "${line.length > 60 ? line.slice(0, 57) + '…' : line}"`);
    // Give fm-send's verified-submit more headroom than the default 3
    // Enter-retries — a freshly-booted harness can briefly swallow the first Enter.
    const env = { ...process.env, FM_SEND_RETRIES: '6', FM_SEND_SLEEP: '0.5' };
    execFile(FM_SEND, [target, line], { encoding: 'utf8', timeout: 45000, env }, (err) => {
      resolve(err ? err.code || 1 : 0); // fm-send exit code (0 = it verified)
    });
  });
}

// Verified submit. Returns { ok, fmExit, composerVerified, retried }.
//
// PHASE-0 FINDING baked in: on claude v2.1.x, fm-send.sh frequently EXITS NON-ZERO
// ("Enter swallowed") even though the text DID submit and the agent replies — a
// false negative from its composer-clear read. So composer-cleared (verified by
// us, independent of fm-send) is the source of truth. We only ever re-send if the
// composer still genuinely holds our text, so a misreported-but-landed submit is
// never double-submitted.
export async function fmSend(line, { target = TARGET, log = () => {} } = {}) {
  clearComposer(target);
  await sleep(400);
  const exit1 = await fmSendOnce(line, { target, log });

  // Poll: did the composer actually clear? (the real proof of submit)
  for (let i = 0; i < 16; i++) {
    if (!composerHoldsText(line, target)) {
      if (exit1 !== 0) log('note: fm-send exited non-zero but composer CLEARED → submit landed (fm-send false-negative)');
      return { ok: true, fmExit: exit1, composerVerified: true, retried: false };
    }
    await sleep(500);
  }

  // Composer still holds our text → genuinely not submitted. Clear and retry once.
  log('composer still holds the text → clearing and retrying once');
  clearComposer(target);
  await sleep(1200);
  const exit2 = await fmSendOnce(line, { target, log });
  for (let i = 0; i < 16; i++) {
    if (!composerHoldsText(line, target)) {
      return { ok: true, fmExit: exit2, composerVerified: true, retried: true };
    }
    await sleep(500);
  }
  throw new Error('text not submitted to ' + target + ' (composer still holds it after retry)');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
