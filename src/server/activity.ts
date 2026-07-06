// activity.ts - REAL-ONLY mid-turn progress from the agent's tool activity (plan
// Feature 2, captain decision D2: never generic).
//
// On a phone call, when first mate works for minutes it emits tool calls (Bash,
// Read, Edit, ...) but no `say` text, so the spoken pipeline goes silent and the
// caller is left with nothing. The transcript tap already parses those `tool_use`
// events (transcript.ts) - this module turns the LATEST new one into a short,
// screen-safe spoken line ("Still on it. I just acquired the session lock.") so a
// progress update always reflects something the agent ACTUALLY did.
//
// D2 is strict: an update is spoken ONLY when there is new real activity. There is
// no generic "still working on it" fallback and no fixed cadence - if nothing new
// happened, the line stays silent. describeToolUse returns null for a tool call with
// nothing worth reporting; the phone leg de-dupes so the same statement is never
// spoken twice in a turn.
//
// The tap mirrors makeTranscriptVerbatim (verbatim.ts): same prompt-anchored,
// multi-session-safe, rotation-following read of the session JSONL, but surfacing
// tool_use instead of say-blocks. It only READS the transcript; it never writes, so
// progress audio never pollutes the transcript or gets fed back through STT.

import {
  parseTranscript, latestTranscriptWithPrompt, findPromptAnchor, toolUseAfterAnchor,
  type TranscriptEvent,
} from '../transcript/transcript.ts';

export interface ActivityTurnOpts {
  /** The injected prompt line - the anchor into the session transcript. */
  prompt: string;
  /** ISO timestamp captured at injection; anchors only AT/AFTER this instant. */
  afterTs?: string;
  /** Called with a rendered, screen-safe progress line for each NEW tool call. */
  onActivity: (line: string) => void;
}

export interface ActivityTurnHandle {
  /** Stop polling. */
  stop: () => void;
}

export type ActivityTap = (opts: ActivityTurnOpts) => ActivityTurnHandle;

// A field is NOT safe to speak if it looks like a path, URL, code, a file name, or a
// raw id/PID - §7.3 forbids reading those aloud. When a tool's descriptive field trips
// this, we fall back to the bare verb ("ran a command") rather than reading the token.
const UNSAFE = new RegExp(
  [
    '`',                                   // code span
    'https?://',                           // URL
    '[\\w~.-]*/[\\w~.-]+',                 // a path (slash between word chars)
    '\\b[\\w-]+\\.(?:ts|js|tsx|jsx|mjs|json|jsonl|md|sh|py|txt|html|css|yml|yaml|lock|wav|pcm|png|env)\\b', // filename.ext
    '\\d{4,}',                             // raw id / PID / long number
    '[{}<>|]',                             // code punctuation
  ].join('|'),
);

/** Is this free-text field safe to speak aloud (no paths/URLs/code/raw ids)? Pure. */
export function screenSafe(s: string): boolean {
  return !UNSAFE.test(s || '');
}

