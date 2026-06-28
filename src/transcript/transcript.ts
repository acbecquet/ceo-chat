// transcript.ts — the clean tap into a Claude Code session transcript.
//
// PROVEN on hub (phase0 spike2 / FINDINGS): Claude Code writes one JSONL file per
// session under ~/.claude/projects/<cwd-mangled>/<session-uuid>.jsonl, appended
// line-by-line as the turn streams — so it is tail-able in near real time. Each
// line is a JSON object with a top-level `type`:
//   - "assistant": message.content[] of {type: thinking|text|tool_use, ...}
//   - "user":      message.content is EITHER a plain string (the human prompt) OR a
//                  list of {type:"tool_result", tool_use_id, content, is_error}.
//   - plus bookkeeping lines (mode, permission-mode, file-history-snapshot, ...).
//
// This module turns that raw stream into the clean event list the speakability
// layer wants (plan §2/§7), with the ANSI/TUI noise of capture-pane left behind.

import { readFileSync, existsSync, statSync, readdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');

export type TranscriptEvent =
  | { kind: 'say'; role: 'assistant'; ts: string | null; text: string }
  | { kind: 'thinking'; role: 'assistant'; ts: string | null; text: string }
  | { kind: 'tool_use'; role: 'assistant'; ts: string | null; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; role: 'tool'; ts: string | null; id: string; isError: boolean; text: string }
  | { kind: 'human'; role: 'user'; ts: string | null; text: string };

export interface NormalizeOpts {
  resultMax?: number;
}

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface RawLine {
  type?: string;
  timestamp?: string;
  message?: { content?: string | RawContentBlock[] };
}

// Map a working-directory path to the mangled project-dir name Claude Code uses
// (every "/" and "." becomes "-").
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

// Newest .jsonl transcript under a project dir (top level only — subagent
// transcripts live in a nested `subagents/` dir we intentionally skip).
export function latestTranscriptIn(projectDir: string): string | null {
  if (!existsSync(projectDir)) return null;
  const files = readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(projectDir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0]!.p : null;
}

// Newest transcript across ALL projects.
export function latestTranscriptAnywhere(base: string = PROJECTS_DIR): string | null {
  if (!existsSync(base)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const d of readdirSync(base)) {
    const dir = join(base, d);
    if (!statSync(dir).isDirectory()) continue;
    const t = latestTranscriptIn(dir);
    if (t) {
      const m = statSync(t).mtimeMs;
      if (!best || m > best.mtime) best = { path: t, mtime: m };
    }
  }
  return best ? best.path : null;
}

// tool_result.content is sometimes a string, sometimes a list of content blocks.
function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b as RawContentBlock)?.text ?? JSON.stringify(b)))
      .join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Normalize ONE raw JSONL object into zero or more clean events.
export function normalizeLine(obj: RawLine, opts: NormalizeOpts = {}): TranscriptEvent[] {
  const resultMax = opts.resultMax ?? 400;
  const ts = obj.timestamp || null;
  const events: TranscriptEvent[] = [];
  if (obj.type === 'assistant') {
    const content = (obj.message?.content as RawContentBlock[]) || [];
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) {
        events.push({ kind: 'say', role: 'assistant', ts, text: b.text });
      } else if (b.type === 'thinking' && b.thinking?.trim?.()) {
        events.push({ kind: 'thinking', role: 'assistant', ts, text: b.thinking });
      } else if (b.type === 'tool_use') {
        events.push({
          kind: 'tool_use', role: 'assistant', ts,
          id: b.id ?? '', name: b.name ?? '', input: b.input,
        });
      }
    }
  } else if (obj.type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) events.push({ kind: 'human', role: 'user', ts, text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const text = stringifyResult(b.content);
          events.push({
            kind: 'tool_result', role: 'tool', ts,
            id: b.tool_use_id ?? '', isError: !!b.is_error,
            text: text.length > resultMax ? text.slice(0, resultMax) + '…' : text,
          });
        } else if (b?.type === 'text' && b.text?.trim()) {
          events.push({ kind: 'human', role: 'user', ts, text: b.text });
        }
      }
    }
  }
  return events;
}

