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

// Parse a whole transcript file into a flat, ordered event list.
export function parseTranscript(path: string, opts?: NormalizeOpts): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
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
