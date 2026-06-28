// session.ts — own a DEDICATED, throwaway `ceo-chat` firstmate-style tmux session,
// drive firstmate's own bin/fm-send.sh to inject text into it, and tear it down.
// This is the voice INPUT path (plan §2): STT text -> one verified fm-send.sh call
// -> the agent composer.
//
// SAFETY (task rules): we create our OWN session named `ceo-chat` in a temp cwd,
// never touch the captain's real sessions or any fm-<id> windows, address it via
// the explicit `session:window` escape hatch (which fm-send leaves unmarked), and
// always kill it on teardown. We refuse to start if a `ceo-chat` session exists.

import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FM_SEND = process.env.FM_SEND_BIN || '/home/acbecquet/firstmate/bin/fm-send.sh';
const SESSION = 'ceo-chat';
const WINDOW = 'agent';
export const TARGET = `${SESSION}:${WINDOW}`;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Log = (msg: string) => void;
const noop: Log = () => {};

function sh(cmd: string, args: string[], opts: Record<string, unknown> = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }) as string;
}

export function sessionExists(name: string = SESSION): boolean {
  try {
    sh('tmux', ['has-session', '-t', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function capturePane(target: string = TARGET): string {
  try {
    return sh('tmux', ['capture-pane', '-p', '-t', target]);
  } catch {
    return '';
  }
}

// Like capturePane but preserves colour/attribute escape sequences (`-e`) so the
// web UI's xterm.js renders the pane with the same ANSI styling the captain would
// see in tmux. Plain capturePane (above) stays text-only for the idle-latch read.
export function capturePaneAnsi(target: string = TARGET): string {
  try {
    return sh('tmux', ['capture-pane', '-e', '-p', '-t', target]);
  } catch {
    return '';
  }
}

export interface SessionCtx {
  cwd: string;
  session: string;
  target: string;
}

// Launch a real claude harness in the throwaway session, mirroring how firstmate
// spawns one: prompt suggestions off + skip the permission prompts so it reaches an
// interactive composer unattended. Returns { cwd } — the agent's working dir, whose
// mangled name locates its transcript.
export function spawnCeoChat({ log = noop }: { log?: Log } = {}): SessionCtx {
  if (sessionExists()) {
    throw new Error(
      `a tmux session named '${SESSION}' already exists — refusing to touch it. ` +
      `Kill it yourself if it is a leftover spike session.`,
    );
  }
  const cwd = mkdtempSync(join(tmpdir(), 'ceochat-session-'));
  const launch =
    'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions';
  log(`tmux new-session ${SESSION} (cwd ${cwd})`);
  sh('tmux', ['new-session', '-d', '-s', SESSION, '-n', WINDOW, '-c', cwd, launch]);
  return { cwd, session: SESSION, target: TARGET };
}

export function teardown({ cwd, log = noop }: { cwd?: string; log?: Log } = {}): void {
  try {
    if (sessionExists()) {
      sh('tmux', ['kill-session', '-t', SESSION]);
      log(`killed tmux session ${SESSION}`);
    }
  } catch (e) {
    log('teardown: kill-session failed: ' + (e as Error).message);
  }
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Poll the pane until the claude composer is drawn and idle, handling the one-time
// "trust this folder" dialog that claude shows for a fresh cwd
// (`--dangerously-skip-permissions` does NOT bypass it). Accept it in-band.
export async function waitForComposer(
  { target = TARGET, timeoutMs = 90000, log = noop }: { target?: string; timeoutMs?: number; log?: Log } = {},
): Promise<boolean> {
  const start = performance.now();
  let trusted = false;
  while (performance.now() - start < timeoutMs) {
    const pane = capturePane(target);
    if (!trusted && /trust this folder|Yes, I trust/i.test(pane)) {
      log('accepting "trust this folder" dialog');
      try { sh('tmux', ['send-keys', '-t', target, 'Enter']); } catch { /* retry next loop */ }
      trusted = true;
      await sleep(1500);
      continue;
    }
    if (
      /[❯>]\s*$/m.test(pane) ||
      /bypass permissions/i.test(pane) ||
      /\bfor shortcuts\b/i.test(pane) ||
      /Welcome to Claude Code/i.test(pane)
    ) {
      // The composer can paint a beat before it accepts Enter (worst right after
      // the trust dialog), which otherwise swallows the first Enter. Settle.
      await sleep(trusted ? 3500 : 1500);
      log('composer ready');
      return true;
    }
    await sleep(500);
  }
  log('composer wait timed out (continuing anyway)');
  return false;
}

// Clear anything sitting in the composer (kill-line + Escape) — also our recovery
// after a swallowed Enter, which leaves our text in the composer.
export function clearComposer(target: string = TARGET): void {
  try {
    sh('tmux', ['send-keys', '-t', target, 'C-u']);
    sh('tmux', ['send-keys', '-t', target, 'Escape']);
  } catch { /* best effort */ }
}

// Is `line` still sitting in the live composer input box?
export function composerHoldsText(line: string, target: string = TARGET): boolean {
  return paneHoldsText(capturePane(target), line);
}

// Pure helper (testable): does this captured pane's composer row hold `line`?
export function paneHoldsText(pane: string, line: string): boolean {
  const head = line.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!head) return false;
  let promptRow = '';
  for (const r of pane.split('\n')) {
    const m = r.match(/^\s*[❯>]\s?(.*)$/);
    if (m) promptRow = m[1]!;
  }
  return promptRow.replace(/\s+/g, ' ').includes(head.slice(0, 16));
}

function fmSendOnce(line: string, { target = TARGET, log = noop }: { target?: string; log?: Log }): Promise<number> {
  return new Promise<number>((resolve) => {
    log(`fm-send.sh ${target} "${line.length > 60 ? line.slice(0, 57) + '…' : line}"`);
    // More headroom than fm-send's default 3 Enter-retries: a freshly-booted
    // harness can briefly swallow the first Enter.
    const env = { ...process.env, FM_SEND_RETRIES: '6', FM_SEND_SLEEP: '0.5' };
    execFile(FM_SEND, [target, line], { encoding: 'utf8', timeout: 45000, env }, (err) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve(err ? (typeof code === 'number' ? code : 1) : 0);
    });
  });
}

export interface VerifiedSubmitResult {
  ok: boolean;
  fmExit: number;
  composerVerified: boolean;
  retried: boolean;
}

export interface VerifiedSubmitDeps {
  sendOnce: (line: string) => Promise<number>;
  holdsText: (line: string) => boolean;
  clear: () => void;
  sleep: (ms: number) => Promise<void>;
  log?: Log;
}

// PHASE-0 FINDING baked in (regression-guarded): on claude v2.1.x, fm-send.sh
// frequently EXITS NON-ZERO ("Enter swallowed") even though the text DID submit and
// the agent replies — a false negative from its composer-clear read. So
// composer-cleared (verified by US, independent of fm-send) is the source of truth.
// We only ever re-send when the composer GENUINELY still holds our text, so a
// misreported-but-landed submit is never double-submitted.
//
// Pure/injectable so the validation harness can drive every branch deterministically.
export async function verifiedSubmit(
  line: string,
  deps: VerifiedSubmitDeps,
  { pollTries = 16, pollMs = 500 }: { pollTries?: number; pollMs?: number } = {},
): Promise<VerifiedSubmitResult> {
  const log = deps.log ?? noop;
  deps.clear();
  await deps.sleep(400);
  const exit1 = await deps.sendOnce(line);

  for (let i = 0; i < pollTries; i++) {
    if (!deps.holdsText(line)) {
      if (exit1 !== 0) {
        log('note: fm-send exited non-zero but composer CLEARED -> submit landed (false-negative)');
      }
      return { ok: true, fmExit: exit1, composerVerified: true, retried: false };
    }
    await deps.sleep(pollMs);
  }

  // Composer still holds our text -> genuinely not submitted. Clear and retry once.
  log('composer still holds the text -> clearing and retrying once');
  deps.clear();
  await deps.sleep(1200);
  const exit2 = await deps.sendOnce(line);
  for (let i = 0; i < pollTries; i++) {
    if (!deps.holdsText(line)) {
      return { ok: true, fmExit: exit2, composerVerified: true, retried: true };
    }
    await deps.sleep(pollMs);
  }
  throw new Error('text not submitted (composer still holds it after retry)');
}

// Real verified submit against the live tmux session.
export async function fmSend(
  line: string,
  { target = TARGET, log = noop }: { target?: string; log?: Log } = {},
): Promise<VerifiedSubmitResult> {
  return verifiedSubmit(line, {
    sendOnce: (l) => fmSendOnce(l, { target, log }),
    holdsText: (l) => composerHoldsText(l, target),
    clear: () => clearComposer(target),
    sleep,
    log,
  });
}