function parseLines(text: string, opts?: NormalizeOpts): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj: RawLine;
    try {
      obj = JSON.parse(line) as RawLine;
    } catch {
      continue; // partially-written trailing line; skip
    }
    events.push(...normalizeLine(obj, opts));
  }
  return events;
}

// Small mtime+size keyed cache for parseTranscript. The broker polls the SAME (often
// multi-MB) transcript every ~1s while streaming a reply, and latestTranscriptWithPrompt
// re-parses several recent files per poll — without a cache that re-parses unchanged
// files ~9x/poll for the whole turn. Keyed by path; invalidated when mtime/size moves
// (an append always bumps size). Bounded + LRU so rotated-away transcripts don't pile up.
interface ParseCacheEntry { mtimeMs: number; size: number; events: TranscriptEvent[]; }
const parseCache = new Map<string, ParseCacheEntry>();
const PARSE_CACHE_MAX = 16;

// Parse a whole transcript file into a flat, ordered event list. The returned array is
// shared with the cache (callers MUST treat it as read-only — findPromptAnchor /
// saysAfterAnchor only read).
export function parseTranscript(path: string, opts?: NormalizeOpts): TranscriptEvent[] {
  // A custom resultMax changes normalization, so only the default (the hot broker poll)
  // path is cached.
  const cacheable = !opts || opts.resultMax === undefined;
  if (cacheable) {
    let st: { mtimeMs: number; size: number } | null = null;
    try { st = statSync(path); } catch { st = null; }
    if (st) {
      const hit = parseCache.get(path);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        parseCache.delete(path); // re-insert to mark most-recently-used (LRU)
        parseCache.set(path, hit);
        return hit.events;
      }
      const events = parseLines(readFileSync(path, 'utf8'), opts);
      parseCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, events });
      while (parseCache.size > PARSE_CACHE_MAX) {
        const oldest = parseCache.keys().next().value;
        if (oldest === undefined) break;
        parseCache.delete(oldest);
      }
      return events;
    }
  }
  return parseLines(readFileSync(path, 'utf8'), opts);
}

// Normalize a line for robust matching of an injected prompt against a transcript
// human event (collapse whitespace, trim). fm-send types the line verbatim, but the
// composer/harness can reflow whitespace, so we compare on the collapsed form.
export function normalizeForMatch(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

export interface AnchorOpts {
  /**
   * ISO timestamp captured just before fm-send submitted OUR prompt. When given, only
   * human events at/after it are eligible and the FIRST such match is the anchor — so a
   * repeated/short confirmation prompt ("yes", "go ahead") can't anchor to an IDENTICAL
   * earlier turn's user line (which would re-speak the old reply). Omitted -> the legacy
   * "last matching human event" behavior (used by the pure unit tests).
   */
  afterTs?: string;
}

// A loose (substring) match is only safe for a target long enough to be unambiguous AND
// that makes up the bulk of the candidate line — otherwise a prior line that merely
// CONTAINS a short confirmation word ("yes please, go ahead and merge") would match the
// prompt "yes". Whitespace reflow is already handled by the exact (normalized) compare,
// so loose is a narrow fallback for the agent wrapping our line with a little extra text.
function looseMatches(got: string, target: string): boolean {
  return target.length >= 16 && got.includes(target) && target.length * 2 >= got.length;
}

// Find the index of the `human` event that recorded OUR injected prompt. This is the
// per-turn ANCHOR: the captain's first mate shares a project dir with OTHER concurrent
// claude sessions (the supervisor, crewmates), so "newest transcript by mtime" flip-flops
// between unrelated files. The file that recorded OUR injected line is unambiguously the
// right one — we anchor to it by content (+ the inject timestamp when given), not mtime.
// Returns -1 if the prompt is not present yet (claude writes the user turn lazily).
export function findPromptAnchor(
  events: TranscriptEvent[],
  injectedText: string,
  opts: AnchorOpts = {},
): number {
  const target = normalizeForMatch(injectedText);
  if (!target) return -1;
  const afterMs = opts.afterTs ? Date.parse(opts.afterTs) : NaN;
  const timed = !Number.isNaN(afterMs);
  let exact = -1;
  let loose = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind !== 'human') continue;
    if (timed) {
      // Anchor by time: only OUR turn's user line (written at/after the inject) is
      // eligible; an event without a parseable ts can't be proven ours, so skip it.
      const ets = e.ts ? Date.parse(e.ts) : NaN;
      if (Number.isNaN(ets) || ets < afterMs) continue;
    }
    const got = normalizeForMatch(e.text);
    if (got === target) {
      if (timed) return i; // first exact at/after the baseline IS our turn
      exact = i;           // legacy: the last exact match wins
    } else if (looseMatches(got, target)) {
      if (timed) { if (loose < 0) loose = i; } // first loose at/after the baseline
      else loose = i;                          // legacy: the last loose match
    }
  }
  return exact >= 0 ? exact : loose;
}

