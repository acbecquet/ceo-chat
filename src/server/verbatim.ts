// verbatim.ts - the LIVE 1:1 verbatim transcript source for the web UI.
//
// On a phone call the captain HEARS the Gemini-summarized narration; the web app
// is the only place to READ first mate's exact words (paths, options, code - the
// detail the summary compresses away). This module streams that exact text while
// the turn runs, using the SAME transcript-tap building blocks the broker's spoken
// path uses (latestTranscriptWithPrompt / findPromptAnchor / saysAfterAnchor -
// prompt-anchored, multi-session safe, rotation-following) but reading the RAW
// say blocks instead of speakable units.
//
// Canonical verbatim form: the exact `text` of each assistant say block after the
// prompt anchor, joined by ONE blank line ('\n\n' - say blocks are paragraphs).
// No whitespace normalization, no trimming inside blocks - the final read is
// byte-exact against the session transcript, and the validation harness proves it.
//
// The broker layer is untouched: this taps the same JSONL from the outside, and
// the pane target/cwd it needs are derived from the same exported session helpers
// the broker composes (fixed `ceo-chat:agent` in spawn mode, CEOCHAT_TARGET env in
// attach mode).

import { join } from 'node:path';

import {
  PROJECTS_DIR, mangleCwd, parseTranscript,
  latestTranscriptWithPrompt, findPromptAnchor, saysAfterAnchor,
} from '../transcript/transcript.ts';
import { resolveTargetFromEnv, paneCurrentPath, TARGET } from '../session/session.ts';

export interface VerbatimTurnOpts {
  /** The injected prompt line - the anchor into the session transcript. */
  prompt: string;
  /** ISO timestamp captured at injection; anchors only AT/AFTER this instant. */
  afterTs?: string;
  /** Called with the FULL verbatim text-so-far whenever it grows. */
  onText: (text: string) => void;
}

export interface VerbatimTurnHandle {
  /** Stop polling; one final read; returns the final verbatim text ('' if never anchored). */
  stop: () => string;
}

export type VerbatimTap = (opts: VerbatimTurnOpts) => VerbatimTurnHandle;

/** Join transcript events into the canonical byte-exact verbatim reply text. */
export function verbatimTextOf(events: ReturnType<typeof parseTranscript>, anchor: number): string {
  return saysAfterAnchor(events, anchor).map((e) => e.text).join('\n\n');
}

export interface TranscriptVerbatimOptions {
  /**
   * Resolve the Claude projects dir holding the session transcripts. Lazy - the
   * pane (and so its cwd) may not exist until the broker has started; the first
   * successful resolution is cached.
   */
  resolveProjectDir: () => string;
  pollMs?: number;
  log?: (msg: string) => void;
}

/** A VerbatimTap that polls the real session JSONL (the product wiring). */
export function makeTranscriptVerbatim(opts: TranscriptVerbatimOptions): VerbatimTap {
  const pollMs = opts.pollMs ?? 500;
  const log = opts.log ?? (() => {});
  let projectDir = '';

  const resolveDir = (): string => {
    if (projectDir) return projectDir;
    try { projectDir = opts.resolveProjectDir() || ''; } catch { projectDir = ''; }
    return projectDir;
  };

  return ({ prompt, afterTs, onText }) => {
    let last = '';
    const read = (): void => {
      const dir = resolveDir();
      if (!dir) return;
      try {
        // Re-resolve the anchored file EVERY poll (parseTranscript is mtime+size
        // cached) so a mid-turn /clear or compaction that re-records the prompt in
        // a fresh UUID file is followed forward, exactly like the spoken path.
        const path = latestTranscriptWithPrompt(dir, prompt, { afterTs });
        if (!path) return;
        const events = parseTranscript(path);
        const anchor = findPromptAnchor(events, prompt, { afterTs });
        if (anchor < 0) return;
        const text = verbatimTextOf(events, anchor);
        if (text && text !== last) {
          last = text;
          onText(text);
        }
      } catch (e) {
        log('verbatim poll failed: ' + (e as Error).message);
      }
    };
    const timer = setInterval(read, pollMs);
    timer.unref?.();
    read();
    return {
      stop: () => {
        clearInterval(timer);
        read(); // final read so the returned text includes the last appended say
        return last;
      },
    };
  };
}

/**
 * Derive the projects dir of the pane the broker drives, from the OUTSIDE, using
 * the same rules the broker applies: CEOCHAT_TARGET(/-SESSION/-WINDOW) env when
 * attached, else the fixed `ceo-chat:agent` spawn target; the pane's cwd mangles
 * into the transcript project dir. Empty string until the pane exists.
 */
export function resolveBrokerProjectDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const spec = resolveTargetFromEnv(env);
  const target = spec ? spec.target : TARGET;
  const cwd = paneCurrentPath(target);
  if (!cwd) return '';
  return join(PROJECTS_DIR, mangleCwd(cwd));
}
