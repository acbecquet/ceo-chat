// session.ts — drive a tmux first-mate pane: inject text via firstmate's own
// bin/fm-send.sh, mirror the pane, and read its transcript. This is the voice INPUT
// path (plan §2): STT text -> one verified fm-send.sh call -> the agent composer.
//
// Two pane-ownership modes:
//   - ATTACH (CEOCHAT_TARGET set): the broker attaches to an ALREADY-RUNNING first
//     mate the captain launched in tmux (same workspace/context as their real first
//     mate). We never kill it on teardown — we only detach.
//   - SPAWN (no target env): the broker owns a DEDICATED, throwaway `ceo-chat`
//     session in a temp cwd (the original self-contained demo path).
//
// SAFETY (task rules): the throwaway spawn is named `ceo-chat`, lives in a temp cwd,
// and is always killed on teardown; we refuse to spawn if a `ceo-chat` session
// exists. Either way we address panes via the explicit `session:window` escape hatch
// (which fm-send leaves unmarked) and never touch the captain's real sessions or any
// fm-<id> windows.

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
  /** true = we spawned it (teardown kills it); false = attached (leave it running). */
  owned: boolean;
}

export interface TargetSpec {
  session: string;
  window: string;
  /** The `session:window` (or bare `session`) string passed to tmux / fm-send. */
  target: string;
}

// Resolve the ATTACH target from env. Prefer a single `CEOCHAT_TARGET="session:window"`
// (or bare `session`); else compose `CEOCHAT_TARGET_SESSION` [+ `CEOCHAT_TARGET_WINDOW`].
// Returns null when nothing is set -> the broker falls back to SPAWN mode.
export function resolveTargetFromEnv(
  env: Record<string, string | undefined> = process.env,
): TargetSpec | null {
  const full = (env.CEOCHAT_TARGET || '').trim();
  if (full) {
    const i = full.indexOf(':');
    const session = i >= 0 ? full.slice(0, i) : full;
    const window = i >= 0 ? full.slice(i + 1) : '';
    return { session, window, target: window ? `${session}:${window}` : session };
  }
  const session = (env.CEOCHAT_TARGET_SESSION || '').trim();
  if (session) {
    const window = (env.CEOCHAT_TARGET_WINDOW || '').trim();
    return { session, window, target: window ? `${session}:${window}` : session };
  }
  return null;
}

// Resolve a CONCRETE window for a bare-session attach target (no window given). tmux
// would otherwise follow the session's ACTIVE window, so if the captain switches
// windows our inject/mirror/cwd would mis-target. We pin once at attach time: prefer
// the active window now, else the first window. Returns '' if the list can't be read.
export function resolveSessionWindow(session: string): string {
  let out: string;
  try {
    out = sh('tmux', ['list-windows', '-t', session, '-F', '#{window_index} #{window_active}']);
  } catch {
    return '';
  }
  const rows = out.split('\n').map((r) => r.trim()).filter(Boolean);
  if (!rows.length) return '';
  const active = rows.find((r) => /\s1$/.test(r));
  const chosen = active ?? rows[0]!;
  return chosen.split(/\s+/)[0] ?? '';
}

// The working directory a pane's foreground process runs in — used to locate the
// transcript project dir of an attached first mate (claude writes its JSONL under a
// dir mangled from this cwd). Empty string if the target can't be resolved.
export function paneCurrentPath(target: string): string {
  try {
    return sh('tmux', ['display-message', '-p', '-t', target, '-F', '#{pane_current_path}']).trim();
  } catch {
    return '';
  }
}

// Attach to an ALREADY-RUNNING first mate the captain launched in tmux. Validates the
// session/pane exists and derives its cwd (for the transcript tap). Does NOT spawn,
// does NOT accept any trust dialog, and is NEVER killed on teardown (owned: false).
export function attachTarget(spec: TargetSpec, { log = noop }: { log?: Log } = {}): SessionCtx {
  if (!sessionExists(spec.session)) {
    throw new Error(
      `target tmux session '${spec.session}' does not exist. Launch a first mate in tmux ` +
      `(npm run firstmate) and export CEOCHAT_TARGET=${spec.target}, or point CEOCHAT_TARGET ` +
      `at your already-running first mate's session:window.`,
    );
  }
  // Bare session (no window): pin a concrete window NOW so inject/mirror/cwd never
  // drift to whatever window the captain later makes active in that session.
  let target = spec.target;
  if (!spec.window) {
    const window = resolveSessionWindow(spec.session);
    if (window) {
      target = `${spec.session}:${window}`;
      log(`bare session '${spec.session}' -> pinned to window ${target}`);
    }
  }
  const cwd = paneCurrentPath(target);
  if (!cwd) {
    throw new Error(
      `could not resolve pane for target '${target}' — check the window name ` +
      `(tmux list-windows -t ${spec.session}).`,
    );
  }
  log(`attaching to existing first mate at ${target} (cwd ${cwd})`);
  return { cwd, session: spec.session, target, owned: false };
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
  return { cwd, session: SESSION, target: TARGET, owned: true };
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