// Trim, collapse whitespace, drop trailing punctuation, and cap length so a spoken
// clause stays short. Returns '' for empty.
function clip(s: string, max = 90): string {
  const t = (s || '').replace(/\s+/g, ' ').trim().replace(/[.!?;:,\s]+$/, '');
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

// Short consonant-doubling verbs (CVC, stress on the last syllable) whose gerund doubles
// the final letter ('sync' stays out - it takes plain +ing, "syncing"). Anything else in
// KNOWN_VERBS takes the plain +ing / drop-e rules.
const DOUBLE_GERUND = new Set([
  'run', 'set', 'get', 'put', 'cut', 'stop', 'drop', 'plan', 'ship', 'commit', 'begin',
  'trim', 'tag', 'map', 'wrap', 'fit', 'spin', 'scan', 'log', 'swap', 'split',
]);

// Verbs we recognize as the leading word of an imperative label. Bash descriptions are
// imperative by harness convention, but TodoWrite/Agent/Skill content is free text - a
// leading non-verb ("Tests for the parser", "New validation leg") must NEVER be
// conjugated into gibberish ("testsing", "newing"); the caller falls back to the tool's
// bare form instead.
const KNOWN_VERBS = new Set([
  'add', 'acquire', 'analyze', 'apply', 'assert', 'audit', 'build', 'bump', 'check',
  'clean', 'clear', 'clone', 'close', 'collect', 'compare', 'compile', 'compute',
  'configure', 'confirm', 'connect', 'convert', 'copy', 'create', 'debug', 'delete',
  'deploy', 'diff', 'disable', 'dismiss', 'download', 'drain', 'draft', 'dump', 'edit',
  'enable', 'execute', 'expand', 'export', 'extract', 'fetch', 'fill', 'filter', 'find',
  'finish', 'fix', 'follow', 'format', 'gather', 'generate', 'grep', 'implement',
  'import', 'inspect', 'install', 'investigate', 'launch', 'lint', 'list', 'load',
  'look', 'make', 'measure', 'merge', 'migrate', 'monitor', 'move', 'open', 'parse',
  'patch', 'pin', 'poll', 'prepare', 'probe', 'process', 'prune', 'publish', 'pull',
  'push', 'read', 'rebase', 'rebuild', 'record', 'refactor', 'refresh', 'register',
  'release', 'reload', 'remove', 'rename', 'render', 'repair', 'replace', 'research',
  'reset', 'resolve', 'restart', 'restore', 'retry', 'revert', 'review', 'rewrite',
  'rotate', 'save', 'search', 'seed', 'send', 'serve', 'show', 'spawn', 'start',
  'stream', 'strip', 'submit', 'sweep', 'sync', 'tail', 'test', 'trace', 'track',
  'tune', 'update', 'upgrade', 'upload', 'validate', 'verify', 'wait', 'watch', 'wire',
  'write', ...DOUBLE_GERUND,
]);

/** Gerund of a single KNOWN verb ("Run"->"running", "Acquire"->"acquiring"), or null.
 *  A word that is not a recognized verb is never conjugated. A word already ending in
 *  -ing passes ONLY when its stem maps back to a known verb ("reading"->read, "acquiring"->acquire,
 *  "running"->run) - "Bring"/"Ongoing" end in -ing but are gerunds of nothing we know,
 *  so they return null instead of leaking wrong speech. Lowercase. */
export function verbGerund(word: string): string | null {
  const w = (word || '').toLowerCase();
  if (!/^[a-z]+$/.test(w) || w.length < 2) return null;
  if (KNOWN_VERBS.has(w)) {
    if (DOUBLE_GERUND.has(w)) return w + w[w.length - 1] + 'ing';
    if (w.endsWith('e') && !w.endsWith('ee')) return w.slice(0, -1) + 'ing';
    return w + 'ing';
  }
  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    if (KNOWN_VERBS.has(stem) || KNOWN_VERBS.has(stem + 'e')) return w;
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]
      && DOUBLE_GERUND.has(stem.slice(0, -1))) return w;
  }
  return null;
}

// Turn an imperative/active-voice label ("Run firstmate bootstrap", "Add parser tests")
// into a gerund clause ("running firstmate bootstrap", "adding parser tests") so it reads
// as something the AGENT is doing, not a command TO the listener. Returns null when the
// text isn't screen-safe or doesn't start with a clean verb (caller uses a bare fallback).
export function gerundClause(text: string): string | null {
  const t = clip(text);
  if (!t || !screenSafe(t)) return null;
  const m = t.match(/^([A-Za-z]+)(\s[\s\S]*)?$/);
  if (!m) return null;
  const g = verbGerund(m[1]!);
  if (!g) return null;
  return g + (m[2] ?? '');
}

// Pull the in-progress item's content out of a TodoWrite input - the single best
// "what am I doing right now" signal the agent emits.
function inProgressTodo(input: unknown): string | null {
  const todos = asRecord(input).todos;
  if (!Array.isArray(todos)) return null;
  for (const t of todos) {
    const r = asRecord(t);
    if (r.status === 'in_progress' && typeof r.content === 'string' && r.content.trim()) {
      return r.content.trim();
    }
  }
  return null;
}