// The `say` events that belong to the turn anchored at `anchorIndex`: every assistant
// say AFTER the anchor up to the next `human` event (or end of file). Returns [] when
// anchorIndex < 0.
export function saysAfterAnchor(
  events: TranscriptEvent[],
  anchorIndex: number,
): Extract<TranscriptEvent, { kind: 'say' }>[] {
  if (anchorIndex < 0) return [];
  const out: Extract<TranscriptEvent, { kind: 'say' }>[] = [];
  for (let i = anchorIndex + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === 'human') break; // the next turn started — stop at our turn's boundary
    if (e.kind === 'say') out.push(e);
  }
  return out;
}

// Newest transcript under `projectDir` that contains the injected prompt as a human
// event — the robust replacement for latestTranscriptIn() when tapping an attached
// first mate. Scans .jsonl files newest-first (so a mid-turn /clear or compaction that
// re-records the prompt in a fresh UUID file is followed forward) and returns the first
// whose content anchors the prompt, or null if none does yet. `limit` caps how many
// recent files we parse per call (cheap, newest-first).
export function latestTranscriptWithPrompt(
  projectDir: string,
  injectedText: string,
  { limit = 8, afterTs }: { limit?: number; afterTs?: string } = {},
): string | null {
  if (!existsSync(projectDir)) return null;
  const files = readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(projectDir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  for (const { p } of files) {
    try {
      if (findPromptAnchor(parseTranscript(p), injectedText, { afterTs }) >= 0) return p;
    } catch { /* unreadable/partial — skip */ }
  }
  return null;
}

export interface TailOpts {
  startOffset?: number;
  opts?: NormalizeOpts;
  pollMs?: number;
}

// Near-real-time tail. Reads from `startOffset` bytes, then watches the file and
// emits normalized events for each newly-appended COMPLETE line. Returns a stop()
// function.
//
// BUG-FIX (regression-guarded): the byte cursor must advance by exactly what we
// CONSUMED, and a partial trailing line (writer mid-append) must be BUFFERED until
// its newline arrives — never parsed early and never re-read. Getting this wrong
// caused the "transcript tail cursor race" (dropped or duplicated turns). See
// test/legs.
export function tailTranscript(
  path: string,
  onEvent: (ev: TranscriptEvent) => void,
  { startOffset = 0, opts, pollMs = 250 }: TailOpts = {},
): () => void {
  let offset = startOffset;
  let buf = '';
  const pump = (): void => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = readFileSync(path);
    // Read ONLY the new bytes since our cursor — never re-scan consumed bytes.
    const chunk = fd.subarray(offset).toString('utf8');
    offset = fd.length;
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? ''; // keep trailing partial in the buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as RawLine;
        for (const ev of normalizeLine(obj, opts)) onEvent(ev);
      } catch {
        /* skip malformed */
      }
    }
  };
  pump();
  const watcher = watch(path, { persistent: true }, pump);
  // Also poll: fs.watch can miss appends on some filesystems / over NFS.
  const timer = setInterval(pump, pollMs);
  return () => {
    watcher.close();
    clearInterval(timer);
  };
}