/**
 * Turn ONE tool_use event into a short, screen-safe spoken progress line, or null if
 * there is nothing worth reporting. Deterministic and pure so the same event always
 * renders the same statement (the phone leg de-dupes on that, so a repeated activity is
 * never spoken twice). The line ALWAYS reflects real activity - Bash/Agent/Skill/Todo
 * descriptions when they are clean, otherwise the bare verb for the tool.
 */
export function describeToolUse(
  ev: Extract<TranscriptEvent, { kind: 'tool_use' }>,
): string | null {
  const name = ev.name || '';
  const input = ev.input;
  const lead = 'Still on it. ';
  switch (name) {
    case 'Bash': {
      const g = gerundClause(String(asRecord(input).description ?? ''));
      return g ? `${lead}I'm ${g}.` : `${lead}I just ran a command.`;
    }
    case 'Read':
      return `${lead}I'm reading through a file.`;
    case 'Edit':
    case 'MultiEdit':
      return `${lead}I'm making an edit.`;
    case 'Write':
      return `${lead}I'm writing a file.`;
    case 'NotebookEdit':
      return `${lead}I'm editing a notebook.`;
    case 'Grep':
    case 'Glob':
      return `${lead}I'm searching the code.`;
    case 'WebSearch':
    case 'WebFetch':
      return `${lead}I'm looking something up.`;
    case 'TodoWrite': {
      const g = gerundClause(inProgressTodo(input) ?? '');
      return g ? `${lead}I'm ${g}.` : `${lead}I'm working through the task list.`;
    }
    case 'Task':
    case 'Agent': {
      const g = gerundClause(String(asRecord(input).description ?? ''));
      return g ? `${lead}I'm ${g}.` : `${lead}I started a subtask.`;
    }
    case 'Skill': {
      const skill = clip(String(asRecord(input).skill ?? ''));
      return skill && screenSafe(skill) && /^[\w-]+$/.test(skill)
        ? `${lead}I'm running the ${skill} step.`
        : `${lead}I'm running a step.`;
    }
    // Internal bookkeeping tools (ToolSearch, TaskGet/List, EnterWorktree, ...) are not
    // worth narrating - stay silent rather than manufacture a generic line.
    default:
      return null;
  }
}

export interface TranscriptActivityOptions {
  /** Resolve the Claude projects dir holding the session transcripts (lazy, cached). */
  resolveProjectDir: () => string;
  pollMs?: number;
  log?: (msg: string) => void;
}

/** An ActivityTap that polls the real session JSONL (the product wiring). */
export function makeTranscriptActivity(opts: TranscriptActivityOptions): ActivityTap {
  const pollMs = opts.pollMs ?? 700;
  const log = opts.log ?? (() => {});
  let projectDir = '';

  const resolveDir = (): string => {
    if (projectDir) return projectDir;
    try { projectDir = opts.resolveProjectDir() || ''; } catch { projectDir = ''; }
    return projectDir;
  };

  return ({ prompt, afterTs, onActivity }) => {
    const seenIds = new Set<string>(); // process each tool call once (no reprocessing)
    const read = (): void => {
      const dir = resolveDir();
      if (!dir) return;
      try {
        const path = latestTranscriptWithPrompt(dir, prompt, { afterTs });
        if (!path) return;
        const events = parseTranscript(path);
        const anchor = findPromptAnchor(events, prompt, { afterTs });
        if (anchor < 0) return;
        const toolUses = toolUseAfterAnchor(events, anchor);
        for (let i = 0; i < toolUses.length; i++) {
          const tu = toolUses[i]!;
          const id = tu.id || `${tu.name}:${i}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const line = describeToolUse(tu);
          if (line) onActivity(line);
        }
      } catch (e) {
        log('activity poll failed: ' + (e as Error).message);
      }
    };
    const timer = setInterval(read, pollMs);
    timer.unref?.();
    read();
    return { stop: () => clearInterval(timer) };
  };
}
